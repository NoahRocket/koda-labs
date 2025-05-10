const { getSupabaseAdmin, getSupabaseAuthClient } = require('./supabaseClient');

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

  // Verify the user's token and get their ID
  let userId;
  try {
    const token = authHeader.split(' ')[1];
    const supabaseAuth = getSupabaseAuthClient();
    const { data, error } = await supabaseAuth.auth.getUser(token);
    
    if (error || !data.user) {
      console.error('Auth error:', error);
      return { 
        statusCode: 401, 
        body: JSON.stringify({ error: 'Unauthorized: Invalid token' }) 
      };
    }
    
    userId = data.user.id;
  } catch (err) {
    console.error('Error parsing auth token:', err);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: 'Server error processing authentication' }) 
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
        const { error: storageError } = await supabase
          .storage
          .from('podcasts')
          .remove([filename]);
          
        if (storageError) {
          console.warn('Storage delete warning:', storageError);
          // Continue even if storage deletion fails
        }
      } catch (storageErr) {
        console.warn('Storage delete exception:', storageErr);
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
