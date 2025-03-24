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
      console.log(`[DELETE] Starting deletion of topic ${topicId} and all related data`);
      
      // Verify the topic belongs to the user
      const { data: topic, error: topicError } = await supabase
        .from('topics')
        .select('user_id')
        .eq('id', topicId)
        .single();
        
      if (topicError) {
        console.error(`[DELETE] Error verifying topic: ${topicError.message}`);
        return { 
          statusCode: 404, 
          body: JSON.stringify({ error: 'Topic not found' }) 
        };
      }
      
      if (topic.user_id !== userId) {
        console.error(`[DELETE] Permission denied: Topic belongs to ${topic.user_id}, not ${userId}`);
        return { 
          statusCode: 403, 
          body: JSON.stringify({ error: 'You do not have permission to delete this topic' }) 
        };
      }
      
      try {
        // Delete related data first - delete bookmarks
        const { error: bookmarkDeleteError } = await supabase
          .from('bookmarks')
          .delete()
          .eq('topic_id', topicId);
          
        if (bookmarkDeleteError) {
          console.error(`[DELETE] Error deleting bookmarks: ${bookmarkDeleteError.message}`);
          throw new Error(`Failed to delete bookmarks: ${bookmarkDeleteError.message}`);
        }
        
        console.log(`[DELETE] Successfully deleted bookmarks for topic ${topicId}`);
        
        // Delete conversations
        const { error: conversationDeleteError } = await supabase
          .from('conversations')
          .delete()
          .eq('topic_id', topicId);
          
        if (conversationDeleteError) {
          console.error(`[DELETE] Error deleting conversations: ${conversationDeleteError.message}`);
          throw new Error(`Failed to delete conversations: ${conversationDeleteError.message}`);
        }
        
        console.log(`[DELETE] Successfully deleted conversations for topic ${topicId}`);
        
        // Finally delete the topic itself
        const { error: topicDeleteError } = await supabase
          .from('topics')
          .delete()
          .eq('id', topicId);
          
        if (topicDeleteError) {
          console.error(`[DELETE] Error deleting topic: ${topicDeleteError.message}`);
          throw new Error(`Failed to delete topic: ${topicDeleteError.message}`);
        }
        
        console.log(`[DELETE] Successfully deleted topic ${topicId} and all related data`);
        
        return { 
          statusCode: 200, 
          body: JSON.stringify({ 
            message: 'Topic and all related data deleted successfully',
            topicId
          }) 
        };
      } catch (deleteError) {
        console.error(`[DELETE] Error in deletion process: ${deleteError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ 
            error: deleteError.message 
          }) 
        };
      }
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
      // Fetch the topic itself to get name
      const { data: topic, error: topicError } = await supabase
        .from('topics')
        .select('id, name, user_id')
        .eq('id', topicId)
        .single();
        
      if (topicError) {
        console.error(`[GET_TOPIC_DETAILS] Error fetching topic: ${topicError.message}`);
        return { 
          statusCode: 404, 
          body: JSON.stringify({ error: 'Topic not found' }) 
        };
      }
      
      // Verify the topic belongs to the user
      if (topic.user_id !== userId) {
        console.error(`[GET_TOPIC_DETAILS] Permission denied: Topic belongs to ${topic.user_id}, not ${userId}`);
        return { 
          statusCode: 403, 
          body: JSON.stringify({ error: 'You do not have permission to view this topic' }) 
        };
      }
      
      // Fetch conversations for specific topic
      const { data: conversations, error: convError } = await supabase
        .from('conversations')
        .select('*')
        .eq('topic_id', topicId)
        .order('created_at', { ascending: false });

      if (convError) {
        console.error(`[GET_TOPIC_DETAILS] Error fetching conversations: ${convError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to fetch conversations: ${convError.message}` }) 
        };
      }

      // Fetch bookmarks for specific topic
      const { data: bookmarks, error: bookError } = await supabase
        .from('bookmarks')
        .select('*')
        .eq('topic_id', topicId);

      if (bookError) {
        console.error(`[GET_TOPIC_DETAILS] Error fetching bookmarks: ${bookError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to fetch bookmarks: ${bookError.message}` }) 
        };
      }
      
      // Fetch notes for specific topic
      const { data: notes, error: notesError } = await supabase
        .from('notes')
        .select('*')
        .eq('topic_id', topicId)
        .order('created_at', { ascending: false });
        
      if (notesError) {
        console.error(`[GET_TOPIC_DETAILS] Error fetching notes: ${notesError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to fetch notes: ${notesError.message}` }) 
        };
      }
      
      console.log(`[GET_TOPIC_DETAILS] Found ${conversations.length} conversations, ${bookmarks.length} bookmarks, ${notes.length} notes for topic ${topicId}`);

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          topic,
          conversations, 
          bookmarks,
          notes
        })
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
    } else if (action === 'getNotes') {
      console.log(`[GET_NOTES] Fetching notes for user ${userId}, topic filter: ${topicId || 'all'}`);
      
      // Create base query without the topics relation
      let query = supabase
        .from('notes')
        .select(`
          id, 
          content, 
          created_at,
          topic_id
        `)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
        
      // Apply topic filter if specified
      if (topicId) {
        if (topicId === 'untagged') {
          query = query.is('topic_id', null);
        } else {
          query = query.eq('topic_id', topicId);
        }
      }
      
      const { data: notes, error: notesError } = await query;
      
      if (notesError) {
        console.error(`[GET_NOTES] Error fetching notes: ${notesError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to fetch notes: ${notesError.message}` }) 
        };
      }
      
      // Fetch topic names separately only for notes with topic_id
      const topicIds = notes
        .filter(note => note.topic_id)
        .map(note => note.topic_id);
      
      let topicMap = {};
      
      if (topicIds.length > 0) {
        const { data: topics, error: topicsError } = await supabase
          .from('topics')
          .select('id, name')
          .in('id', topicIds);
        
        if (!topicsError && topics) {
          // Create a map of topic id to name
          topicMap = topics.reduce((map, topic) => {
            map[topic.id] = topic.name;
            return map;
          }, {});
        }
      }
      
      // Format notes with topic names
      const formattedNotes = notes.map(note => ({
        id: note.id,
        content: note.content,
        created_at: note.created_at,
        topic_id: note.topic_id,
        topic_name: note.topic_id ? topicMap[note.topic_id] || null : null
      }));
      
      console.log(`[GET_NOTES] Found ${formattedNotes.length} notes`);
      
      return { 
        statusCode: 200, 
        body: JSON.stringify({ notes: formattedNotes }) 
      };
    } else {
      // Get topics with conversation and bookmark counts
      const { data: topics, error: topicsError } = await supabase
        .from('topics')
        .select(`
          id,
          name,
          user_id
        `)
        .eq('user_id', userId);

      if (topicsError) {
        console.error(`[GET_TOPICS] Error fetching topics: ${topicsError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to fetch topics: ${topicsError.message}` }) 
        };
      }
      
      // Fetch conversation counts separately
      const conversationCountPromises = topics.map(async topic => {
        const { count, error } = await supabase
          .from('conversations')
          .select('*', { count: 'exact', head: true })
          .eq('topic_id', topic.id);
          
        return error ? 0 : (count || 0);
      });
      
      // Fetch bookmark counts separately
      const bookmarkCountPromises = topics.map(async topic => {
        const { count, error } = await supabase
          .from('bookmarks')
          .select('*', { count: 'exact', head: true })
          .eq('topic_id', topic.id);
          
        return error ? 0 : (count || 0);
      });
      
      // Fetch note counts separately
      const noteCountPromises = topics.map(async topic => {
        const { count, error } = await supabase
          .from('notes')
          .select('*', { count: 'exact', head: true })
          .eq('topic_id', topic.id);
          
        return error ? 0 : (count || 0);
      });
      
      // Wait for all count queries to complete
      const conversationCounts = await Promise.all(conversationCountPromises);
      const bookmarkCounts = await Promise.all(bookmarkCountPromises);
      const noteCounts = await Promise.all(noteCountPromises);
      
      // Combine topics with their counts
      const transformedTopics = topics.map((topic, index) => ({
        ...topic,
        conversation_count: conversationCounts[index],
        bookmark_count: bookmarkCounts[index],
        note_count: noteCounts[index]
      }));
      
      console.log(`[GET_TOPICS] Found ${transformedTopics.length} topics`);

      return {
        statusCode: 200,
        body: JSON.stringify({ topics: transformedTopics })
      };
    }
  } catch (error) {
    console.error('Error in dashboard function:', error.message, error.stack);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ 
        error: `Server error: ${error.message}`, 
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }) 
    };
  }
};
