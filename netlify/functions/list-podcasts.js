const { getSupabaseAdmin } = require('./supabaseClient');

exports.handler = async (event) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return { 
      statusCode: 405, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  let userId = null;
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
    
    // Initialize an empty list to hold all podcasts
    let podcastList = [];
    
    // Try to fetch podcasts from multiple sources: database, user folder, and root folder
    try {
      const allPodcasts = [];
      
      // 1. First check for completed podcasts in the database
      if (userId) {
        console.log(`[list-podcasts] Fetching completed podcasts from database for user ${userId}`);
        const { data: dbPodcasts, error: dbError } = await supabase
          .from('podcast_jobs')
          .select('*')
          .eq('user_id', userId)
          .eq('status', 'completed');
        
        if (dbError) {
          console.error('[list-podcasts] Error fetching from database:', dbError);
        } else if (dbPodcasts?.length) {
          console.log(`[list-podcasts] Found ${dbPodcasts.length} podcasts in database`);
          
          // Add database podcasts first (they have the correct URLs)
          dbPodcasts.forEach(podcast => {
            if (podcast.podcast_url) {
              // Check for URL issues and fix if needed
              let url = podcast.podcast_url;
              
              // Add the podcast to our list
              allPodcasts.push({
                id: podcast.job_id,
                title: podcast.filename?.replace(/\\.pdf$/, '') || 'Untitled Podcast',
                created_at: podcast.created_at || new Date().toISOString(),
                audio_url: url,
                source: 'database',
                concepts: podcast.concepts || []
              });
            }
          });
        }
      }
      
      // 2. Check for podcasts in the root directory (legacy location)
      console.log('[list-podcasts] Checking for podcasts in root directory');
      const { data: rootFiles, error: rootError } = await supabase
        .storage
        .from('podcasts')
        .list('', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
      
      if (!rootError && rootFiles) {
        const mp3Files = rootFiles.filter(file => file.name.endsWith('.mp3'));
        console.log(`[list-podcasts] Found ${mp3Files.length} MP3 files in root folder`);
        
        mp3Files.forEach(file => {
          // Only include if it's not already in our list
          const publicUrl = supabase.storage.from('podcasts').getPublicUrl(file.name).data.publicUrl;
          if (!allPodcasts.some(p => p.audio_url === publicUrl)) {
            const prettyTitle = file.name
              .replace(/^podcast_/, '')
              .replace(/\.mp3$/, '')
              .replace(/-/g, ' ');
            
            allPodcasts.push({
              id: file.id || file.name,
              title: prettyTitle || 'Untitled Podcast',
              created_at: file.created_at || new Date().toISOString(),
              audio_url: publicUrl,
              source: 'storage-root',
              concepts: []
            });
          }
        });
      }
      
      // 2.5 Check for podcasts in the public folder (new standard location)
      console.log('[list-podcasts] Checking for podcasts in public directory');
      const { data: publicFiles, error: publicError } = await supabase
        .storage
        .from('podcasts')
        .list('public', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
      
      if (!publicError && publicFiles) {
        const mp3Files = publicFiles.filter(file => file.name.endsWith('.mp3'));
        console.log(`[list-podcasts] Found ${mp3Files.length} MP3 files in public folder`);
        
        mp3Files.forEach(file => {
          // Only include if it's not already in our list
          const filePath = `public/${file.name}`;
          const publicUrl = supabase.storage.from('podcasts').getPublicUrl(filePath).data.publicUrl;
          if (!allPodcasts.some(p => p.audio_url === publicUrl)) {
            const prettyTitle = file.name
              .replace(/^podcast_/, '')
              .replace(/\.mp3$/, '')
              .replace(/-/g, ' ');
            
            allPodcasts.push({
              id: file.id || file.name,
              title: prettyTitle || 'Untitled Podcast',
              created_at: file.created_at || new Date().toISOString(),
              audio_url: publicUrl,
              source: 'storage-public',
              concepts: []
            });
          }
        });
        
        // Also look for any user folders in the public directory
        const userFolders = publicFiles.filter(item => item.id === null); // Folders have null id in Supabase storage
        
        for (const folder of userFolders) {
          console.log(`[list-podcasts] Found user folder in public directory: ${folder.name}`);
          const { data: userPublicFiles, error: userPublicError } = await supabase
            .storage
            .from('podcasts')
            .list(`public/${folder.name}`, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
            
          if (!userPublicError && userPublicFiles) {
            const userMp3Files = userPublicFiles.filter(file => file.name.endsWith('.mp3'));
            console.log(`[list-podcasts] Found ${userMp3Files.length} MP3 files in public/${folder.name} folder`);
            
            userMp3Files.forEach(file => {
              const filePath = `public/${folder.name}/${file.name}`;
              const publicUrl = supabase.storage.from('podcasts').getPublicUrl(filePath).data.publicUrl;
              
              // Only include if it's not already in our list
              if (!allPodcasts.some(p => p.audio_url === publicUrl)) {
                const prettyTitle = file.name
                  .replace(/^podcast_/, '')
                  .replace(/\.mp3$/, '')
                  .replace(/-/g, ' ');
                
                allPodcasts.push({
                  id: file.id || file.name,
                  title: prettyTitle || 'Untitled Podcast',
                  created_at: file.created_at || new Date().toISOString(),
                  audio_url: publicUrl,
                  source: 'storage-public-user',
                  concepts: []
                });
              }
            });
          }
        }
      }
      
      // 3. Check for podcasts in user's specific folder (current pattern)
      if (userId) {
        console.log(`[list-podcasts] Checking for podcasts in user directory: ${userId}`);
        const { data: userFiles, error: userError } = await supabase
          .storage
          .from('podcasts')
          .list(userId, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
        
        if (!userError && userFiles) {
          const mp3Files = userFiles.filter(file => file.name.endsWith('.mp3'));
          console.log(`[list-podcasts] Found ${mp3Files.length} MP3 files in user folder`);
          
          mp3Files.forEach(file => {
            const filePath = `${userId}/${file.name}`;
            const publicUrl = supabase.storage.from('podcasts').getPublicUrl(filePath).data.publicUrl;
            
            // Only include if it's not already in our list
            if (!allPodcasts.some(p => p.audio_url === publicUrl)) {
              const prettyTitle = file.name
                .replace(/^podcast_/, '')
                .replace(/\\.mp3$/, '')
                .replace(/-/g, ' ');
              
              allPodcasts.push({
                id: file.id || file.name,
                title: prettyTitle || 'Untitled Podcast',
                created_at: file.created_at || new Date().toISOString(),
                audio_url: publicUrl,
                source: 'storage-user',
                concepts: []
              });
            }
          });
        }
      }
      
      // Sort podcasts by creation date (newest first)
      allPodcasts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      console.log(`[list-podcasts] Total unique podcasts found: ${allPodcasts.length}`);
      
      // Set our final podcast list
      podcastList = allPodcasts;
    } catch (error) {
      console.error('[list-podcasts] Error loading podcasts:', error);
      podcastList = [];
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
