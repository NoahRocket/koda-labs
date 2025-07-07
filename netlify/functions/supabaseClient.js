const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_KEY } = process.env;
const { createClient } = require('@supabase/supabase-js');

// Custom fetch with timeout for Supabase
const fetchWithTimeout = (timeout = 5000) => {
  return async (url, options) => {
    // Check if running in local development via netlify dev
    const isLocalDev = process.env.NETLIFY_DEV === 'true';
    
    // Record start time for diagnostics
    const startTime = Date.now();
    const isAuthEndpoint = url.includes('/auth/');
    
    // Use shorter timeout for local development to fail faster
    const effectiveTimeout = isLocalDev ? Math.min(timeout, 5000) : timeout;
    
    console.log(`[supabaseClient] Starting ${options.method || 'GET'} request to ${url} with timeout ${effectiveTimeout}ms`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      console.warn(`[supabaseClient] Request to ${url} timed out after ${effectiveTimeout}ms`);
    }, effectiveTimeout);
    
    // Add signal to options, preserving any existing signal
    const originalSignal = options.signal;
    options.signal = controller.signal;
    
    // Force connection close in local dev to prevent lingering sockets that keep
    // Netlify's dev function alive for ~5 minutes after the handler finishes.
    if (isLocalDev) {
      options.headers = options.headers || {};
      options.headers['Connection'] = 'close';
    }
    
    try {
      const response = await fetch(url, options);
      clearTimeout(timeoutId);
      
      // Log timing for auth-related requests
      if (isLocalDev && isAuthEndpoint) {
        const duration = Date.now() - startTime;
        console.log(`[supabaseClient] ${options.method || 'GET'} request to ${url} completed in ${duration}ms with status ${response.status}`);
      }
      
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      // Improve error logging
      if (error.name === 'AbortError') {
        console.error(`[supabaseClient] Request to ${url} aborted after ${effectiveTimeout}ms timeout`);
      } else {
        console.error(`[supabaseClient] Error with request to ${url}: ${error.message}`);
      }
      throw error;
    }
  };
};

// Client for admin operations (uses service role key)
let lastServiceRoleClientCreation = 0;
const SERVICE_CLIENT_TTL = 15000; // 15 second TTL for service role client

const getSupabaseAdmin = () => {
  const isLocalDev = process.env.NETLIFY_DEV === 'true';
  const currentTime = Date.now();
  
  // For local development only, use a TTL-based client reuse strategy
  if (isLocalDev && serviceRoleClientInstance && (currentTime - lastServiceRoleClientCreation) < SERVICE_CLIENT_TTL) {
    console.log('[supabaseClient] Reusing existing service role client instance');
    return serviceRoleClientInstance;
  } else if (isLocalDev && serviceRoleClientInstance) {
    console.log('[supabaseClient] Service role client TTL expired, creating new instance');
    // Force cleanup of old connection
    try {
      serviceRoleClientInstance = null;
    } catch (e) {
      console.log('[supabaseClient] Error cleaning up old service role client:', e.message);
    }
  }
  
  const adminKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY; // Fallback for local dev if service key not set
  if (!SUPABASE_URL || !adminKey) {
    console.error('[supabaseClient] Missing Supabase URL or Service Role Key/Anon Key for admin client.');
    throw new Error('Server configuration error for admin client.');
  }
  
  // Use aggressive timeouts for local development
  const adminTimeout = isLocalDev ? 5000 : 8000; // 5s for local dev, 8s for prod
  console.log(`[supabaseClient] Creating new service role client with timeout: ${adminTimeout}ms`);
  
  // Minimal connection pooling
  const dbPoolSize = { min: 0, max: 1 }; // Use minimal pooling everywhere
  
  // Create and store new client instance
  serviceRoleClientInstance = createClient(SUPABASE_URL, adminKey, {
    auth: { 
      persistSession: false, 
      autoRefreshToken: false
    },
    global: {
      fetch: fetchWithTimeout(adminTimeout),
    },
    db: {
      schema: 'public',
      poolSize: dbPoolSize
    }
  });
  
  lastServiceRoleClientCreation = currentTime;
  return serviceRoleClientInstance;
};

// Client specifically for validating user JWTs (uses anon key)             
let authClientInstance = null;
let serviceRoleClientInstance = null;
let lastAuthClientCreation = 0;
const AUTH_CLIENT_TTL = 10000; // 10 second TTL for auth client - shorter to ensure fresh validation

const getSupabaseAuthClient = () => {
  const isLocalDev = process.env.NETLIFY_DEV === 'true';
  const currentTime = Date.now();
  
  // Use TTL-based client reuse strategy with careful connection management
  if (authClientInstance && (currentTime - lastAuthClientCreation) < AUTH_CLIENT_TTL) {
    console.log('[supabaseClient] Reusing existing auth client instance');
    return authClientInstance;
  } else if (authClientInstance) {
    console.log('[supabaseClient] Auth client TTL expired, creating new instance');
    // Force cleanup of old connection
    try {
      // Always release the connection when we're done with it
      authClientInstance.auth.signOut().catch((e) => {
        console.log('[supabaseClient] Silent error during auth client signOut:', e.message);
      });
      
      if (authClientInstance.rest && authClientInstance.rest.headers) {
        authClientInstance.rest.headers['Connection'] = 'close';
      }
      
      // Set to null to allow garbage collection
      authClientInstance = null;
    } catch (e) {
      console.log('[supabaseClient] Error cleaning up old auth client:', e.message);
    }
  }
  
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[supabaseClient] Missing Supabase URL or Anon Key for auth client.');
    throw new Error('Server configuration error for auth client.');
  }
  
  // Use appropriate timeouts - short for local dev to surface issues quickly
  const authTimeout = isLocalDev ? 5000 : 8000; // 5s for local dev, 8s for production
  
  // Minimal connection pooling
  const dbPoolSize = { min: 0, max: 1 }; // Use minimal pooling
  
  console.log(`[supabaseClient] Creating new auth client with timeout: ${authTimeout}ms`);
  
  // Create client with optimized settings for token validation
  authClientInstance = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { 
      persistSession: false, 
      autoRefreshToken: false,
      detectSessionInUrl: false, // Disable auto URL detection which can cause delays
      flowType: 'pkce', // More reliable auth flow
      storageKey: `sb-auth-token-${Date.now()}` // Ensure unique storage key per instance
    },
    global: {
      fetch: fetchWithTimeout(authTimeout),
      headers: { 
        // Add headers identifying the client
        'x-client-info': 'supabase-js-netlify-function',
        'Connection': isLocalDev ? 'close' : 'keep-alive' // Force connection close in dev mode
      }
    },
    realtime: {
      enabled: false // Disable realtime subscriptions for auth client
    },
    db: {
      schema: 'public',
      poolSize: dbPoolSize
    }
  });
  
  // Record creation time
  lastAuthClientCreation = currentTime;
  
  return authClientInstance;
};

// Add cleanup function to manually release connections
const releaseSupabaseConnections = () => {
  // Track when this function was called
  const cleanupStartTime = Date.now();
  console.log('[supabaseClient] Starting connection cleanup');

  // Handle auth client
  if (authClientInstance) {
    console.log('[supabaseClient] Releasing Supabase auth client connections');
    try {
      // Try to explicitly sign out to close the connection
      if (authClientInstance.auth) {
        authClientInstance.auth.signOut().catch((e) => {
          console.log('[supabaseClient] Silent error during auth client signOut:', e.message);
        });
      }
      // Force connection close header if possible
      if (authClientInstance.rest && authClientInstance.rest.headers) {
        authClientInstance.rest.headers['Connection'] = 'close';
      }
      
      // Add additional cleanup to help with connection release
      if (authClientInstance.auth && authClientInstance.auth.session) {
        try {
          authClientInstance.auth.session = null;
        } catch (e) {
          console.log('[supabaseClient] Error clearing auth session:', e.message);
        }
      }
      
      // Remove the reference
      authClientInstance = null;
      lastAuthClientCreation = 0;
    } catch (e) {
      console.log('[supabaseClient] Error releasing auth client:', e.message);
    }
  }

  // Handle service role client if present
  if (serviceRoleClientInstance) {
    console.log('[supabaseClient] Releasing Supabase service role client connections');
    try {
      // If service role has auth, try to sign out
      if (serviceRoleClientInstance.auth) {
        serviceRoleClientInstance.auth.signOut().catch((e) => {
          console.log('[supabaseClient] Silent error during service role client signOut:', e.message);
        });
      }
      
      // Force connection close header if possible
      if (serviceRoleClientInstance.rest && serviceRoleClientInstance.rest.headers) {
        serviceRoleClientInstance.rest.headers['Connection'] = 'close';
      }
      
      // Remove the reference
      serviceRoleClientInstance = null;
      // Reset the timestamp if the variable is accessible in this scope
      if (typeof lastServiceRoleClientCreation !== 'undefined') {
        lastServiceRoleClientCreation = 0;
      }
    } catch (e) {
      console.log('[supabaseClient] Error releasing service role client:', e.message);
    }
  }

  // Suggest garbage collection (only has an effect in certain JavaScript engines)
  try {
    if (global.gc) {
      global.gc();
    }
  } catch (e) {
    // Ignore errors - gc() might not be available
  }

  // Log the cleanup duration
  console.log(`[supabaseClient] Connection cleanup completed in ${Date.now() - cleanupStartTime}ms`);
};

module.exports = { 
  getSupabaseAdmin, 
  getSupabaseAuthClient,
  releaseSupabaseConnections
};
