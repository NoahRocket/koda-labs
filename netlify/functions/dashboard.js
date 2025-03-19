const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Extract the JWT token from the Authorization header (case-insensitive)
  const headers = Object.fromEntries(
    Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  const authHeader = headers['authorization'];
  const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  console.log('Access Token from header:', accessToken);

  if (!accessToken) {
    console.error('No access token provided');
    return { statusCode: 401, body: JSON.stringify({ error: 'No access token provided' }) };
  }

  // Initialize Supabase client with the anon key and pass the JWT token in headers
  const supabase = createClient(supabaseUrl, supabaseKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });

  const { action, userId, topicName, topicId, bookmarkUrl, chatHistory } = JSON.parse(event.body || '{}');

  if (!userId) return { statusCode: 400, body: 'Missing user ID' };

  // Log the authenticated user
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  const authUserId = user?.id;
  console.log('Incoming userId:', userId, 'Authenticated userId:', authUserId, 'Auth error:', authError?.message);

  try {
    if (action === 'addTopic') {
      const { data: newTopic } = await supabase
        .from('topics')
        .insert({ name: topicName, user_id: userId })
        .select();
      return { statusCode: 200, body: JSON.stringify({ topicId: newTopic[0].id }) };
    } else if (action === 'deleteTopic') {
      await supabase.from('bookmarks').delete().eq('topic_id', topicId);
      await supabase.from('conversations').delete().eq('topic_id', topicId);
      await supabase.from('topics').delete().eq('id', topicId);
      return { statusCode: 200, body: 'Topic deleted' };
    } else if (action === 'addBookmark') {
      await supabase.from('bookmarks').insert({ topic_id: topicId, url: bookmarkUrl });
      return { statusCode: 200, body: JSON.stringify({ message: 'Bookmark added' }) };
    } else if (action === 'saveConversation') {
      console.log('Saving conversation:', { userId, topicId, chatHistory });
      // Verify the topic belongs to the user
      const { data: topic } = await supabase
        .from('topics')
        .select('user_id')
        .eq('id', topicId)
        .single();
      if (!topic) {
        throw new Error('Topic not found');
      }
      console.log('Topic user_id:', topic.user_id);
      if (topic.user_id !== userId) {
        throw new Error('Topic does not belong to this user');
      }
      const { data, error } = await supabase.from('conversations').insert({
        topic_id: topicId,
        content: chatHistory,
        created_at: new Date().toISOString()
      });
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ message: 'Conversation saved', data }) };
    } else {
      const { data: topics } = await supabase
        .from('topics')
        .select('*')
        .eq('user_id', userId);
      const topicIds = topics ? topics.map(t => t.id) : [];
      const { data: bookmarks } = await supabase
        .from('bookmarks')
        .select('*')
        .in('topic_id', topicIds);
      const { data: conversations } = await supabase
        .from('conversations')
        .select('*')
        .in('topic_id', topicIds);
      return {
        statusCode: 200,
        body: JSON.stringify({ topics, bookmarks, conversations })
      };
    }
  } catch (error) {
    console.error('Error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
