const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const urlMetadata = require('url-metadata');

// Centralized OpenAI API configuration
const OPENAI_CONFIG = {
  model: 'gpt-3.5-turbo',
  temperature: 0.5,
  max_tokens: 500,
  endpoint: 'https://api.openai.com/v1/chat/completions'
};

// Helper function for OpenAI API calls
async function callOpenAI(systemPrompt, userPrompt) {
  console.log(`[Summary] Calling OpenAI API with model: ${OPENAI_CONFIG.model}`);
  
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  
  console.log('[Summary] Request payload size:', JSON.stringify({
    model: OPENAI_CONFIG.model,
    messages: [
      { role: 'system', content: 'System prompt' }, // Don't log actual content for privacy
      { role: 'user', content: 'Sample user prompt...' } // Don't log actual content for privacy
    ]
  }).length, 'characters');
  
  const response = await fetch(OPENAI_CONFIG.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_CONFIG.model,
      messages: messages,
      max_tokens: OPENAI_CONFIG.max_tokens,
      temperature: OPENAI_CONFIG.temperature,
    }),
  });
  
  return response;
}

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

  const { user_id: userId, topic_id: topicId } = JSON.parse(event.body);

  if (!userId || !topicId) return { statusCode: 400, body: 'Missing user ID or topic ID' };

  try {
    console.log(`[Summary] Processing request for userId: ${userId}, topicId: ${topicId}`);
    
    // Get the latest timestamps from all content
    const { data: latestTimestamps, error: timestampError } = await supabase
      .from('topics')
      .select(`
        id,
        notes!notes_topic_id_fkey (created_at),
        conversations!conversations_topic_id_fkey (created_at),
        bookmarks!bookmarks_topic_id_fkey (created_at)
      `)
      .eq('id', topicId)
      .single();

    if (timestampError) throw timestampError;

    // Calculate the latest timestamp
    const allTimestamps = [
      ...(latestTimestamps.notes?.map(n => n.created_at) || []),
      ...(latestTimestamps.conversations?.map(c => c.created_at) || []),
      ...(latestTimestamps.bookmarks?.map(b => b.created_at) || [])
    ];

    const lastSourceUpdatedAt = allTimestamps.length > 0 
      ? new Date(Math.max(...allTimestamps.map(t => new Date(t))))
      : new Date();

    // Get all content for summarization
    const { data: content, error: contentError } = await supabase
      .from('topics')
      .select(`
        notes!notes_topic_id_fkey (content),
        conversations!conversations_topic_id_fkey (content),
        bookmarks!bookmarks_topic_id_fkey (url)
      `)
      .eq('id', topicId)
      .single();

    if (contentError) throw contentError;

    // Fetch metadata from bookmark URLs
    let bookmarkContent = '';
    if (content.bookmarks && content.bookmarks.length > 0) {
      for (const bookmark of content.bookmarks) {
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
    const conversationContent = content.conversations && content.conversations.length > 0
      ? content.conversations.map(c => c.content).join('\n')
      : 'No conversation history available for this topic.\n';

    // Format notes with dates
    const notesContent = content.notes && content.notes.length > 0
      ? content.notes.map(n => {
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
    
    console.log('[Summary] OpenAI API Key available:', !!process.env.OPENAI_API_KEY);
    console.log('[Summary] OpenAI API Key prefix:', process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.substring(0, 5) + '...' : 'Not available');
    
    try {
      // Call OpenAI API using the helper function
      const response = await callOpenAI(systemPrompt, userPrompt);
      
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
          body: JSON.stringify({ error: errorMessage })
        };
      }

      console.log('[Summary] OpenAI API response received');
      const data = await response.json();
      console.log('[Summary] Response parsed successfully');
      
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        console.error('[Summary] Invalid response format from OpenAI:', JSON.stringify(data));
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid response format from OpenAI' })
        };
      }
      
      const summary = data.choices[0].message.content;
      console.log('[Summary] Generated summary length:', summary.length);
      
      // Save the summary to the database
      console.log('[Summary] Saving summary to database for topic:', topicId);
      try {
        const { data: savedSummary, error: saveError } = await supabase
          .from('summaries')
          .upsert([
            {
              user_id: userId,
              topic_id: topicId,
              content: summary,
              created_at: new Date().toISOString(),
              last_source_updated_at: lastSourceUpdatedAt.toISOString()
            }
          ])
          .select();
        
        if (saveError) {
          console.error('[Summary] Error saving summary:', saveError);
          return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to save summary to database' })
          };
        }
        
        if (!savedSummary || savedSummary.length === 0) {
          console.error('[Summary] No data returned after saving summary');
          return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to save summary to database (no data returned)' })
          };
        }
        
        console.log('[Summary] Summary saved successfully');
        
        // Return the generated summary
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: savedSummary[0] })
        };
      } catch (saveError) {
        console.error('[Summary] Exception saving summary:', saveError);
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Exception saving summary to database' })
        };
      }
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
    console.error('[Summary] Unhandled error caught in main handler:', error);
    console.error('[Summary] Error Message:', error.message);
    console.error('[Summary] Error Stack:', error.stack);

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to generate or save summary' })
    };
  }
};
