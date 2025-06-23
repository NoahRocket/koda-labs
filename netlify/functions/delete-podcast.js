const { getSupabaseAdmin } = require('./supabaseClient');

exports.handler = async (event) => {
  // Only allow DELETE requests
  if (event.httpMethod !== 'DELETE') {
    return { 
      statusCode: 405, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  // Get authorization header for user verification
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { 
      statusCode: 401, 
      body: JSON.stringify({ error: 'Unauthorized: Authentication required' }) 
    };
  }

  // Parse job ID from the request
  let jobId;
  try {
    const params = event.queryStringParameters;
    jobId = params.jobId;
    
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing job ID parameter' })
      };
    }
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request' })
    };
  }

  // Verify the user's token and get their ID using manual JWT token decoding
  let userId;
  try {
    // Extract token from header
    const token = authHeader.split(' ')[1];
    console.log('[delete-podcast] Access Token from header (preview):', token ? `${token.slice(0, 8)}...${token.slice(-5)}` : 'null...null');
    
    // Basic token validation
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
      const base64Payload = tokenParts[1];
      const decodedPayload = Buffer.from(base64Payload, 'base64').toString('utf8');
      const payload = JSON.parse(decodedPayload);
      
      // Extract user information
      if (!payload.sub) {
        throw new Error('Invalid token payload: missing user ID');
      }
      
      // Use sub claim as the user ID
      userId = payload.sub;
      console.log(`[delete-podcast] Successfully decoded token for user: ${userId}`);
    } catch (decodeError) {
      console.error('[delete-podcast] Token decode error:', decodeError);
      throw new Error('Failed to decode token: ' + decodeError.message);
    }
  } catch (err) {
    console.error('[delete-podcast] Exception during token validation:', err.message);
    return { 
      statusCode: 401, 
      body: JSON.stringify({ error: `Unauthorized: ${err.message}` }) 
    };
  }

  try {
    // Use the admin client to get the podcast job
    const supabase = getSupabaseAdmin();
    
    // First get the job to check if it belongs to this user and to get the file URL
    const { data: job, error: jobError } = await supabase
      .from('podcast_jobs')
      .select('*')
      .eq('job_id', jobId)
      .eq('user_id', userId)
      .single();
    
    // If we can't find the job in the database, it might be a direct storage file
    // In this case, we'll try to delete it directly from storage
    if (jobError || !job) {
      console.log(`[delete-podcast] Job not found in database: ${jobId}. Will try direct storage deletion.`);
      
      // Since we don't have a job record, we'll try to delete based on the jobId as filename
      // This handles podcasts that were uploaded directly to storage without a DB record
      try {
        // Try to delete the file directly from storage using various possible paths
        const possibleFilenames = [
          // Try jobId as the filename
          `${jobId}`,
          // Try with .mp3 extension
          `${jobId}.mp3`,
          // Try with podcast_ prefix
          `podcast_${jobId}.mp3`
        ];
        
        let deletionSuccess = false;
        
        for (const filename of possibleFilenames) {
          // Try multiple possible locations for each filename
          const possiblePaths = [
            // Current pattern: userId/filename.mp3
            `${userId}/${filename}`,
            // Legacy pattern: filename.mp3 in root
            `${filename}`,
            // Old pattern with public prefix: public/userId/filename.mp3
            `public/${userId}/${filename}`
          ];
          
          for (const path of possiblePaths) {
            console.log(`[delete-podcast] Trying to delete: ${path}`);
            
            try {
              const { error: deleteError } = await supabase
                .storage
                .from('podcasts')
                .remove([path]);
                
              if (!deleteError) {
                console.log(`[delete-podcast] Successfully deleted ${path} from storage.`);
                deletionSuccess = true;
              }
            } catch (err) {
              // Continue trying other paths
            }
          }
        }
        
        if (deletionSuccess) {
          return {
            statusCode: 200,
            body: JSON.stringify({ 
              success: true, 
              message: 'Podcast deleted successfully from storage'
            })
          };
        } else {
          return { 
            statusCode: 404, 
            body: JSON.stringify({ error: 'Podcast not found or access denied' }) 
          };
        }
      } catch (storageErr) {
        console.error('[delete-podcast] Storage delete exception:', storageErr);
        return { 
          statusCode: 500, 
          body: JSON.stringify({ error: 'Failed to delete podcast from storage' }) 
        };
      }
    }
    
    // Extract filename from the podcast URL if available
    let filename = null;
    if (job.podcast_url) {
      // The URL format is typically: https://xxx.supabase.co/storage/v1/object/public/podcasts/filename.mp3
      const urlParts = job.podcast_url.split('/');
      filename = urlParts[urlParts.length - 1];
    }
    
    // Delete the record from the database
    const { error: deleteError } = await supabase
      .from('podcast_jobs')
      .delete()
      .eq('job_id', jobId)
      .eq('user_id', userId);
    
    if (deleteError) {
      console.error('Delete error:', deleteError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to delete podcast record' })
      };
    }
    
    // If we have a filename, try to delete the file from storage
    if (filename) {
      try {
        // Try multiple possible locations for the file
        const possiblePaths = [
          // Current pattern: userId/filename.mp3
          `${userId}/${filename}`,
          // Legacy pattern: filename.mp3 in root
          `${filename}`,
          // Old pattern with public prefix: public/userId/filename.mp3
          `public/${userId}/${filename}`
        ];
        
        console.log(`[delete-podcast] Attempting to delete from storage, trying multiple paths for: ${filename}`);
        
        // Try each path until we find the file
        let deletionSuccess = false;
        
        for (const path of possiblePaths) {
          console.log(`[delete-podcast] Trying path: ${path}`);
          
          // First check if the file exists at this path
          try {
            const { data: fileExists } = await supabase
              .storage
              .from('podcasts')
              .list(path.split('/').slice(0, -1).join('/') || '', {
                limit: 100,
                search: path.split('/').pop()
              });
              
            if (fileExists && fileExists.length > 0) {
              console.log(`[delete-podcast] Found file at path: ${path}`);
              
              // File exists, try to delete it
              const { error: storageError } = await supabase
                .storage
                .from('podcasts')
                .remove([path]);
                
              if (storageError) {
                console.warn(`[delete-podcast] Storage deletion warning for ${path}:`, storageError);
              } else {
                console.log(`[delete-podcast] Successfully deleted ${path} from storage.`);
                deletionSuccess = true;
                break; // Exit the loop if deletion was successful
              }
            }
          } catch (checkErr) {
            console.warn(`[delete-podcast] Error checking path ${path}:`, checkErr);
          }
        }
        
        if (!deletionSuccess) {
          console.warn(`[delete-podcast] Could not find or delete file ${filename} in any expected location`);
        }
      } catch (storageErr) {
        console.warn('[delete-podcast] Storage delete exception:', storageErr);
        // Continue even if storage deletion throws
      }
    }
    
    // Return success
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: 'Podcast deleted successfully'
      })
    };
  } catch (error) {
    console.error('Error deleting podcast:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error deleting podcast' })
    };
  }
};
