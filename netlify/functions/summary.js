const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { userId, topicId } = JSON.parse(event.body || '{}');

  if (!userId || !topicId) return { statusCode: 400, body: 'Missing user ID or topic ID' };

  try {
    const { data: bookmarks } = await supabase
      .from('bookmarks')
      .select('url')
      .eq('topic_id', topicId);
    const { data: conversations } = await supabase
      .from('conversations')
      .select('content')
      .eq('topic_id', topicId);

    const bookmarkUrls = bookmarks.map(b => b.url).join('\n');
    const conversationContent = conversations.map(c => c.content).join('\n');
    const combinedContent = `Bookmarks:\n${bookmarkUrls}\n\nConversations:\n${conversationContent}`;

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
          { role: 'system', content: 'You are a helpful assistant that summarizes information.' },
          { role: 'user', content: `Please summarize the key facts and takeaways from the following content:\n\n${combinedContent}` }
        ],
        max_tokens: 300,
        temperature: 0.5,
      }),
    });

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
