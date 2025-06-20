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
    
    if (jobError || !job) {
      console.error('Job fetch error:', jobError);
      return { 
        statusCode: 404, 
        body: JSON.stringify({ error: 'Podcast not found or access denied' }) 
      };
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
        // The path in storage includes the user ID, matching the upload path
        const filePath = `public/${userId}/${filename}`;
        console.log(`[delete-podcast] Attempting to delete from storage: ${filePath}`);

        const { error: storageError } = await supabase
          .storage
          .from('podcasts')
          .remove([filePath]);
          
        if (storageError) {
          // Log a warning but don't fail the whole request,
          // as the DB record is the most important part.
          console.warn(`[delete-podcast] Storage deletion warning for ${filePath}:`, storageError);
        } else {
          console.log(`[delete-podcast] Successfully deleted ${filePath} from storage.`);
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
