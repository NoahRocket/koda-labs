const { getSupabaseAuthClient } = require('./supabaseClient');

exports.handler = async (event, context) => {
  console.log('Auth handler invoked with event:', event.httpMethod, event.path);
  const supabase = getSupabaseAuthClient();
  console.log('Supabase client initialized');

  if (event.httpMethod !== 'POST') {
    console.log('Method not allowed:', event.httpMethod);
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { action, email, password } = JSON.parse(event.body || '{}');
  console.log('Parsed request body with action:', action);

  try {
    if (action === 'signup') {
      console.log('Starting signup process for email:', email);
      const { data, error } = await supabase.auth.signUp({ email, password });
      console.log('Signup process completed, error:', error);
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ user: data.user, session: data.session }) };
    } else if (action === 'login') {
      console.log('Starting login process for email:', email);
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      console.log('Login process completed, error:', error);
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ user: data.user, session: data.session }) };
    } else if (action === 'refresh') {
      console.log('Starting token refresh process');
      const { refreshToken } = JSON.parse(event.body || '{}');
      const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
      console.log('Token refresh completed, error:', error);
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ session: data.session, user: data.user }) };
    } else if (action === 'verify') {
      console.log('Starting token verification process');
      // Extract token from header
      const headers = Object.fromEntries(
        Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value])
      );
      const authHeader = headers['authorization'];
      const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

      if (!accessToken) {
        console.log('No access token provided for verification');
        return { statusCode: 401, body: JSON.stringify({ error: 'No access token provided for verification' }) };
      }
      // Use the supabase client (already initialized as getSupabaseAuthClient())
      console.log('Attempting to get user with access token');
      const { data: { user }, error } = await supabase.auth.getUser(accessToken); 
      console.log('User retrieval completed, error:', error);
      
      if (error) {
        // Log the error for server-side debugging if needed
        console.error('Token verification error:', error.message);
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token for verification' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ user }) };
    } else {
      console.log('Invalid action received:', action);
      return { statusCode: 400, body: 'Invalid action' };
    }
  } catch (error) {
    console.error('Error in auth handler:', error.message);
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }
};
