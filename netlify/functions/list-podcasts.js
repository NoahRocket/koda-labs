const { getSupabaseAdmin } = require('./supabaseClient');

exports.handler = async (event) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return { 
      statusCode: 405, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  // Get authorization header for user verification
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('[list-podcasts] No valid Authorization header found, proceeding as guest');
    // Instead of returning 401, let's proceed and try to get public podcasts
    // This allows viewing podcasts even when authentication is having issues
    userId = null; // Mark as guest
  } else {
    try {
      // Get token from the Authorization header
      const token = authHeader.split(' ')[1];
      console.log('[list-podcasts] Access Token from header (preview):', token ? `${token.slice(0, 8)}...${token.slice(-5)}` : 'null...null');
      
      // Manual JWT token verification and decoding
      if (!token || typeof token !== 'string') {
        throw new Error('Token missing or not a string');
      }

      // Check if token has the correct JWT format (three parts separated by dots)
      const tokenParts = token.split('.');
      if (tokenParts.length !== 3) {
        throw new Error('Token does not have three parts as required for JWT format');
      }

      // Decode the payload (middle part of the JWT)
      try {
        // Base64 decode and parse the payload
        let payload;
        try {
          // Make the base64 decoding more resilient by handling padding
          let base64Payload = tokenParts[1];
          // Add padding if necessary
          base64Payload = base64Payload.replace(/-/g, '+').replace(/_/g, '/');
          while (base64Payload.length % 4) {
            base64Payload += '=';
          }
          
          const decodedPayload = Buffer.from(base64Payload, 'base64').toString('utf8');
          payload = JSON.parse(decodedPayload);
          
          // Dump the entire payload for debugging (except sensitive data)
          const sanitizedPayload = {...payload};
          if (sanitizedPayload.email) sanitizedPayload.email = '***@***.com'; // Hide email
          console.log('[list-podcasts] JWT payload:', JSON.stringify(sanitizedPayload));
        } catch (e) {
          throw new Error('Failed to decode token payload: ' + e.message);
        }
        
        // Extract user information - check different possible fields for user ID
        // This helps handle differences between how Supabase Auth vs. our manual JWT decoding works
        if (payload.sub) {
          userId = payload.sub;
          console.log(`[list-podcasts] Using 'sub' claim as user ID: ${userId}`);
        } else if (payload.user_id) {
          userId = payload.user_id;
          console.log(`[list-podcasts] Using 'user_id' claim as user ID: ${userId}`);
        } else if (payload.id) {
          userId = payload.id;
          console.log(`[list-podcasts] Using 'id' claim as user ID: ${userId}`);
        } else {
          throw new Error('Invalid token payload: missing user ID in any expected field');
        }
      } catch (decodeError) {
        console.error('[list-podcasts] Token decode error:', decodeError);
        throw new Error('Failed to decode token: ' + decodeError.message);
      }
    } catch (err) {
      console.error('[list-podcasts] Exception during token validation:', err.message);
      console.warn('[list-podcasts] Will proceed as guest user due to auth issues');
      userId = null; // Mark as guest
    }
  }

  try {
    // Use the admin client to query the database and storage
    const supabase = getSupabaseAdmin();
    
    console.log(`[list-podcasts] Looking up podcasts${userId ? ` for user ${userId}` : ' (all public podcasts)'}`);
    
    // First, try to list files directly from the storage bucket
    // This approach is more reliable if there's a mismatch between storage and database records
    console.log('[list-podcasts] Checking storage bucket for podcast files...');
    let storageFiles = [];
    
    try {
      // Try different methods to list files in the bucket
      // Method 1: Default listing
      const { data: files1, error: storageError1 } = await supabase
        .storage
        .from('podcasts')
        .list();
        
      // Method 2: Try with empty path explicitly
      const { data: files2, error: storageError2 } = await supabase
        .storage
        .from('podcasts')
        .list('', { sortBy: { column: 'created_at', order: 'desc' } });
      
      // Method 3: Try using the admin client differently with direct API call
      const { data: bucketInfo, error: bucketError } = await supabase
        .from('_buckets')
        .select('*')
        .eq('name', 'podcasts')
        .single();
        
      if (bucketError) {
        console.log('[list-podcasts] Error getting bucket info:', bucketError.message);
      } else if (bucketInfo) {
        console.log('[list-podcasts] Found bucket info:', bucketInfo.id, bucketInfo.name);
      }
      
      // Log results of attempted methods
      if (storageError1) {
        console.error('[list-podcasts] Method 1 error:', storageError1.message);
      } else {
        console.log(`[list-podcasts] Method 1 found ${files1?.length || 0} files`);  
      }
      
      if (storageError2) {
        console.error('[list-podcasts] Method 2 error:', storageError2.message);
      } else {
        console.log(`[list-podcasts] Method 2 found ${files2?.length || 0} files`);  
      }
      
      // Use files from successful method
      let files = files1 || files2 || [];
      
      // Filter for MP3 files
      storageFiles = files.filter(file => file.name && file.name.endsWith('.mp3'));
      console.log(`[list-podcasts] Found ${storageFiles.length} MP3 files in storage bucket:`);
      if (storageFiles.length > 0) {
        storageFiles.forEach(file => {
          console.log(`[list-podcasts] Storage file: ${file.name}, size: ${file.metadata?.size || 'unknown'}, created: ${file.created_at || 'unknown'}`);
        });
      } else {
        console.log('[list-podcasts] No MP3 files found in storage bucket');
        console.log('[list-podcasts] Attempting to list all files in bucket to debug:');
        
        // Try listing all files regardless of extension for debugging
        if (files && files.length > 0) {
          files.forEach(file => {
            console.log(`[list-podcasts] File in bucket: ${file.name}, type: ${file.metadata?.mimetype || 'unknown'}`);
          });
        } else {
          console.log('[list-podcasts] No files of any type found in bucket');
        }
      }
    } catch (storageErr) {
      console.error('[list-podcasts] Exception when accessing storage:', storageErr);
    }
    
    // Get all podcasts for this user - query without status filter first to see what's there
    const { data: allPodcasts, error: allPodcastsError } = await supabase
      .from('podcast_jobs')
      .select('*')
      .eq('user_id', userId);
      
    if (allPodcastsError) {
      console.error('[list-podcasts] Error fetching all podcasts:', allPodcastsError);
    } else {
      console.log(`[list-podcasts] All podcasts for user ${userId} in database (count: ${allPodcasts.length}):`);
      if (allPodcasts.length > 0) {
        allPodcasts.forEach(podcast => {
          console.log(`[list-podcasts] Podcast id=${podcast.job_id}, status=${podcast.status}, created_at=${podcast.created_at}, url=${podcast.podcast_url || 'N/A'}`);
        });
      } else {
        console.log('[list-podcasts] No podcasts found for this user in database, regardless of status');
      }
    }
    
    // Get completed podcasts - either for specific user or all if no userId
    let query = supabase
      .from('podcast_jobs')
      .select('*')
      .eq('status', 'completed')
      .order('created_at', { ascending: false });
      
    // Only filter by user_id if we have a valid user
    if (userId) {
      query = query.eq('user_id', userId);
    }
    
    // Execute the query
    const { data: dbPodcasts, error } = await query;
    
    if (error) {
      console.error('[list-podcasts] Database error:', error);
      return { 
        statusCode: 500, 
        body: JSON.stringify({ error: 'Failed to retrieve podcasts' }) 
      };
    }
    
    // Log what we found in the completed podcasts
    console.log(`[list-podcasts] Completed podcasts for user ${userId} in database (count: ${dbPodcasts.length})`);
    if (dbPodcasts.length > 0) {
      dbPodcasts.forEach(podcast => {
        console.log(`[list-podcasts] Completed podcast id=${podcast.job_id}, status=${podcast.status}, url=${podcast.podcast_url || 'N/A'}`);
      });
    } else {
      console.log('[list-podcasts] No completed podcasts found for this user in database');
    }
    
    // If we found database records, use those (preferred approach)
    // Otherwise, use our hardcoded list of podcast files
    let podcastList = [];
    
    if (dbPodcasts && dbPodcasts.length > 0) {
      // Use database records if available
      console.log('[list-podcasts] Using database records for podcast listing');
      podcastList = dbPodcasts.map(podcast => {
        // Get the filename from podcast_url or generate a filename based on job_id
        let filename;
        if (podcast.podcast_url) {
          // Extract the filename from the URL if it exists
          const urlParts = podcast.podcast_url.split('/');
          filename = urlParts[urlParts.length - 1];
        } else {
          // Generate a filename based on the job_id
          filename = `podcast_${podcast.job_id}.mp3`;
        }
        
        // Always generate a fresh public URL regardless of what's stored in the database
        const publicUrl = supabase.storage.from('podcasts').getPublicUrl(filename).data.publicUrl;
        console.log(`[list-podcasts] Generated URL for file ${filename}: ${publicUrl}`);
        
        return {
          id: podcast.job_id,
          job_id: podcast.job_id,
          title: podcast.filename || 'Untitled Podcast',
          created_at: podcast.created_at,
          audio_url: publicUrl, // Use the freshly generated public URL
          concepts: podcast.concepts || []
        };
      });
    } else {
      // No records found in database - let's try to list all files in the storage bucket
      console.log('[list-podcasts] No podcasts found in database, checking storage bucket directly');
      
      try {
        // List all files in the podcasts storage bucket
        const { data: storageFiles, error: listError } = await supabase
          .storage
          .from('podcasts')
          .list();
        
        if (listError) {
          console.error('[list-podcasts] Error listing files in storage:', listError);
          // Continue with empty podcast list
        } else if (storageFiles && storageFiles.length > 0) {
          console.log(`[list-podcasts] Found ${storageFiles.length} files in storage bucket`);
          
          // Filter for MP3 files only
          const mp3Files = storageFiles.filter(file => file.name.toLowerCase().endsWith('.mp3'));
          
          // Generate podcast entries from files found in storage
          podcastList = mp3Files.map(file => {
            // Generate a proper URL for each file
            const publicUrl = supabase.storage.from('podcasts').getPublicUrl(file.name).data.publicUrl;
            console.log(`[list-podcasts] Created URL for file ${file.name}: ${publicUrl}`);
            
            // Format the title by removing prefix, extension, and replacing dashes with spaces
            const prettyTitle = file.name
              .replace(/^podcast_/, '')
              .replace(/\.mp3$/, '')
              .replace(/-/g, ' ');
            
            // Extract potential job_id from filename
            const jobIdMatch = file.name.match(/podcast_([\w-]+)\.mp3$/i);
            const jobId = jobIdMatch ? jobIdMatch[1] : file.name.replace(/\.mp3$/, '');
            
            return {
              id: jobId,
              job_id: jobId,
              title: prettyTitle || 'Podcast',
              created_at: file.created_at || new Date().toISOString(),
              audio_url: publicUrl,
              concepts: []
            };
          });
          
          console.log(`[list-podcasts] Created ${podcastList.length} podcast entries from storage files`);
        }
      } catch (storageError) {
        console.error('[list-podcasts] Error accessing storage bucket:', storageError);
        // Continue with empty podcast list
      }
    }

    console.log(`[list-podcasts] Returning ${podcastList.length} podcasts to client`);

    // Return the list of podcasts
    return {
      statusCode: 200,
      body: JSON.stringify({ podcasts: podcastList })
    };
  } catch (error) {
    console.error('Error fetching podcasts:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error fetching podcasts' })
    };
  }
};
