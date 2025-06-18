const { getSupabaseAuthClient, releaseSupabaseConnections } = require('./supabaseClient');

// Simple in-memory request deduplication cache
const requestCache = {};
const CACHE_TTL = 1000; // 1 second cache TTL

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
  
  // Check for request deduplication if running locally
  if (isLocalDev) {
    const cacheKey = getCacheKey(event);
    if (cacheKey && requestCache[cacheKey]) {
      const cachedResponse = requestCache[cacheKey];
      if (Date.now() - cachedResponse.timestamp < CACHE_TTL) {
        console.log(`Using cached auth response for ${cacheKey}, age: ${Date.now() - cachedResponse.timestamp}ms`);
        logStepTime('Cache Hit');
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
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timed out')), TIMEOUT)
    );
    logStepTime('Timeout Promise Set');
    
    if (action === 'signup') {
      const signupPromise = supabase.auth.signUp({ email, password });
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
      
      return response;
    } else if (action === 'login') {
      const loginPromise = supabase.auth.signInWithPassword({ email, password });
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
      
      return response;
    } else if (action === 'refresh') {
      const { refreshToken } = JSON.parse(event.body || '{}');
      const refreshPromise = supabase.auth.refreshSession({ refresh_token: refreshToken });
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
      
      return response;
    } else if (action === 'verify') {
      // Extract token from header
      const headers = Object.fromEntries(
        Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value])
      );
      const authHeader = headers['authorization'];
      const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

      if (!accessToken) {
        return { statusCode: 401, body: JSON.stringify({ error: 'No access token provided for verification' }) };
      }
      // Use the supabase client with timeout
      const getUserPromise = supabase.auth.getUser(accessToken);
      logStepTime('GetUser Promise Created');
      const { data: { user }, error } = await Promise.race([getUserPromise, timeoutPromise]);
      logStepTime('GetUser Promise Resolved');
      
      if (error) {
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
      
      return response;
    } else {
      return { statusCode: 400, body: 'Invalid action' };
    }
  } catch (error) {
    // Only log critical errors but keep it minimal
    console.error('Auth error:', error.name, error.message);
    logStepTime('Error Caught');
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
};
