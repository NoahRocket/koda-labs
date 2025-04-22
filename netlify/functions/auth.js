const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

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
      const { data: { user } } = await supabase.auth.getUser();
      return { statusCode: 200, body: JSON.stringify({ user }) };
    } else {
      return { statusCode: 400, body: 'Invalid action' };
    }
  } catch (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }
};
