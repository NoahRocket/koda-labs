const { getSupabaseAuthClient } = require('./supabaseClient');

exports.handler = async (event, context) => {
  const supabase = getSupabaseAuthClient();

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { action, email, password } = JSON.parse(event.body || '{}');

  try {
    if (action === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ user: data.user, session: data.session }) };
    } else if (action === 'login') {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ user: data.user, session: data.session }) };
    } else if (action === 'refresh') {
      const { refreshToken } = JSON.parse(event.body || '{}');
      const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
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
      // Use the supabase client (already initialized as getSupabaseAuthClient())
      const { data: { user }, error } = await supabase.auth.getUser(accessToken); 
      
      if (error) {
        // Log the error for server-side debugging if needed
        // console.error('Token verification error:', error.message);
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token for verification' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ user }) };
    } else {
      return { statusCode: 400, body: 'Invalid action' };
    }
  } catch (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }
};
