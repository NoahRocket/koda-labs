const { getSupabaseAuthClient } = require('./supabaseClient');

exports.handler = async (event, context) => {
  // Minimal logging to reduce overhead
  console.log('Auth handler invoked:', event.httpMethod);
  
  // Add timeout handling for Supabase operations
  const TIMEOUT = 5000; // 5 seconds timeout
  
  const supabase = getSupabaseAuthClient();

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { action, email, password } = JSON.parse(event.body || '{}');

  try {
    // Create a promise race between the operation and a timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timed out')), TIMEOUT)
    );
    
    if (action === 'signup') {
      const signupPromise = supabase.auth.signUp({ email, password });
      const { data, error } = await Promise.race([signupPromise, timeoutPromise]);
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ user: data.user, session: data.session }) };
    } else if (action === 'login') {
      const loginPromise = supabase.auth.signInWithPassword({ email, password });
      const { data, error } = await Promise.race([loginPromise, timeoutPromise]);
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ user: data.user, session: data.session }) };
    } else if (action === 'refresh') {
      const { refreshToken } = JSON.parse(event.body || '{}');
      const refreshPromise = supabase.auth.refreshSession({ refresh_token: refreshToken });
      const { data, error } = await Promise.race([refreshPromise, timeoutPromise]);
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ session: data.session, user: data.user }) };
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
      const { data: { user }, error } = await Promise.race([getUserPromise, timeoutPromise]);
      
      if (error) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token for verification' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ user }) };
    } else {
      return { statusCode: 400, body: 'Invalid action' };
    }
  } catch (error) {
    // Only log critical errors but keep it minimal
    console.error('Auth error:', error.name, error.message);
    return { 
      statusCode: error.message === 'Request timed out' ? 504 : 400, 
      body: JSON.stringify({ error: error.message }) 
    };
  }
};
