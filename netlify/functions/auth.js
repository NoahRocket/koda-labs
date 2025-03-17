const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const supabaseUrl = process.env.SUPABASE_URL; // Hidden in Netlify env vars
  const supabaseKey = process.env.SUPABASE_KEY; // Hidden in Netlify env vars
  const supabase = createClient(supabaseUrl, supabaseKey);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { action, email, password } = JSON.parse(event.body);

  try {
    if (action === 'signup') {
      const { user, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ user }) };
    } else if (action === 'login') {
      const { user, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ user }) };
    } else {
      return { statusCode: 400, body: 'Invalid action' };
    }
  } catch (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }
};
