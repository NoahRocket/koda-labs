const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_KEY } = process.env;
const { createClient } = require('@supabase/supabase-js');

// Custom fetch with timeout for Supabase
const fetchWithTimeout = (timeout = 5000) => {
  return async (url, options) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    options.signal = controller.signal;
    
    try {
      const response = await fetch(url, options);
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
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
const getSupabaseAuthClient = () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) { // Must use the anon key (SUPABASE_KEY)
    console.error('Missing Supabase URL or Anon Key for auth client.');
    throw new Error('Server configuration error for auth client.');
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { 
      persistSession: false, 
      autoRefreshToken: false,
      detectSessionInUrl: false // Disable auto URL detection which can cause delays
    },
    global: {
      fetch: fetchWithTimeout(5000), // 5 second timeout for auth operations
    },
    realtime: {
      enabled: false // Disable realtime subscriptions for auth client
    },
    db: {
      schema: 'public'
    }
  });
};

module.exports = { getSupabaseAdmin, getSupabaseAuthClient };
