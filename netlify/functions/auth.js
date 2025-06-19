const { getSupabaseAuthClient, releaseSupabaseConnections } = require('./supabaseClient');

// Simple in-memory request deduplication cache
const requestCache = {};
const CACHE_TTL = 1000; // 1 second cache TTL

// Track active connections to ensure proper cleanup
let activeConnections = 0;
const MAX_CONNECTIONS = 5; // Limit concurrent connections

// Helper to generate a cache key from request details
const getCacheKey = (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    return `${event.httpMethod}:${body.action}:${body.email || ''}:${!!body.refreshToken}`;
  } catch (e) {
    return null; // If we can't parse the body, don't use caching
  }
};

exports.handler = async (event, context) => {
  // Set a hard timeout for the entire function execution
  const GLOBAL_TIMEOUT = 10000; // 10 seconds max execution time
  let isTimedOut = false;
  const globalTimeoutPromise = new Promise(resolve => {
    setTimeout(() => {
      isTimedOut = true;
      console.log('[auth] Global timeout reached, terminating execution');
      resolve({ 
        statusCode: 504, 
        body: JSON.stringify({ error: 'Request timed out. Please try again.' }) 
      });
    }, GLOBAL_TIMEOUT);
  });

  // Execute the actual handler with a race against the timeout
  const actualHandlerPromise = (async () => {
    // Track request start time for diagnostics
    const startTime = Date.now();
    console.log('[auth] Handler invoked:', event.httpMethod);
    
    // Add detailed timing for local dev
    let lastStepTime = startTime;
    const logStepTime = (step) => {
      if (process.env.NETLIFY_DEV === 'true') {
        const now = Date.now();
        console.log(`[auth] Step ${step}: ${now - lastStepTime}ms since last step, ${now - startTime}ms total`);
        lastStepTime = now;
      }
    };
    logStepTime('Handler Start');
    
    // Set up context.callbackWaitsForEmptyEventLoop = false to prevent the function from waiting
    if (context && typeof context.callbackWaitsForEmptyEventLoop !== 'undefined') {
      // This is critical for preventing Lambda from waiting for connections to close
      context.callbackWaitsForEmptyEventLoop = false;
      console.log('[auth] Set callbackWaitsForEmptyEventLoop = false');
      logStepTime('CallbackWaitsForEmptyEventLoop Set');
    }
    
    // Determine if running in netlify dev for local development
    const isLocalDev = process.env.NETLIFY_DEV === 'true';
    
    // Adjust timeout for local development
    const TIMEOUT = isLocalDev ? 15000 : 5000; // 15 seconds for local dev, 5 for production
    
    // Check if we have too many active connections
    if (activeConnections >= MAX_CONNECTIONS) {
      console.log(`[auth] Too many active connections: ${activeConnections}/${MAX_CONNECTIONS}`);
      return {
        statusCode: 503,
        body: JSON.stringify({ error: 'Service temporarily unavailable due to high load. Please try again.' })
      };
    }
    
    // Track this connection
    activeConnections++;
    console.log(`[auth] Active connections: ${activeConnections}`);
    
    // Check for request deduplication if running locally
    if (isLocalDev) {
      const cacheKey = getCacheKey(event);
      if (cacheKey && requestCache[cacheKey]) {
        const cachedResponse = requestCache[cacheKey];
        if (Date.now() - cachedResponse.timestamp < CACHE_TTL) {
          console.log(`Using cached auth response for ${cacheKey}, age: ${Date.now() - cachedResponse.timestamp}ms`);
          logStepTime('Cache Hit');
          activeConnections--; // Release connection count for cached responses
          console.log(`[auth] Released connection (cached). Remaining: ${activeConnections}`);
          return cachedResponse.response;
        }
      }
      logStepTime('Cache Check');
    }
    
    const supabase = getSupabaseAuthClient();
    logStepTime('Supabase Client Initialized');

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { action, email, password } = JSON.parse(event.body || '{}');

    try {
      // Create a promise race between the operation and a timeout
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
          console.log('[auth] Supabase operation timeout reached');
          resolve({ data: null, error: { message: 'Supabase operation timed out' } });
        }, 5000); // Reduce to 5 seconds for faster feedback in local dev
      });
      logStepTime('Timeout Promise Set');
      
      if (action === 'signup') {
        logStepTime('Before Supabase Call');
        const signupPromise = supabase.auth.signUp({ email, password });
        logStepTime('After Supabase Call');
        logStepTime('Signup Promise Created');
        const { data, error } = await Promise.race([signupPromise, timeoutPromise]);
        logStepTime('Signup Promise Resolved');
        if (error) throw error;
        
        // Cache successful response in local development
        const response = { statusCode: 200, body: JSON.stringify({ user: data.user, session: data.session }) };
        if (isLocalDev) {
          const cacheKey = getCacheKey(event);
          if (cacheKey) {
            requestCache[cacheKey] = {
              timestamp: Date.now(),
              response
            };
            console.log(`[auth] Cached response for key: ${cacheKey}`);
          }
        }
        
        // Decrement active connections before returning
        activeConnections--;
        console.log(`[auth] Released connection. Remaining: ${activeConnections}`);
        return response;
      } else if (action === 'login') {
        logStepTime('Before Supabase Call');
        const loginPromise = supabase.auth.signInWithPassword({ email, password });
        logStepTime('After Supabase Call');
        logStepTime('Login Promise Created');
        const { data, error } = await Promise.race([loginPromise, timeoutPromise]);
        logStepTime('Login Promise Resolved');
        if (error) throw error;
        
        // Cache successful response in local development
        const response = { statusCode: 200, body: JSON.stringify({ user: data.user, session: data.session }) };
        if (isLocalDev) {
          const cacheKey = getCacheKey(event);
          if (cacheKey) {
            requestCache[cacheKey] = {
              timestamp: Date.now(),
              response
            };
            console.log(`[auth] Cached response for key: ${cacheKey}`);
          }
        }
        
        // Decrement active connections before returning
        activeConnections--;
        console.log(`[auth] Released connection. Remaining: ${activeConnections}`);
        return response;
      } else if (action === 'refresh') {
        const { refreshToken } = JSON.parse(event.body || '{}');
        logStepTime('Before Supabase Call');
        const refreshPromise = supabase.auth.refreshSession({ refresh_token: refreshToken });
        logStepTime('After Supabase Call');
        logStepTime('Refresh Promise Created');
        const { data, error } = await Promise.race([refreshPromise, timeoutPromise]);
        logStepTime('Refresh Promise Resolved');
        if (error) throw error;
        
        // Cache successful response in local development
        const response = { statusCode: 200, body: JSON.stringify({ session: data.session, user: data.user }) };
        if (isLocalDev) {
          const cacheKey = getCacheKey(event);
          if (cacheKey) {
            requestCache[cacheKey] = {
              timestamp: Date.now(),
              response
            };
            
            // Clean up cache entry after TTL
            setTimeout(() => {
              delete requestCache[cacheKey];
            }, CACHE_TTL * 2);
          }
        }
        
        // Decrement active connections before returning
        activeConnections--;
        console.log(`[auth] Released connection. Remaining: ${activeConnections}`);
        return response;
      } else if (action === 'verify') {
        logStepTime('Before Token Verification');
        // Extract token from header
        const headers = Object.fromEntries(
          Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value])
        );
        const accessToken = headers['authorization']?.startsWith('Bearer ') ? headers['authorization'].split(' ')[1] : null;
        
        if (!accessToken) {
          activeConnections--; // Decrement connections even on error path
          console.log(`[auth] Released connection (no token). Remaining: ${activeConnections}`);
          return { statusCode: 401, body: JSON.stringify({ error: 'No access token provided for verification' }) };
        }
        logStepTime('After Token Verification');
        logStepTime('Before Supabase Call');
        const getUserPromise = supabase.auth.getUser(accessToken);
        logStepTime('After Supabase Call');
        logStepTime('GetUser Promise Created');
        const { data: { user }, error } = await Promise.race([getUserPromise, timeoutPromise]);
        logStepTime('GetUser Promise Resolved');
        
        if (error) {
          activeConnections--; // Decrement connections even on error path
          console.log(`[auth] Released connection (token error). Remaining: ${activeConnections}`);
          return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token for verification' }) };
        }
        
        // Cache successful response in local development
        const response = { statusCode: 200, body: JSON.stringify({ user }) };
        if (isLocalDev) {
          const cacheKey = getCacheKey(event);
          if (cacheKey) {
            requestCache[cacheKey] = {
              timestamp: Date.now(),
              response
            };
            
            // Clean up cache entry after TTL
            setTimeout(() => {
              delete requestCache[cacheKey];
            }, CACHE_TTL * 2);
          }
        }
        
        // Decrement active connections before returning
        activeConnections--;
        console.log(`[auth] Released connection. Remaining: ${activeConnections}`);
        return response;
      } else {
        activeConnections--; // Decrement connections on invalid action
        console.log(`[auth] Released connection (invalid action). Remaining: ${activeConnections}`);
        return { statusCode: 400, body: 'Invalid action' };
      }
    } catch (error) {
      // Only log critical errors but keep it minimal
      console.error('Auth error:', error.name, error.message);
      logStepTime('Error Caught');
      
      // Always release connection on error
      activeConnections--;
      console.log(`[auth] Released connection (error). Remaining: ${activeConnections}`);
      
      return { 
        statusCode: error.message === 'Request timed out' ? 504 : 400, 
        body: JSON.stringify({ error: error.message }) 
      };
    } finally {
      // Explicitly clean up resources
      try {
        releaseSupabaseConnections();
        logStepTime('Connections Released');
      } catch (e) {
        console.error('[auth] Error releasing connections:', e.message);
      }
      
      // Log execution time for diagnostics
      const executionTime = Date.now() - startTime;
      console.log(`[auth] Handler completed in ${executionTime}ms`);
      
      // Clean up any old cache entries to prevent memory leaks
      if (process.env.NETLIFY_DEV === 'true') {
        const now = Date.now();
        Object.keys(requestCache).forEach(key => {
          if (now - requestCache[key].timestamp > CACHE_TTL * 2) {
            delete requestCache[key];
          }
        });
      }
    }
    
    console.log('[auth] Handler completed in', Date.now() - startTime, 'ms');
    return { statusCode: 500, body: JSON.stringify({ error: 'Unhandled case in auth handler' }) };
  })();
  
  // Race between the actual handler and the global timeout
  return Promise.race([actualHandlerPromise, globalTimeoutPromise]);
};
