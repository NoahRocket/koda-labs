const fetch = require('node-fetch');
const { getSupabaseAuthClient } = require('./supabaseClient'); // Import the specific client

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

  const supabaseAuth = getSupabaseAuthClient();

  // Validate the token and get the authenticated user
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(accessToken);

  if (authError || !user) {
    console.error('Authentication error or no user for token:', authError?.message);
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token. Please log in again.' }) };
  }
  const authUserId = user.id; // Use this ID for all operations

  // Create a new Supabase client with the access token for authenticated requests
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

  // userIdFromBody can be used for non-critical logging if needed, but not for auth-sensitive ops
  const { action, userId: userIdFromBody, topicName, topicId, bookmarkUrl, chatHistory, noteContent, noteId, conversationId, messageId } = JSON.parse(event.body || '{}');
  console.log('Incoming userId from body:', userIdFromBody, 'Authenticated userId from token:', authUserId);

  try {
    if (action === 'addTopic') {
      const { data: newTopic, error: addTopicError } = await supabase
        .from('topics')
        .insert({ name: topicName, user_id: authUserId })
        .select();
      if (addTopicError) throw addTopicError;
      return { statusCode: 200, body: JSON.stringify({ topicId: newTopic[0].id }) };
    } else if (action === 'deleteTopic') {
      if (!topicId) return { statusCode: 400, body: 'Missing topic ID' };
      console.log(`[DELETE] Starting deletion of topic ${topicId} and all related data for user ${authUserId}`);
      
      const { data: topic, error: topicError } = await supabase
        .from('topics')
        .select('user_id')
        .eq('id', topicId)
        .single();
        
      if (topicError || !topic) {
        console.error(`[DELETE] Error verifying topic or topic not found: ${topicError?.message}`);
        return { statusCode: 404, body: JSON.stringify({ error: 'Topic not found' }) };
      }
      
      if (topic.user_id !== authUserId) {
        console.error(`[DELETE] Permission denied: Topic belongs to ${topic.user_id}, not ${authUserId}`);
        return { statusCode: 403, body: JSON.stringify({ error: 'You do not have permission to delete this topic' }) };
      }
      
      console.log(`[DELETE] Deleting bookmarks for topic ${topicId}`);
      const { error: bookmarkDeleteError } = await supabase.from('bookmarks').delete().eq('topic_id', topicId);
      if (bookmarkDeleteError) throw new Error(`Failed to delete bookmarks: ${bookmarkDeleteError.message}`);
      
      console.log(`[DELETE] Deleting conversations for topic ${topicId}`);
      const { error: conversationDeleteError } = await supabase.from('conversations').delete().eq('topic_id', topicId);
      if (conversationDeleteError) throw new Error(`Failed to delete conversations: ${conversationDeleteError.message}`);

      console.log(`[DELETE] Deleting notes for topic ${topicId}`);
      const { error: notesDeleteError } = await supabase.from('notes').delete().eq('topic_id', topicId);
      if (notesDeleteError) throw new Error(`Failed to delete notes: ${notesDeleteError.message}`);

      console.log(`[DELETE] Deleting topic ${topicId} itself`);
      const { error: topicDeleteError } = await supabase.from('topics').delete().eq('id', topicId).eq('user_id', authUserId);
      if (topicDeleteError) throw new Error(`Failed to delete topic: ${topicDeleteError.message}`);
      
      console.log(`[DELETE] Successfully deleted topic ${topicId} and related data`);
      return { statusCode: 200, body: JSON.stringify({ message: 'Topic and all related data deleted successfully' }) };
    } else if (action === 'updateTopicName') {
      const { topicId, newTopicName } = JSON.parse(event.body || '{}');
      
      if (!topicId || !newTopicName) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing topic ID or new topic name' }) };
      }

      console.log(`[UPDATE_TOPIC] Attempting to update topic ${topicId} to name "${newTopicName}" for user ${authUserId}`);

      // Verify the topic belongs to the user first
      const { data: topic, error: verifyError } = await supabase
        .from('topics')
        .select('user_id')
        .eq('id', topicId)
        .single();

      if (verifyError) {
        console.error(`[UPDATE_TOPIC] Error verifying topic ${topicId}: ${verifyError.message}`);
        // Differentiate between not found and other errors if needed
        if (verifyError.code === 'PGRST116') { // Resource not found 
          return { statusCode: 404, body: JSON.stringify({ error: 'Topic not found' }) };
        }
        return { statusCode: 500, body: JSON.stringify({ error: `Verification error: ${verifyError.message}` }) };
      }

      if (topic.user_id !== authUserId) {
        console.error(`[UPDATE_TOPIC] Permission denied: Topic ${topicId} belongs to user ${topic.user_id}, attempt by ${authUserId}`);
        return { statusCode: 403, body: JSON.stringify({ error: 'Permission denied to update this topic' }) };
      }

      // Proceed with the update
      const { error: updateError } = await supabase
        .from('topics')
        .update({ name: newTopicName.trim() })
        .eq('id', topicId)
        .eq('user_id', authUserId); // Redundant check, but good for safety

      if (updateError) {
        console.error(`[UPDATE_TOPIC] Error updating topic ${topicId}: ${updateError.message}`);
        return { statusCode: 500, body: JSON.stringify({ error: `Failed to update topic name: ${updateError.message}` }) };
      }

      console.log(`[UPDATE_TOPIC] Successfully updated topic ${topicId} name for user ${authUserId}`);
      return { statusCode: 200, body: JSON.stringify({ message: 'Topic name updated successfully' }) };
    } else if (action === 'addBookmark') {
      if (!topicId || !bookmarkUrl) return { statusCode: 400, body: 'Missing topic ID or bookmark URL' };
      const { error } = await supabase
        .from('bookmarks')
        .insert({ topic_id: topicId, user_id: authUserId, url: bookmarkUrl });
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ message: 'Bookmark added' }) };
    } else if (action === 'saveConversation') {
      console.log('Saving conversation:', { userId: authUserId, topicId, chatHistory });
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
      if (topic.user_id !== authUserId) {
        throw new Error('Topic does not belong to this user');
      }
      const { data, error } = await supabase.from('conversations').insert({
        topic_id: topicId,
        content: chatHistory,
        created_at: new Date().toISOString()
      });
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ message: 'Conversation saved', data }) };
    } else if (action === 'saveNote') {
      // Extract the note content from the request body
      const { content } = JSON.parse(event.body || '{}');
      
      if (!content) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ error: 'Missing note content' }) 
        };
      }
      
      console.log(`[SAVE_NOTE] Saving note for user ${authUserId}, topic: ${topicId || 'untagged'}`);
      
      // Create the note record
      const noteRecord = {
        user_id: authUserId,
        content,
        created_at: new Date().toISOString()
      };
      
      // Only add topic_id if it's provided (otherwise it'll be untagged)
      if (topicId) {
        noteRecord.topic_id = topicId;
        
        // If topicId is provided, verify it belongs to the user
        if (topicId) {
          const { data: topic, error: topicError } = await supabase
            .from('topics')
            .select('user_id')
            .eq('id', topicId)
            .single();
            
          if (topicError) {
            console.error(`[SAVE_NOTE] Error verifying topic: ${topicError.message}`);
            return { 
              statusCode: 404, 
              body: JSON.stringify({ error: 'Topic not found' }) 
            };
          }
          
          if (topic.user_id !== authUserId) {
            console.error(`[SAVE_NOTE] Permission denied: Topic belongs to ${topic.user_id}, not ${authUserId}`);
            return { 
              statusCode: 403, 
              body: JSON.stringify({ error: 'You do not have permission to add notes to this topic' }) 
            };
          }
        }
      }
      
      // Insert the note into the database
      const { data: note, error: noteError } = await supabase
        .from('notes')
        .insert(noteRecord)
        .select();
        
      if (noteError) {
        console.error(`[SAVE_NOTE] Error saving note: ${noteError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to save note: ${noteError.message}` }) 
        };
      }
      
      console.log(`[SAVE_NOTE] Successfully saved note with ID: ${note[0].id}`);
      
      return {
        statusCode: 200,
        body: JSON.stringify({ 
          message: 'Note saved successfully',
          note: note[0]
        })
      };
    } else if (action === 'deleteNote') {
      // Add a deleteNote handler
      const { noteId } = JSON.parse(event.body || '{}');
      
      if (!noteId) {
        return { 
          statusCode: 400, 
          body: JSON.stringify({ error: 'Missing note ID' }) 
        };
      }
      
      // Verify the note belongs to the user
      const { data: note, error: noteError } = await supabase
        .from('notes')
        .select('user_id')
        .eq('id', noteId)
        .single();
        
      if (noteError) {
        console.error(`[DELETE_NOTE] Error verifying note: ${noteError.message}`);
        return { 
          statusCode: 404, 
          body: JSON.stringify({ error: 'Note not found' }) 
        };
      }
      
      if (note.user_id !== authUserId) {
        console.error(`[DELETE_NOTE] Permission denied: Note belongs to ${note.user_id}, not ${authUserId}`);
        return { 
          statusCode: 403, 
          body: JSON.stringify({ error: 'You do not have permission to delete this note' }) 
        };
      }
      
      // Delete the note
      const { error: deleteError } = await supabase
        .from('notes')
        .delete()
        .eq('id', noteId);
        
      if (deleteError) {
        console.error(`[DELETE_NOTE] Error deleting note: ${deleteError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to delete note: ${deleteError.message}` }) 
        };
      }
      
      console.log(`[DELETE_NOTE] Successfully deleted note with ID: ${noteId}`);
      
      return {
        statusCode: 200,
        body: JSON.stringify({ 
          message: 'Note deleted successfully'
        })
      };
    } else if (action === 'getSummary') {
      if (!topicId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing topic ID' }) };
      }
      
      console.log(`[GET_SUMMARY] Fetching summary for topic: ${topicId}`);
      
      // Verify the topic belongs to the user
      const { data: topic, error: topicError } = await supabase
        .from('topics')
        .select('user_id')
        .eq('id', topicId)
        .single();
        
      if (topicError) {
        console.error(`[GET_SUMMARY] Error verifying topic: ${topicError.message}`);
        return { 
          statusCode: 404, 
          body: JSON.stringify({ error: 'Topic not found' }) 
        };
      }
      
      if (topic.user_id !== authUserId) {
        console.error(`[GET_SUMMARY] Permission denied: Topic belongs to ${topic.user_id}, not ${authUserId}`);
        return { 
          statusCode: 403, 
          body: JSON.stringify({ error: 'You do not have permission to access this topic' }) 
        };
      }
      
      // Fetch the summary for this topic
      const { data: summary, error: summaryError } = await supabase
        .from('summaries')
        .select('*')
        .eq('topic_id', topicId)
        .eq('user_id', authUserId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (summaryError && summaryError.code !== 'PGRST116') { // PGRST116 is "no rows returned" which is not an error
        console.error(`[GET_SUMMARY] Error fetching summary: ${summaryError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to fetch summary: ${summaryError.message}` }) 
        };
      }
      
      console.log(`[GET_SUMMARY] Summary found: ${summary ? 'Yes' : 'No'}`);
      
      return { 
        statusCode: 200, 
        body: JSON.stringify({ summary: summary || null }) 
      };
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
      if (topic.user_id !== authUserId) {
        console.error(`[GET_TOPIC_DETAILS] Permission denied: Topic belongs to ${topic.user_id}, not ${authUserId}`);
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
        .select('id, content, created_at')
        .eq('user_id', authUserId)
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
          notes: notes || []
        })
      };
    } else if (action === 'getNotes') {
      console.log(`[GET_NOTES] Fetching notes for user ${authUserId}, topic filter: ${topicId || 'all'}`);
      
      // Create base query without the topics relation
      let query = supabase
        .from('notes')
        .select(`
          id, 
          content, 
          created_at,
          topic_id
        `)
        .eq('user_id', authUserId)
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
        .eq('user_id', authUserId);

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
