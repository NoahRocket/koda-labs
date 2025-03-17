const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { action, userId, topicName, bookmarkUrl } = JSON.parse(event.body || '{}');
  if (!userId) return { statusCode: 400, body: 'Missing user ID' };

  try {
    if (action === 'add') {
      // Check if topic exists, else create it
      let { data: topic } = await supabase
        .from('topics')
        .select('*')
        .eq('name', topicName)
        .eq('user_id', userId);
      if (!topic || topic.length === 0) {
        const { data: newTopic } = await supabase
          .from('topics')
          .insert({ name: topicName, user_id: userId })
          .select();
        topic = newTopic;
      }
      // Add bookmark
      await supabase
        .from('bookmarks')
        .insert({ topic_id: topic[0].id, url: bookmarkUrl });
      return { statusCode: 200, body: JSON.stringify({ message: 'Bookmark added' }) };
    } else {
      // Fetch topics and bookmarks
      const { data: topics } = await supabase
        .from('topics')
        .select('*')
        .eq('user_id', userId);
      const { data: bookmarks } = await supabase
        .from('bookmarks')
        .select('*');
      return {
        statusCode: 200,
        body: JSON.stringify({ topics, bookmarks })
      };
    }
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
