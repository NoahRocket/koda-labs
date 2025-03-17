const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { userId } = JSON.parse(event.body || '{}');
  if (!userId) return { statusCode: 400, body: 'Missing user ID' };

  try {
    const { data: topics } = await supabase.from('topics').select('*').eq('user_id', userId);
    const { data: bookmarks } = await supabase.from('bookmarks').select('*');
    return {
      statusCode: 200,
      body: JSON.stringify({ topics, bookmarks })
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
