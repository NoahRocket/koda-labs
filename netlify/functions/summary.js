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
You are Koda's Summary Engine, a brilliant assistant designed to distill user conversations, notes, and X bookmarks into clear, concise, and engaging summaries that fuel an insanely great learning experience. Your goal is to transform scattered info—whether it's a chat about blockchain, a saved X thread on rocket engines, or a user's random notes—into a tidy, insightful package that's easy to revisit and builds a personal knowledge base. You're smart, organized, and subtly playful, like a librarian with a knack for storytelling and a passion for clarity.

Here's how you work:
- Analyze the input (conversations, notes, bookmarks) and identify the core ideas, key takeaways, and standout details—cut through the noise without losing the good stuff.
- Write summaries that are short (100-150 words max), crystal-clear, and structured—start with a punchy opener, then hit the main points, and wrap with a hook or connection to related topics.
- Use a warm, crisp tone with a sprinkle of Koda's wit—make it feel lively, not dry (e.g., "Blockchain's a fortress of trust—here's how it locks in the truth").
- Highlight actionable insights or concepts users can explore further, subtly nudging them toward mastery (e.g., "Next up: smart contracts?").
- Categorize the summary into a relevant topic (e.g., 'Tech', 'Engineering') and tag 2-3 key terms (e.g., 'blockchain', 'crypto') for easy retrieval.
- If the input's unclear, prioritize what's most coherent and flag gaps with a friendly note (e.g., "This bit's fuzzy—more details would sharpen it!").

You're the glue that turns learning into a journey—make every summary a delight to read, a spark for curiosity, and a stepping stone to brilliance!
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

      // Save the summary to the database
      try {
        // Check if summaries already exist for this topic and user
        const { data: existingSummaries, error: lookupError } = await supabase
          .from('summaries')
          .select('id')
          .eq('topic_id', topicId)
          .eq('user_id', userId);

        if (lookupError) {
          console.error('[Summary] Error checking for existing summaries:', lookupError);
          persistenceError = lookupError;
        } else if (existingSummaries && existingSummaries.length > 0) {
          // Delete all existing summaries for this topic and user
          console.log(`[Summary] Found ${existingSummaries.length} existing summaries for topic ${topicId}, deleting them`);
          
          const existingIds = existingSummaries.map(s => s.id);
          const { error: deleteError } = await supabase
            .from('summaries')
            .delete()
            .in('id', existingIds);
            
          if (deleteError) {
            console.error('[Summary] Error deleting existing summaries:', deleteError);
            persistenceError = deleteError;
          } else {
            console.log(`[Summary] Successfully deleted ${existingSummaries.length} existing summaries`);
          }
        } else {
          console.log('[Summary] No existing summaries found for this topic');
        }
        
        // Create a new summary regardless of what happened above
        let summaryResult;
        const currentTimestamp = new Date().toISOString();
        let persistenceSuccessful = false;
        let persistenceError = null;

        // Create new summary
        console.log('[Summary] Creating new summary');
        const { data: newSummary, error: insertError } = await supabase
          .from('summaries')
          .insert({
            topic_id: topicId,
            user_id: userId,
            content: summary,
            last_source_updated_at: currentTimestamp
          })
          .select()
          .single();

        if (insertError) {
          console.error('[Summary] Error creating new summary:', insertError);
          persistenceError = insertError.message;
        } else if (!newSummary) {
          console.error('[Summary] Insert succeeded but no summary returned');
          persistenceError = 'Insert succeeded but no data returned';
        } else {
          console.log('[Summary] Successfully created new summary with ID:', newSummary.id);
          summaryResult = newSummary;
          persistenceSuccessful = true;
        }

        console.log('[Summary] Database persistence successful:', persistenceSuccessful);
        
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          body: JSON.stringify({ 
            summary,
            persistenceSuccessful,
            persistenceError,
            summaryId: summaryResult?.id,
            timestamp: currentTimestamp
          })
        };
      } catch (dbError) {
        console.error('[Summary] Database operation failed:', dbError);
        // Continue even if database operation fails, still return the summary to user
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          body: JSON.stringify({ 
            summary,
            persistenceSuccessful: false,
            persistenceError: dbError.message
          })
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
