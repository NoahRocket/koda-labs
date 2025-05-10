const { getSupabaseAuthClient } = require('./supabaseClient');
const fetch = require('node-fetch');
const urlMetadata = require('url-metadata');

// Centralized OpenAI API configuration
const OPENAI_CONFIG = {
  model: 'gpt-4-1106-preview',
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

// Helper: Parse markdown highlights to objects
function parseHighlightsFromMarkdown(markdown) {
  const highlights = [];
  const lines = markdown.split('\n');
  let inHighlightsSection = false;
  for (const line of lines) {
    if (line.trim().startsWith('### Learning Highlights')) {
      inHighlightsSection = true;
      continue;
    }
    if (inHighlightsSection) {
      const match = /^- \*\*(.+)\*\*: "([^"]+)" \[(.+?)\] \[Revisit\] \[Quiz Me\]/.exec(line.trim());
      if (match) {
        highlights.push({
          concept: match[1],
          description: match[2],
          source: match[3]
        });
      } else if (line.trim() === '' || line.trim().startsWith('#')) {
        // End of highlights section if another header or empty
        if (highlights.length > 0) break;
      }
    }
  }
  return highlights;
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

  // Initialize Supabase client with the appropriate authentication headers
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });

  const { action, topic_id: topicId, user_id: userId } = JSON.parse(event.body || '{}');
  
  console.log(`[Summary] Received request with action: ${action}, userId: ${userId}, topicId: ${topicId}`);

  if (action === 'getSummary') {
    try {
      console.log(`[Summary] Fetching existing summary for topic: ${topicId}, user: ${userId}`);
      const { data: summaries, error } = await supabase
        .from('summaries')
        .select('*')
        .eq('topic_id', topicId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch summary', details: error }) };
      }
      if (!summaries || summaries.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ summary: null }) };
      }
      // Parse highlights from markdown
      const highlights = parseHighlightsFromMarkdown(summaries[0].content || '');
      return {
        statusCode: 200,
        body: JSON.stringify({
          summary: {
            ...summaries[0],
            highlights,
          }
        })
      };
    } catch (error) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch summary', details: error.message }) };
    }
  } else if (action === 'generateSummary') {
    // This is a request to generate a new summary
    if (!userId || !topicId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing user ID or topic ID' }) };

    try {
      console.log(`[Summary] Generating new summary for userId: ${userId}, topicId: ${topicId}`);
      
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

      const systemPrompt = `You are an expert summarizer. Given a user's Conversations (array of dialogs with timestamps, e.g., [{timestamp: "2023-04-14", dialog: ["User: What is a loop?", "AI: A loop is..."]}, ...]), Bookmarks (array of objects with {title, url, tag, date_added}), and Notes (array of objects with {date, content}), generate a markdown output for the Summary section with a "Learning Highlights" section only.

List key facts and concepts as:
- **Concept**: "Description" [Source] [Revisit] [Quiz Me]

Instructions:
- Prioritize concepts that appear across multiple sources or are emphasized in notes.
- Use bold for key terms.
- Keep each description concise (1-2 sentences).
- Use an engaging, encouraging tone.
- Use the following markdown format:

### Learning Highlights
- **Loops**: "Repeat code efficiently" [Conv #1] [Revisit] [Quiz Me]
- **Functions**: "Organize code logically" [Note #1] [Revisit] [Quiz Me]
- **APIs**: "Enable data exchange" [Bookmark #1] [Revisit] [Quiz Me]

- For each highlight, include the best source reference: [Conv #N], [Note #N], or [Bookmark #N].
- Do not include any sections except "Learning Highlights".
- Output only markdown, no explanations or extra commentary.`;
      
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
        
        const summaryText = data.choices[0].message.content;
        console.log('[Summary] Generated summary length:', summaryText.length);
        
        // Upsert summary for this topic/user
        const supabaseDb = createClient(supabaseUrl, supabaseKey, {
          auth: {
            autoRefreshToken: false,
            persistSession: false
          },
          global: {
            headers: {
              Authorization: `Bearer ${accessToken}`
            }
          }
        });
        const { data: savedSummary, error: saveError } = await supabaseDb
          .from('summaries')
          .upsert([
            {
              user_id: userId,
              topic_id: topicId,
              content: summaryText,
              created_at: new Date().toISOString(),
              last_source_updated_at: new Date().toISOString()
            }
          ], { onConflict: 'topic_id,user_id' })
          .select();
        if (saveError) {
          console.error('[Summary] Supabase saveError:', JSON.stringify(saveError, null, 2));
          return { statusCode: 500, body: JSON.stringify({ error: saveError.message || saveError }) };
        }
        // Return the saved summary with highlights
        const highlightsSaved = parseHighlightsFromMarkdown(summaryText);
        return {
          statusCode: 200,
          body: JSON.stringify({
            summary: {
              ...savedSummary[0],
              highlights: highlightsSaved,
            }
          })
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
      console.error('[Summary] Unhandled error caught in main handler:', error);
      console.error('[Summary] Error Message:', error.message);
      console.error('[Summary] Error Stack:', error.stack);

      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to generate or save summary' })
      };
    }
  } else {
    // If no valid action is specified, return an error
    return { 
      statusCode: 400, 
      body: JSON.stringify({ 
        error: 'Invalid action specified. Must be either "getSummary" or "generateSummary"',
        action_received: action
      })
    };
  }
};
