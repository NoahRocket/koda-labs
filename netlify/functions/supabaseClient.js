const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_KEY } = process.env;

// Client for admin operations (uses service role key)
const getSupabaseAdmin = () => {
  const adminKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY; // Fallback for local dev if service key not set
  if (!SUPABASE_URL || !adminKey) {
    console.error('Missing Supabase URL or Service Role Key/Anon Key for admin client.');
    throw new Error('Server configuration error for admin client.');
  }
  return createClient(SUPABASE_URL, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    // No need to set global auth header here, direct key usage is sufficient for server-side
  });
};

// Client specifically for validating user JWTs (uses anon key)
const getSupabaseAuthClient = () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) { // Must use the anon key (SUPABASE_KEY)
    console.error('Missing Supabase URL or Anon Key for auth client.');
    throw new Error('Server configuration error for auth client.');
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
};

module.exports = { getSupabaseAdmin, getSupabaseAuthClient };
