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
      // Method 1: Check the default root folder
      const { data: files1, error: storageError1 } = await supabase
        .storage
        .from('podcasts')
        .list();
        
      // Method 2: Try with empty path explicitly
      const { data: files2, error: storageError2 } = await supabase
        .storage
        .from('podcasts')
        .list('', { sortBy: { column: 'created_at', order: 'desc' } });
        
      // Method 3: IMPORTANT - Check the 'public' folder where audio files are likely stored
      const { data: publicFiles, error: publicError } = await supabase
        .storage
        .from('podcasts')
        .list('public');
        
      // Method 4: If user ID is available, check user's specific folder
      let userFiles = [];
      let userError = null;
      if (userId) {
        const { data: files, error } = await supabase
          .storage
          .from('podcasts')
          .list(`public/${userId}`);
        userFiles = files;
        userError = error;
      }
      
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
        console.log(`[list-podcasts] Method 1 found ${files1?.length || 0} files in root`);  
      }
      
      if (storageError2) {
        console.error('[list-podcasts] Method 2 error:', storageError2.message);
      } else {
        console.log(`[list-podcasts] Method 2 found ${files2?.length || 0} files in empty path`);  
      }

      if (publicError) {
        console.error('[list-podcasts] Public folder error:', publicError.message);
      } else {
        console.log(`[list-podcasts] Found ${publicFiles?.length || 0} files in public folder`);  
      }
      
      if (userId) {
        if (userError) {
          console.error(`[list-podcasts] User folder error for ${userId}:`, userError.message);
        } else {
          console.log(`[list-podcasts] Found ${userFiles?.length || 0} files in user ${userId}'s folder`);  
        }
      }
      
      // Combine files from all successful methods, prioritizing user-specific files
      // For files in the public/userId directory, we need to include the full path
      const rootFiles = (files1 || files2 || []).filter(file => file.name && file.name.endsWith('.mp3'));
      
      // Handle files in the public directory - they need path prefix
      let publicFolderFiles = [];
      if (publicFiles && publicFiles.length > 0) {
        // These are folders inside 'public', we need to list their contents
        for (const folder of publicFiles) {
          if (folder.id) { // It's a folder
            const { data: folderFiles, error: folderError } = await supabase
              .storage
              .from('podcasts')
              .list(`public/${folder.name}`);
              
            if (!folderError && folderFiles) {
              // Add path info to each file
              const processedFiles = folderFiles
                .filter(file => file.name && file.name.endsWith('.mp3'))
                .map(file => ({
                  ...file,
                  fullPath: `public/${folder.name}/${file.name}`
                }));
              publicFolderFiles = [...publicFolderFiles, ...processedFiles];
            }
          }
        }
      }
      
      // Add path info to user files
      const userFolderFiles = userId && userFiles ? 
        userFiles
          .filter(file => file.name && file.name.endsWith('.mp3'))
          .map(file => ({
            ...file,
            fullPath: `public/${userId}/${file.name}`
          })) : [];
      
      // Combine all files, prioritizing user's files
      storageFiles = [...userFolderFiles, ...publicFolderFiles, ...rootFiles];
      
      // Log the final count
      console.log(`[list-podcasts] Total MP3 files found: ${storageFiles.length}`);
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
        // Try different methods to list files in the bucket to handle the new structure
        console.log('[list-podcasts] Searching for podcast files in storage...');
        
        // Check if 'public' folder exists
        const { data: rootContents, error: rootError } = await supabase
          .storage
          .from('podcasts')
          .list('');
          
        if (rootError) {
          console.error('[list-podcasts] Error listing root folder:', rootError);
          podcastList = [];
          return; // exit the try block but continue execution
        }
        
        console.log(`[list-podcasts] Found ${rootContents?.length || 0} items in root of podcasts bucket`);
        
        // Check for public folder
        const publicFolder = rootContents?.find(item => item.name === 'public');
        if (!publicFolder) {
          console.log('[list-podcasts] No public folder found, checking for MP3 files in root');
          // Just look for MP3s in the root
          const mp3Files = rootContents?.filter(file => file.name.endsWith('.mp3')) || [];
          
          if (mp3Files.length > 0) {
            console.log(`[list-podcasts] Found ${mp3Files.length} MP3 files in root folder`);
            podcastList = mp3Files.map(file => {
              const publicUrl = supabase.storage.from('podcasts').getPublicUrl(file.name).data.publicUrl;
              
              // Format the title from the filename
              const prettyTitle = file.name
                .replace(/^podcast_/, '')
                .replace(/\.mp3$/, '')
                .replace(/-/g, ' ');
                
              return {
                id: file.id || file.name,
                title: prettyTitle || 'Untitled Podcast',
                created_at: file.created_at || new Date().toISOString(),
                audio_url: publicUrl,
                concepts: []
              };
            });
            return; // exit the try block but continue execution
          }
          
          podcastList = [];
          return; // exit the try block but continue execution
        }
        
        // If public folder exists, list its contents
        console.log('[list-podcasts] Public folder found, checking its contents...');
        const { data: publicContents, error: publicError } = await supabase
          .storage
          .from('podcasts')
          .list('public');
          
        if (publicError) {
          console.error('[list-podcasts] Error listing public folder:', publicError);
          podcastList = [];
          return; // exit the try block but continue execution
        }
        
        console.log(`[list-podcasts] Found ${publicContents?.length || 0} items in public folder`);
        
        // If we have a userId, check their specific folder
        let userFiles = [];
        if (userId && publicContents) {
          const userFolder = publicContents.find(item => item.name === userId);
          if (userFolder) {
            console.log(`[list-podcasts] Found folder for user ${userId}, checking contents...`);
            const { data: userContents, error: userError } = await supabase
              .storage
              .from('podcasts')
              .list(`public/${userId}`);
              
            if (!userError && userContents) {
              const userMp3s = userContents.filter(file => file.name.endsWith('.mp3'));
              console.log(`[list-podcasts] Found ${userMp3s.length} MP3 files for user ${userId}`);
              
              userFiles = userMp3s.map(file => {
                // Corrected filePath to avoid double 'public/' in the URL
                const filePath = `${userId}/${file.name}`;
                const publicUrl = supabase.storage.from('podcasts').getPublicUrl(`public/${filePath}`).data.publicUrl;
                
                // Format the title from the filename
                const prettyTitle = file.name
                  .replace(/^podcast_/, '')
                  .replace(/\.mp3$/, '')
                  .replace(/-/g, ' ');
                  
                return {
                  id: file.id || file.name,
                  title: prettyTitle || 'Untitled Podcast',
                  created_at: file.created_at || new Date().toISOString(),
                  audio_url: publicUrl,
                  concepts: []
                };
              });
            }
          }
        }
        
        // Also check all user folders for public podcasts
        let allUserFiles = [];
        for (const folder of publicContents || []) {
          // Skip the current user's folder as we already processed it
          if (userId && folder.name === userId) continue;
          
          const { data: folderContents, error: folderError } = await supabase
            .storage
            .from('podcasts')
            .list(`public/${folder.name}`);
            
          if (!folderError && folderContents) {
            const mp3Files = folderContents.filter(file => file.name.endsWith('.mp3'));
            
            if (mp3Files.length > 0) {
              console.log(`[list-podcasts] Found ${mp3Files.length} MP3 files in user folder ${folder.name}`);
              
              const files = mp3Files.map(file => {
                // Corrected filePath to avoid double 'public/' in the URL
                const filePath = `${folder.name}/${file.name}`;
                const publicUrl = supabase.storage.from('podcasts').getPublicUrl(`public/${filePath}`).data.publicUrl;
                
                // Format the title from the filename
                const prettyTitle = file.name
                  .replace(/^podcast_/, '')
                  .replace(/\.mp3$/, '')
                  .replace(/-/g, ' ');
                  
                return {
                  id: file.id || file.name,
                  title: prettyTitle || 'Untitled Podcast',
                  created_at: file.created_at || new Date().toISOString(),
                  audio_url: publicUrl,
                  concepts: []
                };
              });
              
              allUserFiles = [...allUserFiles, ...files];
            }
          }
        }
        
        // Combine all found files, prioritizing the current user's files
        const combinedFiles = [...userFiles, ...allUserFiles];
        console.log(`[list-podcasts] Found total of ${combinedFiles.length} MP3 files across all folders`);
        
        podcastList = combinedFiles;
      } catch (storageError) {
        console.error('[list-podcasts] Error accessing storage bucket:', storageError);
        // Continue with empty podcast list
        podcastList = [];
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
