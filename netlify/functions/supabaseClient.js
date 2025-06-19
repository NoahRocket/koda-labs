const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_KEY } = process.env;
const { createClient } = require('@supabase/supabase-js');

const PDF_BUCKET_NAME = 'pdfs'; // Define the bucket name

// Custom fetch with timeout for Supabase
const fetchWithTimeout = (timeout = 5000) => {
  return async (url, options) => {
    // Check if running in local development via netlify dev
    const isLocalDev = process.env.NETLIFY_DEV === 'true';
    
    // Record start time for diagnostics
    const startTime = Date.now();
    const isAuthEndpoint = url.includes('/auth/');
    
    // Use longer timeout for local development to handle cold starts
    const effectiveTimeout = isLocalDev ? Math.max(timeout, 10000) : timeout;
    
    if (isLocalDev && isAuthEndpoint) {
      console.log(`[supabaseClient] Starting ${options.method || 'GET'} request to ${url} with timeout ${effectiveTimeout}ms`);
    }
    
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
const getSupabaseAdmin = () => {
  const adminKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY; // Fallback for local dev if service key not set
  if (!SUPABASE_URL || !adminKey) {
    console.error('Missing Supabase URL or Service Role Key/Anon Key for admin client.');
    throw new Error('Server configuration error for admin client.');
  }
  return createClient(SUPABASE_URL, adminKey, {
    auth: { 
      persistSession: false, 
      autoRefreshToken: false
    },
    global: {
      fetch: fetchWithTimeout(8000), // 8 second timeout for admin operations
    },
    db: {
      schema: 'public'
    }
  });
};

// Client specifically for validating user JWTs (uses anon key)
let authClientInstance = null;
const getSupabaseAuthClient = () => {
  // For local development, reuse the client instance to avoid creating too many connections
  const isLocalDev = process.env.NETLIFY_DEV === 'true';
  
  if (isLocalDev && authClientInstance) {
    console.log('[supabaseClient] Reusing existing auth client instance');
    return authClientInstance;
  }
  
  if (!SUPABASE_URL || !SUPABASE_KEY) { // Must use the anon key (SUPABASE_KEY)
    console.error('[supabaseClient] Missing Supabase URL or Anon Key for auth client.');
    throw new Error('Server configuration error for auth client.');
  }
  
  // Adjust timeout for local development
  const authTimeout = isLocalDev ? 30000 : 5000; // 30 seconds for local dev, 5 seconds for production
  
  // Limited connection pool size for local development
  // For Netlify Functions which are stateless, we want minimal pooling
  const dbPoolSize = isLocalDev ? { min: 1, max: 3 } : { min: 0, max: 1 };
  
  console.log(`[supabaseClient] Creating new auth client with timeout: ${authTimeout}ms`);
  
  // Create client with optimized settings
  authClientInstance = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { 
      persistSession: false, 
      autoRefreshToken: false,
      detectSessionInUrl: false, // Disable auto URL detection which can cause delays
      flowType: 'pkce' // More reliable auth flow
    },
    global: {
      fetch: fetchWithTimeout(authTimeout),
      headers: { 
        // Add headers identifying the client
        'x-client-info': 'supabase-js-netlify-function'
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
  
  return authClientInstance;
};

// Add cleanup function to manually release connections
const releaseSupabaseConnections = () => {
  if (authClientInstance) {
    console.log('[supabaseClient] Releasing Supabase auth client connections');
    // No direct pool.end() available in supabase-js, but we can remove the reference
    authClientInstance = null;
  }
};

module.exports = { 
  getSupabaseAdmin, 
  getSupabaseAuthClient,
  releaseSupabaseConnections,
  PDF_BUCKET_NAME // Export the bucket name
};
