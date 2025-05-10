const { getSupabaseAdmin, getSupabaseAuthClient } = require('./supabaseClient');

// Retrieve environment variables
const { SUPABASE_URL, SUPABASE_KEY } = process.env;

exports.handler = async (event) => {
  // Verify method
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Check for environment variables
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing required environment variables');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // Parse query parameters
  const params = event.queryStringParameters;
  const jobId = params.jobId;
  
  // Validate jobId
  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing job ID.' }) };
  }

  // Get user information from the JWT token
  let userId = null;
  const authHeader = event.headers.authorization || event.headers.Authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Parse JWT for user ID
    try {
      const token = authHeader.split(' ')[1];
      const supabaseAuth = getSupabaseAuthClient(); // Use Auth client for getUser
      const { data, error } = await supabaseAuth.auth.getUser(token);
      
      if (!error && data && data.user) {
        userId = data.user.id;
      }
    } catch (err) {
      console.error('Error parsing auth token:', err);
      // Continue without user ID
    }
  }

  console.log(`Checking job status for ID: ${jobId}${userId ? ` and user: ${userId}` : ''}`);
  
  // Initialize Supabase client with service role key for DB operations
  const supabaseAdmin = getSupabaseAdmin(); // Use Admin client for DB reads

  try {
    // Try to get the job using our admin function first
    console.log(`Trying to get job using admin function...`);
    let jobData = null;
    let jobError = null;
    
    try {
      const { data, error } = await supabaseAdmin
        .rpc('admin_get_podcast_job', { job_id_param: jobId });
        
      if (!error && data && data.length > 0) {
        jobData = data[0];
        console.log(`Found job via admin function with status: ${jobData.status}`);
      } else {
        jobError = error;
        console.log(`Admin function failed:`, error);
      }
    } catch (err) {
      console.error('Error calling admin function:', err);
      // Continue to fallback
    }
    
    // If admin function didn't work, try direct query with user ID restriction if available
    if (!jobData) {
      console.log(`Falling back to direct query${userId ? ' with user_id restriction' : ''}...`);
      
      let query = supabaseAdmin
        .from('podcast_jobs')
        .select('*');
        
      // Add job_id condition
      query = query.eq('job_id', jobId);
      
      // If we have a user ID, restrict to only their jobs
      if (userId) {
        query = query.eq('user_id', userId);
      }
      
      // Run the query
      const { data, error } = await query;
      
      if (error) {
        console.error('Database query error:', error);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Failed to check job status.' })
        };
      }
      
      if (!data || data.length === 0) {
        console.log('Job not found in database.');
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'Job not found.' })
        };
      }
      
      jobData = data[0];
      console.log(`Found job via direct query with status: ${jobData.status}`);
    }
    
    // Return the job status
    return {
      statusCode: 200,
      body: JSON.stringify({
        jobId: jobData.job_id,
        status: jobData.status,
        podcastUrl: jobData.podcast_url,
        error: jobData.error_message
      })
    };
    
  } catch (error) {
    console.error('Error checking job status:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error checking job status.' })
    };
  }
};
