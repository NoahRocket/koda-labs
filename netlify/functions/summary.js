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

  const { userId, topicId, timestamp } = JSON.parse(event.body || '{}');

  if (!userId || !topicId) return { statusCode: 400, body: 'Missing user ID or topic ID' };

  try {
    console.log(`[Summary] Processing request for userId: ${userId}, topicId: ${topicId}, timestamp: ${timestamp || 'none'}`);
    
    // Fetch bookmarks for the topic
    const { data: bookmarks } = await supabase
      .from('bookmarks')
      .select('url')
      .eq('topic_id', topicId);

    console.log(`[Summary] Found ${bookmarks?.length || 0} bookmarks for topic ${topicId}`);

    // Fetch all conversations for the topic
    const { data: conversations } = await supabase
      .from('conversations')
      .select('content')
      .eq('topic_id', topicId);
      
    console.log(`[Summary] Found ${conversations?.length || 0} conversations for topic ${topicId}`);

    // Fetch notes for the topic
    const { data: notes } = await supabase
      .from('notes')
      .select('content, created_at')
      .eq('topic_id', topicId);

    console.log(`[Summary] Found ${notes?.length || 0} notes for topic ${topicId}`);

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

    // Format notes with dates
    const notesContent = notes && notes.length > 0
      ? notes.map(n => {
          const date = new Date(n.created_at).toLocaleDateString();
          return `[${date}] ${n.content}`;
        }).join('\n')
      : 'No personal notes available for this topic.\n';

    // Combine all content including notes
    const combinedContent = `Bookmarks:\n${bookmarkContent}\n\nConversations:\n${conversationContent}\n\nNotes:\n${notesContent}`;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      console.error('OpenAI API key is missing');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'OpenAI API key is not configured' })
      };
    }

    const systemPrompt = `
You are an expert summarizer analyzing a user's knowledge repository. Create a concise but comprehensive summary of their knowledge about a specific topic.

The input contains three types of content:
1. Bookmarks - External resources the user has saved
2. Conversations - Dialog history with an AI assistant
3. Notes - Personal thoughts and ideas directly from the user

For notes specifically:
- Consider these the user's own insights and observations
- Give special attention to recurring themes in notes
- Present note insights with their creation dates for context

Structure your summary with:
- Key themes and patterns across all content types
- Important facts, concepts, and insights
- Knowledge gaps that appear evident
- Brief summary of what personal notes reveal about their thinking

Keep the tone informative and professional. Even if content is sparse, extract meaningful insights without inventing information.
`;
    
    const userPrompt = `Generate a comprehensive summary of the user's knowledge about this topic based on their conversations, bookmarks, and personal notes:\n\n${combinedContent}`;
    
    console.log('[Summary] Making request to OpenAI API');
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini-2024-07-18',
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: userPrompt
            }
          ],
          max_tokens: 500,
          temperature: 0.5,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Summary] OpenAI API error:', errorText);
        console.error('[Summary] Status:', response.status);
        console.error('[Summary] Headers:', JSON.stringify(Object.fromEntries([...response.headers])));
        
        let errorMessage = 'Failed to generate summary';
        if (response.status === 401) {
          errorMessage = 'OpenAI API key is invalid';
        } else if (response.status === 429) {
          errorMessage = 'Rate limit exceeded. Please try again later';
        } else if (response.status === 500) {
          errorMessage = 'OpenAI service is experiencing issues. Please try again later';
        }
        
        return {
          statusCode: response.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            error: errorMessage,
            details: errorText
          })
        };
      }

      console.log('[Summary] OpenAI API response received');
      const data = await response.json();
      console.log('[Summary] Response parsed successfully');
      
      if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
        console.error('[Summary] Invalid response structure from OpenAI:', JSON.stringify(data));
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid response from OpenAI' })
        };
      }
      
      const summary = data.choices[0].message.content.trim();
      console.log('[Summary] Summary generated successfully');

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({ summary })
      };
    } catch (apiError) {
      console.error('[Summary] Error making OpenAI API request:', apiError);
      return { 
        statusCode: 500, 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Error connecting to OpenAI API',
          message: apiError.message
        }) 
      };
    }
  } catch (error) {
    console.error('[Summary] Error generating summary:', error);
    return { 
      statusCode: 500, 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Failed to generate summary',
        message: error.message,
        stack: error.stack
      }) 
    };
  }
};
