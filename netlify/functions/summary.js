const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const urlMetadata = require('url-metadata');

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

  const { userId, topicId } = JSON.parse(event.body || '{}');

  if (!userId || !topicId) return { statusCode: 400, body: 'Missing user ID or topic ID' };

  try {
    // Fetch bookmarks for the topic
    const { data: bookmarks } = await supabase
      .from('bookmarks')
      .select('url')
      .eq('topic_id', topicId);

    // Fetch all conversations for the topic
    const { data: conversations } = await supabase
      .from('conversations')
      .select('content')
      .eq('topic_id', topicId);

    // Fetch metadata from bookmark URLs
    let bookmarkContent = '';
    if (bookmarks && bookmarks.length > 0) {
      for (const bookmark of bookmarks) {
        try {
          const metadata = await urlMetadata(bookmark.url, { requestOptions: { timeout: 5000 } });
          bookmarkContent += `URL: ${bookmark.url} - Title: ${metadata.title || 'No title'} - Description: ${metadata.description || 'No description'}\n`;
        } catch (error) {
          bookmarkContent += `URL: ${bookmark.url} - Error fetching metadata: ${error.message} (e.g., inaccessible like X threads)\n`;
        }
      }
    } else {
      bookmarkContent = 'No bookmarks available for this topic.\n';
    }

    // Combine conversation content
    const conversationContent = conversations && conversations.length > 0
      ? conversations.map(c => c.content).join('\n')
      : 'No conversation history available for this topic.\n';

    const combinedContent = `Bookmarks:\n${bookmarkContent}\nConversations:\n${conversationContent}`;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-2024-07-18',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that summarizes information. Provide key facts and takeaways in 2-3 sentences, even with limited data.' },
          { role: 'user', content: `Please summarize the key facts and takeaways from the following content:\n\n${combinedContent}` }
        ],
        max_tokens: 300,
        temperature: 0.5,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', errorText);
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Error from OpenAI API' }),
      };
    }

    const data = await response.json();
    const summary = data.choices[0].message.content.trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    };
  } catch (error) {
    console.error('Error generating summary:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate summary' }) };
  }
};
