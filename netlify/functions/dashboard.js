const fetch = require('node-fetch');
const { getSupabaseAuthClient, releaseSupabaseConnections } = require('./supabaseClient'); // Import the specific client
const { trackUsageAndCheckLimits } = require('./usage-tracking');
const { hasActivePremiumSubscription } = require('./stripeClient');

// Free tier limits
const FREE_TIER_TOPIC_LIMIT = 5;
const FREE_TIER_BOOKMARK_LIMIT = 50;

// Track active connections to ensure proper cleanup
let activeConnections = 0;
const MAX_CONNECTIONS = 5; // Limit concurrent connections

exports.handler = async (event, context) => {
  // Set a hard timeout for the entire function execution
  const GLOBAL_TIMEOUT = 10000; // 10 seconds max execution time
  let isTimedOut = false;
  const globalTimeoutPromise = new Promise(resolve => {
    setTimeout(() => {
      isTimedOut = true;
      console.log('[dashboard] Global timeout reached, terminating execution');
      resolve({ 
        statusCode: 504, 
        body: JSON.stringify({ error: 'Request timed out. Please try again.' }) 
      });
    }, GLOBAL_TIMEOUT);
  });

  // Execute the actual handler with a race against the timeout
  const actualHandlerPromise = (async () => {
  // Set up context.callbackWaitsForEmptyEventLoop = false to prevent the function from waiting
  if (context && typeof context.callbackWaitsForEmptyEventLoop !== 'undefined') {
    context.callbackWaitsForEmptyEventLoop = false;
    console.log('[dashboard] Set callbackWaitsForEmptyEventLoop = false');
  }

  // Check if we have too many active connections
  if (activeConnections >= MAX_CONNECTIONS) {
    console.log(`[dashboard] Too many active connections: ${activeConnections}/${MAX_CONNECTIONS}`);
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'Service temporarily unavailable due to high load. Please try again.' })
    };
  }
  
  // Track this connection
  activeConnections++;
  console.log(`[dashboard] Active connections: ${activeConnections}`);
  
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  // Add detailed timing for local dev
  const startTime = Date.now();
  let lastStepTime = startTime;
  const logStepTime = (step) => {
    if (process.env.NETLIFY_DEV === 'true') {
      const now = Date.now();
      console.log(`[dashboard] Step ${step}: ${now - lastStepTime}ms since last step, ${now - startTime}ms total`);
      lastStepTime = now;
    }
  };
  logStepTime('Handler Start');

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Extract the JWT token from the Authorization header (case-insensitive)
  const headers = Object.fromEntries(
    Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  const authHeader = headers['authorization'];
  const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  
  // Only log partial token in dev mode for debugging
  if (process.env.NETLIFY_DEV === 'true' && accessToken) {
    const tokenPreview = `${accessToken.substring(0, 10)}...${accessToken.substring(accessToken.length - 5)}`;
    console.log(`[dashboard] Access Token from header (preview): ${tokenPreview}`);
  }

  if (!accessToken) {
    console.error('[dashboard] No access token provided in Authorization header');
    activeConnections--; // Release connection count
    console.log(`[dashboard] Released connection (no token). Remaining: ${activeConnections}`);
    return { statusCode: 401, body: JSON.stringify({ error: 'No access token provided' }) };
  }

  logStepTime('Before Token Verification');
  
  // Use a direct approach to decode and validate the JWT token ourselves
  // Instead of relying on Supabase's auth client which is giving session issues
  const { createClient } = require('@supabase/supabase-js');
  let user;
  
  try {
    // First, validate that the token is properly formatted
    if (!accessToken || typeof accessToken !== 'string' || accessToken.trim() === '') {
      throw new Error('Token is empty or invalid format');
    }
    
    // Use a more defensive approach to decode the JWT token
    const tokenParts = accessToken.split('.');
    if (tokenParts.length !== 3) {
      throw new Error('Token does not have three parts as required for JWT format');
    }
    
    // Simple manual decode of the JWT payload (middle part)
    let payload;
    try {
      const base64Payload = tokenParts[1];
      const base64Decoded = Buffer.from(base64Payload, 'base64').toString('utf8');
      payload = JSON.parse(base64Decoded);
    } catch (parseError) {
      console.error(`[dashboard] Failed to parse JWT payload: ${parseError.message}`);
      throw new Error('Invalid JWT payload format');
    }
    
    logStepTime('After Token Verification');
    
    if (!payload) {
      console.error('[dashboard] Invalid token structure');
      activeConnections--; // Release connection count
      console.log(`[dashboard] Released connection (invalid token). Remaining: ${activeConnections}`);
      return { 
        statusCode: 401, 
        body: JSON.stringify({ error: 'Invalid token. Please log in again.' }) 
      };
    }
    
    // Extract the user information from the decoded token
    // The token payload should contain the user's information
    if (!payload.sub) {
      console.error('[dashboard] No user ID found in token');
      activeConnections--; // Release connection count
      console.log(`[dashboard] Released connection (no user ID in token). Remaining: ${activeConnections}`);
      return { 
        statusCode: 401, 
        body: JSON.stringify({ error: 'User information missing from token. Please log in again.' }) 
      };
    }

    // Success - extract user data from token
    const userId = payload.sub;
    const email = payload.email || 'unknown';
    
    // Create a basic user object from the token payload
    user = {
      id: userId,
      email: email,
      role: payload.role || '',
      aud: payload.aud || ''
    };
    console.log(`[dashboard] Successfully decoded token for user: ${user.id}`);
  } catch (authValidationError) {
    console.error(`[dashboard] Exception during token validation: ${authValidationError.message}`);
    activeConnections--; // Release connection count
    console.log(`[dashboard] Released connection (auth exception). Remaining: ${activeConnections}`);
    return { 
      statusCode: 401, 
      body: JSON.stringify({ error: 'Authentication failed. Please log in again.' }) 
    };
  }
  
  // Extract the authenticated user ID from the validated token
  const authUserId = user.id; // Use this ID for all operations

  // Create a new Supabase client for database operations using the validated token
  // Reuse the createClient we already have in scope
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-client-info': 'dashboard-function'
      }
    },
    // Disable realtime subscriptions to reduce connections
    realtime: {
      enabled: false
    }
  });

  logStepTime('Before Supabase Queries');

  // userIdFromBody can be used for non-critical logging if needed, but not for auth-sensitive ops
  const { action, userId: userIdFromBody, topicName, topicId, emoji, bookmarkUrl, bookmarkId, chatHistory, noteContent, noteId, conversationId, messageId } = JSON.parse(event.body || '{}');
  console.log('Incoming userId from body:', userIdFromBody, 'Authenticated userId from token:', authUserId);

  try {
    if (action === 'addTopic') {
      // Use default book emoji
      const emoji = '📚';

      // Check if user has premium subscription or has not exceeded topic limit
      const hasPremium = await hasActivePremiumSubscription(authUserId);
      
      if (!hasPremium) {
        // Count existing topics for this user
        const { data: existingTopics, error: countError } = await supabase
          .from('topics')
          .select('id', { count: 'exact' })
          .eq('user_id', authUserId);
          
        if (countError) {
          console.error('Error counting topics:', countError);
          return { statusCode: 500, body: JSON.stringify({ error: 'Failed to check topic limits' }) };
        }
        
        // Check if user has reached the free tier limit
        if (existingTopics && existingTopics.length >= FREE_TIER_TOPIC_LIMIT) {
          return { 
            statusCode: 403, 
            body: JSON.stringify({ 
              error: 'Free tier limit reached', 
              message: `You have reached the maximum of ${FREE_TIER_TOPIC_LIMIT} topics allowed on the free plan. Please upgrade to Premium for unlimited topics.`,
              limit: FREE_TIER_TOPIC_LIMIT,
              current: existingTopics.length
            }) 
          };
        }
      }
      
      const { data: newTopic, error: addTopicError } = await supabase
        .from('topics')
        .insert({ name: topicName, user_id: authUserId, emoji })
        .select();
      if (addTopicError) throw addTopicError;
      return { statusCode: 200, body: JSON.stringify({ topicId: newTopic[0].id, emoji }) };
    } else if (action === 'renameTopic') {
      if (!topicId) return { statusCode: 400, body: 'Missing topic ID' };
      if (!topicName) return { statusCode: 400, body: 'Missing topic name' };
      // Rename only, emoji unchanged

      // Check if topic belongs to the user
      const { data: topic, error: topicError } = await supabase
        .from('topics')
        .select('user_id')
        .eq('id', topicId)
        .single();
        
      if (topicError || !topic) {
        console.error(`[RENAME] Error verifying topic or topic not found: ${topicError?.message}`);
        return { statusCode: 404, body: JSON.stringify({ error: 'Topic not found' }) };
      }
      
      if (topic.user_id !== authUserId) {
        console.error(`[RENAME] Permission denied: Topic belongs to ${topic.user_id}, not ${authUserId}`);
        return { statusCode: 403, body: JSON.stringify({ error: 'You do not have permission to rename this topic' }) };
      }

      // Update the topic name
      const { data: updatedTopic, error: updateError } = await supabase
        .from('topics')
        .update({ name: topicName.trim() })
        .eq('id', topicId)
        .eq('user_id', authUserId); // Redundant check, but good for safety
      
      if (updateError) throw updateError;
      console.log(`[RENAME_TOPIC] Successfully renamed topic ${topicId}`);
      return { statusCode: 200, body: JSON.stringify({ message: 'Topic renamed successfully' }) };
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
      
      // Note: Bookmarks are now automatically deleted via ON DELETE CASCADE
      // We'll still delete them here for completeness and in case some bookmarks need RLS-based deletion
      console.log(`[DELETE] Deleting bookmarks for topic ${topicId}`);
      const { error: bookmarkDeleteError } = await supabase.from('bookmarks').delete().eq('topic_id', topicId);
      if (bookmarkDeleteError) console.log(`Note: Bookmark deletion via API returned: ${bookmarkDeleteError.message} - This is expected if relying on CASCADE`);
      
      console.log(`[DELETE] Deleting conversations for topic ${topicId}`);
      const { error: conversationDeleteError } = await supabase.from('conversations').delete().eq('topic_id', topicId);
      if (conversationDeleteError) throw new Error(`Failed to delete conversations: ${conversationDeleteError.message}`);

      console.log(`[DELETE] Deleting notes for topic ${topicId}`);
      const { error: notesDeleteError } = await supabase.from('notes').delete().eq('topic_id', topicId).eq('user_id', authUserId);
      if (notesDeleteError) throw new Error(`Failed to delete notes: ${notesDeleteError.message}`);

      console.log(`[DELETE] Deleting video recommendations for topic ${topicId}`);
      const { error: videoRecommendationsDeleteError } = await supabase.from('topic_video_recommendations').delete().eq('topic_id', topicId);
      if (videoRecommendationsDeleteError) throw new Error(`Failed to delete video recommendations: ${videoRecommendationsDeleteError.message}`);

      console.log(`[DELETE] Deleting summaries for topic ${topicId} (user: ${authUserId})`);
      const { error: summariesDeleteError } = await supabase.from('summaries').delete().eq('topic_id', topicId).eq('user_id', authUserId);
      if (summariesDeleteError) throw new Error(`Failed to delete summaries: ${summariesDeleteError.message}`);

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
      
      // Check if user has premium subscription or has not exceeded bookmark limit
      const hasPremium = await hasActivePremiumSubscription(authUserId);
      
      if (!hasPremium) {
        // Count existing bookmarks for this user
        const { data: existingBookmarks, error: countError } = await supabase
          .from('bookmarks')
          .select('id', { count: 'exact' })
          .in('topic_id', supabase.from('topics').select('id').eq('user_id', authUserId));
          
        if (countError) {
          console.error('Error counting bookmarks:', countError);
          return { statusCode: 500, body: JSON.stringify({ error: 'Failed to check bookmark limits' }) };
        }
        
        // Check if user has reached the free tier limit
        if (existingBookmarks && existingBookmarks.length >= FREE_TIER_BOOKMARK_LIMIT) {
          return { 
            statusCode: 403, 
            body: JSON.stringify({ 
              error: 'Free tier limit reached', 
              message: `You have reached the maximum of ${FREE_TIER_BOOKMARK_LIMIT} bookmarks allowed on the free plan. Please upgrade to Premium for unlimited bookmarks.`,
              limit: FREE_TIER_BOOKMARK_LIMIT,
              current: existingBookmarks.length
            }) 
          };
        }
      }
      
      await supabase
        .from('bookmarks')
        .insert({ topic_id: topicId, url: bookmarkUrl });
      return { statusCode: 200, body: JSON.stringify({ message: 'Bookmark added' }) };
    } else if (action === 'deleteBookmark') {
      if (!bookmarkId) return { statusCode: 400, body: 'Missing bookmark ID' };
      // Delete the bookmark
      const { error: deleteError } = await supabase
        .from('bookmarks')
        .delete()
        .eq('id', bookmarkId);
      if (deleteError) throw deleteError;
      return { statusCode: 200, body: JSON.stringify({ message: 'Bookmark deleted' }) };
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
      logStepTime('After Supabase Queries');

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

      // Fetch key concepts (summary) for specific topic
      const { data: summary, error: summaryError } = await supabase
        .from('summaries')
        .select('id, content, last_source_updated_at')
        .eq('topic_id', topicId)
        .eq('user_id', authUserId)
        .maybeSingle(); // Use maybeSingle as a summary might not exist

      if (summaryError && summaryError.code !== 'PGRST116') { // PGRST116 means no rows found, which is fine here
        console.error(`[GET_TOPIC_DETAILS] Error fetching summary/key concepts: ${summaryError.message}`);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to fetch key concepts: ${summaryError.message}` }) 
        };
      }

      const formattedSummary = summary 
        ? { id: summary.id, content: summary.content, updated_at: summary.last_source_updated_at }
        : null;
      
      console.log(`[GET_TOPIC_DETAILS] Found ${conversations.length} conversations, ${bookmarks.length} bookmarks, ${notes.length} notes, and ${summary ? 'existing key concepts' : 'no existing key concepts'} for topic ${topicId}`);

      logStepTime('Before Data Processing');

      return {
        statusCode: 200,
        body: JSON.stringify({ 
          topic,
          conversations, 
          bookmarks,
          notes: notes || [],
          keyConcepts: formattedSummary
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
    } else if (action === 'updateAvatar') {
      // Check if required fields are present
      const { avatarId, avatarUrl } = JSON.parse(event.body);
      
      console.log('[updateAvatar] Processing avatar update, avatarId:', avatarId, 'avatarUrl provided:', !!avatarUrl);
      
      if (!avatarId && !avatarUrl) {
        console.error('[updateAvatar] Missing required field avatarId or avatarUrl');
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
      }
      
      const finalAvatarUrl = avatarUrl || `../assets/avatars/${avatarId}.png`;
      console.log(`[updateAvatar] Updating avatar for user ${authUserId} to ${finalAvatarUrl}`);
      
      try {
        console.log('[updateAvatar] Updating avatar for user:', authUserId);
        
        // Convert the avatarId to a number
        const avatarIdNum = parseInt(avatarId, 10);
        
        if (isNaN(avatarIdNum) || avatarIdNum < 1 || avatarIdNum > 4) {
          console.error('[updateAvatar] Invalid avatar ID:', avatarId);
          return { statusCode: 400, body: JSON.stringify({ error: 'Invalid avatar ID' }) };
        }
        
        // First check if user_settings record exists
        const { data: existingSettings, error: checkError } = await supabase
          .from('user_settings')
          .select('id')
          .eq('user_id', authUserId)
          .maybeSingle();
        
        let result;
        
        if (checkError) {
          console.error('[updateAvatar] Error checking settings:', checkError.message);
          return { statusCode: 500, body: JSON.stringify({ error: `Error checking settings: ${checkError.message}` }) };
        }
        
        // Insert or update based on whether record exists
        if (!existingSettings) {
          console.log('[updateAvatar] No existing settings found, creating new record with avatar_id:', avatarIdNum);
          // Create new record
          result = await supabase
            .from('user_settings')
            .insert([{
              user_id: authUserId,
              avatar_id: avatarIdNum,
              created_at: new Date().toISOString()
            }]);
        } else {
          console.log('[updateAvatar] Updating existing settings record with avatar_id:', avatarIdNum);
          // Update existing record
          result = await supabase
            .from('user_settings')
            .update({
              avatar_id: avatarIdNum,
              updated_at: new Date().toISOString()
            })
            .eq('user_id', authUserId);
        }
        
        if (result.error) {
          console.error('[updateAvatar] Error saving avatar:', result.error.message);
          return { statusCode: 500, body: JSON.stringify({ error: `Failed to save avatar: ${result.error.message}` }) };
        }
        
        // Map avatar ID to URL
        const avatarMap = {
          1: '../assets/avatars/default.png',
          2: '../assets/avatars/zara.png',
          3: '../assets/avatars/luna.png',
          4: '../assets/avatars/max.png'
        };
        const avatarUrl = avatarMap[avatarIdNum] || '../assets/avatars/default.png';
        
        console.log('[updateAvatar] Successfully saved avatar with ID:', avatarIdNum);
        return { statusCode: 200, body: JSON.stringify({ avatarId: avatarIdNum, avatarUrl: avatarUrl }) };
      } catch (e) {
        console.error('[updateAvatar] Unexpected error:', e.message || e);
        return { statusCode: 500, body: JSON.stringify({ error: `Unexpected error: ${e.message || 'Unknown error'}` }) };
      }
      
      // This code is now unreachable since we're returning directly from the try block above
      // Keeping this comment for documentation purposes
    } else if (action === 'generateKeyConcepts') {
      if (!topicId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing topicId' }) };
      }
      console.log(`[generateKeyConcepts] Starting for topic ${topicId}, user ${authUserId}`);

      // --- CACHE CHECK: Return existing summary if <24h old ---
      const { data: existingSummary, error: existingErr } = await supabase
        .from('summaries')
        .select('id, content, last_source_updated_at')
        .eq('topic_id', topicId)
        .eq('user_id', authUserId)
        .maybeSingle();
      if (!existingErr && existingSummary) {
        const ageHours = (new Date() - new Date(existingSummary.last_source_updated_at)) / (1000 * 60 * 60);
        if (ageHours < 24) {
          console.log(`[generateKeyConcepts] Serving cached summary for topic ${topicId}`);
          return {
            statusCode: 200,
            body: JSON.stringify({
              keyConcepts: {
                id: existingSummary.id,
                content: existingSummary.content,
                updated_at: existingSummary.last_source_updated_at
              }
            })
          };
        }
      }

      try {
        // 1. Fetch topic name
        const { data: topicData, error: topicError } = await supabase
          .from('topics')
          .select('name')
          .eq('id', topicId)
          .eq('user_id', authUserId)
          .single();

        if (topicError || !topicData) {
          console.error(`[generateKeyConcepts] Error fetching topic ${topicId}:`, topicError?.message);
          return { statusCode: 404, body: JSON.stringify({ error: 'Topic not found or not authorized' }) };
        }
        const topicName = topicData.name;

        // 2. Fetch related data (conversations, notes, bookmarks)
        const [convResult, notesResult, bookmarksResult] = await Promise.all([
          supabase.from('conversations').select('content').eq('topic_id', topicId), // Conversations only have topic_id, no user_id
          supabase.from('notes').select('content').eq('topic_id', topicId).eq('user_id', authUserId),
          supabase.from('bookmarks').select('url').eq('topic_id', topicId) // Bookmarks also only have topic_id, no user_id
        ]);

        if (convResult.error) throw new Error(`Failed to fetch conversations: ${convResult.error.message}`);
        if (notesResult.error) throw new Error(`Failed to fetch notes: ${notesResult.error.message}`);
        if (bookmarksResult.error) throw new Error(`Failed to fetch bookmarks: ${bookmarksResult.error.message}`);

        const conversations = convResult.data || [];
        const notes = notesResult.data || [];
        const bookmarks = bookmarksResult.data || [];

        // 3. Construct prompt for OpenAI
        let promptContent = `As a world-class teacher and mentor, your task is to distill the core information from the provided topic name, conversations, notes, and bookmarks. Please generate a concise set of key concepts, presented as clear and insightful bullet points. Each bullet point should capture a fundamental idea or learning related to the topic, explained in a way that is easy to understand and remember.\n\nTopic Name: ${topicName}\n\n`;

        if (conversations.length > 0) {
          promptContent += "Conversations (excerpts):\n";
          conversations.forEach(c => {
            const excerpt = c.content ? (c.content.length > 200 ? c.content.substring(0, 200) + '...' : c.content) : "[empty conversation]";
            promptContent += `- ${excerpt}\n`;
          });
        } else {
          promptContent += "Conversations: No conversations available for this topic.\n";
        }

        if (notes.length > 0) {
          promptContent += "\nNotes (excerpts):\n";
          notes.forEach(n => {
            const excerpt = n.content ? (n.content.length > 200 ? n.content.substring(0, 200) + '...' : n.content) : "[empty note]";
            promptContent += `- ${excerpt}\n`;
          });
        } else {
          promptContent += "\nNotes: No notes available for this topic.\n";
        }

        if (bookmarks.length > 0) {
          promptContent += "\nBookmarks:\n";
          bookmarks.forEach(b => { promptContent += `- ${b.url}\n`; });
        } else {
          promptContent += "\nBookmarks: No bookmarks available for this topic.\n";
        }
        
        promptContent += "\nPlease present these key concepts as a series of bullet points, starting each with a hyphen (-) or an asterisk (*). Ensure each concept is distinct and contributes to a comprehensive understanding of the topic from an expert teacher's perspective.";

        // 4. Call OpenAI API
        const openaiApiKey = process.env.OPENAI_API_KEY;
        if (!openaiApiKey) {
          console.error('[generateKeyConcepts] OPENAI_API_KEY is not set.');
          return { statusCode: 500, body: JSON.stringify({ error: 'OpenAI API key not configured.' }) };
        }

        const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiApiKey}`
          },
          body: JSON.stringify({
            model: 'gpt-4.1-nano',
            messages: [
              { role: 'system', content: 'You are an expert learning assistant.' },
              { role: 'user', content: promptContent }
            ],
            max_completion_tokens: 1500 // Increased slightly, adjust as needed
          })
        });

        if (!openaiResponse.ok) {
          const errorBody = await openaiResponse.text();
          console.error(`[generateKeyConcepts] OpenAI API error: ${openaiResponse.status}`, errorBody);
          throw new Error(`OpenAI API request failed with status ${openaiResponse.status}: ${errorBody}`);
        }

        const openAIResult = await openaiResponse.json();
        const keyConceptsContent = openAIResult.choices[0]?.message?.content?.trim();

        if (!keyConceptsContent) {
          console.error('[generateKeyConcepts] No content received from OpenAI.');
          throw new Error('Failed to generate key concepts from OpenAI: No content.');
        }

        // 5. Save/Update key concepts in 'summaries' table
        let summaryEntry;
        const now = new Date().toISOString();

        const { data: existingSummary, error: existingSummaryError } = await supabase
          .from('summaries')
          .select('id, created_at') // Select created_at to preserve it if entry exists
          .eq('topic_id', topicId)
          .eq('user_id', authUserId)
          .maybeSingle();

        if (existingSummaryError) {
          console.error(`[generateKeyConcepts] Error checking for existing summary: ${existingSummaryError.message}`);
          // Not throwing, will attempt to insert if this failed but might lead to duplicates if RLS/constraint is missing
        }

        let upsertData;
        if (existingSummary) {
          // Prepare for UPDATE
          upsertData = {
            id: existingSummary.id, // Crucial for upsert to know which record to update
            topic_id: topicId,
            user_id: authUserId,
            content: keyConceptsContent,
            last_source_updated_at: now,
            created_at: existingSummary.created_at // Preserve original creation date
          };
        } else {
          // Prepare for INSERT
          upsertData = {
            topic_id: topicId,
            user_id: authUserId,
            content: keyConceptsContent,
            last_source_updated_at: now, // Added comma here
            // created_at will be set by default by db for new entries
          };
        }

        console.log(`[generateKeyConcepts] Attempting to upsert summary with data: ${JSON.stringify(upsertData)}`); // DEBUG LOG

        const { data: savedKeyConcepts, error: saveError } = await supabase
          .from('summaries')
          .upsert(upsertData)
          .select('id, content, last_source_updated_at')
          .single(); // Expecting a single record back from upsert

        if (saveError) {
          console.error(`[generateKeyConcepts] Error saving summary: ${saveError.message} - Details: ${JSON.stringify(saveError)}`);
          throw new Error(`Failed to save new key concepts: ${saveError.message}`);
        }
        summaryEntry = savedKeyConcepts; // Assign the result to summaryEntry
        
        console.log(`[generateKeyConcepts] Successfully generated and saved for topic ${topicId}`);
        return {
          statusCode: 200,
          body: JSON.stringify({
            keyConcepts: {
              id: summaryEntry.id,
              content: summaryEntry.content,
              // Frontend expects 'updated_at', use last_source_updated_at for this
              updated_at: summaryEntry.last_source_updated_at 
            }
          })
        };

      } catch (error) {
        console.error(`[generateKeyConcepts] Error for topic ${topicId}:`, error.message, error.stack);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ 
            error: `Failed to generate key concepts: ${error.message}`,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
          })
        };
      }
    } else if (action === 'getAvatar') {
      try {
        console.log('[getAvatar] Getting avatar for user:', authUserId);
        
        // Get user settings from the user_settings table
        const { data, error } = await supabase
          .from('user_settings')
          .select('avatar_id')
          .eq('user_id', authUserId)
          .maybeSingle();
        
        if (error) {
          console.error('[getAvatar] Error fetching avatar from settings:', error.message);
          return { statusCode: 200, body: JSON.stringify({ avatarId: 1, avatarUrl: '../assets/avatars/default.png' }) };
        }
        
        // If no data or no avatar_id set, return default
        const avatarId = data?.avatar_id || 1;
        console.log('[getAvatar] Found avatar ID in settings:', avatarId);
        
        // Map avatar ID to URL
        const avatarMap = {
          1: '../assets/avatars/default.png',
          2: '../assets/avatars/zara.png',
          3: '../assets/avatars/luna.png',
          4: '../assets/avatars/max.png'
        };
        const avatarUrl = avatarMap[avatarId] || '../assets/avatars/default.png';
        console.log(`[getAvatar] Fetched avatar for user ${authUserId}: ${avatarUrl}`);
        return { statusCode: 200, body: JSON.stringify({ avatarId: avatarId, avatarUrl: avatarUrl }) };
      } catch (e) {
        console.error('[getAvatar] Unexpected error:', e.message || e);
        return { statusCode: 200, body: JSON.stringify({ avatarUrl: '../assets/avatars/default.png' }) };
      }
    } else if (action === 'updateThemePreference') {
      const { theme } = JSON.parse(event.body || '{}');
      
      if (!theme || (theme !== 'light' && theme !== 'dark')) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid theme preference' }) };
      }
      
      console.log(`[UPDATE_THEME] Updating theme preference for user ${authUserId} to ${theme}`);
      
      // Check if user_preferences table exists and has a row for this user
      const { data: existingPrefs, error: prefsError } = await supabase
        .from('user_preferences')
        .select('id')
        .eq('user_id', authUserId)
        .single();
      
      if (prefsError && prefsError.code !== 'PGRST116') { // PGRST116 is "not found" error
        console.error(`[UPDATE_THEME] Error checking preferences: ${prefsError.message}`);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to check user preferences' }) };
      }
      
      let updateResult;
      
      if (!existingPrefs) {
        // Create new preferences record
        const { data, error } = await supabase
          .from('user_preferences')
          .insert({
            user_id: authUserId,
            theme_preference: theme,
            updated_at: new Date().toISOString()
          });
          
        updateResult = { data, error };
      } else {
        // Update existing preferences
        const { data, error } = await supabase
          .from('user_preferences')
          .update({
            theme_preference: theme,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', authUserId);
          
        updateResult = { data, error };
      }
      
      if (updateResult.error) {
        console.error(`[UPDATE_THEME] Error saving preference: ${updateResult.error.message}`);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save theme preference' }) };
      }
      
      return { statusCode: 200, body: JSON.stringify({ message: 'Theme preference updated', theme }) };
    } else if (action === 'updateEmoji') {
      if (!topicId || !emoji) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing topic ID or emoji' }) };
      }
      // Verify ownership
      const { data: topic, error: verifyError } = await supabase
        .from('topics')
        .select('user_id')
        .eq('id', topicId)
        .single();
      if (verifyError || !topic) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Topic not found' }) };
      }
      if (topic.user_id !== authUserId) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Permission denied' }) };
      }
      const { error: updateError2 } = await supabase
        .from('topics')
        .update({ emoji })
        .eq('id', topicId);
      if (updateError2) throw updateError2;
      return { statusCode: 200, body: JSON.stringify({ message: 'Emoji updated' }) };
    } else {
      logStepTime('After Supabase Queries');

      // Get topics with conversation, bookmark, and note counts
      const { data: rawTopics, error: topicsError } = await supabase
        .from('topics')
        .select(`
          id,
          name,
          user_id,
          emoji,
          conversations:conversations!conversations_topic_id_fkey(count),
          bookmarks:bookmarks!bookmarks_topic_id_fkey(count),
          notes:notes!notes_topic_id_fkey(count)
        `)
        .eq('user_id', authUserId);

      if (topicsError) {
        console.error(`[GET_TOPICS_WITH_COUNTS] Error fetching topics:`, topicsError);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: `Failed to fetch topics with counts: ${topicsError.message}` }) 
        };
      }
      
      logStepTime('Before Data Processing');

      const transformedTopics = rawTopics.map(topic => ({
        id: topic.id,
        name: topic.name,
        user_id: topic.user_id,
        emoji: topic.emoji || '📚', // Default emoji if none is set
        conversation_count: topic.conversations ? topic.conversations[0]?.count || 0 : 0,
        bookmark_count: topic.bookmarks ? topic.bookmarks[0]?.count || 0 : 0,
        note_count: topic.notes ? topic.notes[0]?.count || 0 : 0,
      }));
      
      console.log(`[GET_TOPICS_WITH_COUNTS] Found ${transformedTopics.length} topics with their counts`);

      logStepTime('After Data Processing');

      // Decrement active connections before returning successfully
      activeConnections--;
      console.log(`[dashboard] Released connection (success). Remaining: ${activeConnections}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ topics: transformedTopics })
      };
    }
  } catch (error) {
    console.error('Error in dashboard function:', error.message, error.stack);
    // Release connection on error
    activeConnections--;
    console.log(`[dashboard] Released connection (error). Remaining: ${activeConnections}`);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ 
        error: `Server error: ${error.message}`, 
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }) 
    };
  } finally {
    // Always decrement the active connection count and release Supabase connections
    if (activeConnections > 0) { // Ensure we don't go negative
      activeConnections--;
    }
    console.log(`[dashboard] End of handler, active connections: ${activeConnections}`);
    
    // Explicitly release Supabase connections
    try {
      if (typeof releaseSupabaseConnections === 'function') {
        releaseSupabaseConnections();
      }
      
      // Additional explicit cleanup of local client instances
      if (supabase?.auth) {
        supabase.auth.signOut().catch(() => {});
      }
    } catch (releaseError) {
      console.log(`[dashboard] Error releasing Supabase connections: ${releaseError.message}`);
    }
  }
  
  // If execution somehow reaches here without returning a response
  activeConnections--;
  console.log(`[dashboard] Released connection (final). Remaining: ${activeConnections}`);
  return {
    statusCode: 500,
    body: JSON.stringify({ error: 'Unhandled execution path in dashboard handler' })
  };
  })();
  
  // Race between the actual handler and the global timeout
  return Promise.race([actualHandlerPromise, globalTimeoutPromise]);
};
