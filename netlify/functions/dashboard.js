const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

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
    } else if (action === 'getTopicDetails') {
      // Fetch conversations for specific topic
      const { data: conversations, error: convError } = await supabase
        .from('conversations')
        .select('*')
        .eq('topic_id', topicId)
        .order('created_at', { ascending: false });

      if (convError) throw convError;

      // Fetch bookmarks for specific topic
      const { data: bookmarks, error: bookError } = await supabase
        .from('bookmarks')
        .select('*')
        .eq('topic_id', topicId);

      if (bookError) throw bookError;

      return {
        statusCode: 200,
        body: JSON.stringify({ conversations, bookmarks })
      };
    } else if (action === 'generateSummary') {
      // Fetch conversations for the topic
      const { data: conversations } = await supabase
        .from('conversations')
        .select('content')
        .eq('topic_id', topicId);

      // Fetch bookmarks for the topic
      const { data: bookmarks } = await supabase
        .from('bookmarks')
        .select('url')
        .eq('topic_id', topicId);

      // Prepare the content for summarization
      const conversationContent = conversations && conversations.length > 0
        ? conversations.map(c => c.content).join('\n')
        : 'No conversation history available for this topic.\n';

      const bookmarkContent = bookmarks && bookmarks.length > 0
        ? bookmarks.map(b => b.url).join('\n')
        : 'No bookmarks available for this topic.\n';

      const combinedContent = `Bookmarks:\n${bookmarkContent}\nConversations:\n${conversationContent}`;

      // Call OpenAI API for summary generation
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [
            { 
              role: 'system', 
              content: 'You are a helpful assistant that summarizes information. Provide key facts and takeaways in 2-3 sentences, even with limited data.' 
            },
            { 
              role: 'user', 
              content: `Please summarize the key facts and takeaways from the following content:\n\n${combinedContent}` 
            }
          ],
          max_tokens: 300,
          temperature: 0.5,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenAI API error:', errorText);
        throw new Error('Failed to generate summary');
      }

      const data = await response.json();
      const summary = data.choices[0].message.content.trim();

      return {
        statusCode: 200,
        body: JSON.stringify({ summary })
      };
    } else {
      // Get topics with conversation and bookmark counts
      const { data: topics, error: topicsError } = await supabase
        .from('topics')
        .select(`
          *,
          conversations:conversations(count),
          bookmarks:bookmarks(count)
        `)
        .eq('user_id', userId);

      if (topicsError) throw topicsError;

      // Transform the response to include the counts
      const transformedTopics = topics.map(topic => ({
        ...topic,
        conversation_count: topic.conversations[0]?.count || 0,
        bookmark_count: topic.bookmarks[0]?.count || 0,
        // Remove the raw counts from the response
        conversations: undefined,
        bookmarks: undefined
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({ topics: transformedTopics })
      };
    }
  } catch (error) {
    console.error('Error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
