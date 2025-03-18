const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

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

    // Attempt to fetch title/content from bookmark URLs
    let bookmarkContent = '';
    if (bookmarks && bookmarks.length > 0) {
      for (const bookmark of bookmarks) {
        try {
          const response = await fetch(bookmark.url);
          if (response.ok) {
            const text = await response.text();
            // Extract title as a simple proxy for content (basic HTML parsing)
            const titleMatch = text.match(/<title>(.*?)<\/title>/i);
            const title = titleMatch ? titleMatch[1] : 'No title available';
            bookmarkContent += `URL: ${bookmark.url} - Title: ${title}\n`;
          } else {
            bookmarkContent += `URL: ${bookmark.url} - Failed to fetch content\n`;
          }
        } catch (error) {
          bookmarkContent += `URL: ${bookmark.url} - Error fetching: ${error.message}\n`;
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
          { role: 'system', content: 'You are a helpful assistant that summarizes information. Provide key facts and takeaways in 2-3 sentences.' },
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
