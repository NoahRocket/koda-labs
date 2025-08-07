const { getSupabaseAdmin } = require('./supabaseClient');

// Retrieve environment variables
const { SUPABASE_URL, SUPABASE_KEY } = process.env;

exports.handler = async (event) => {
  console.log('[cancel-job] Function invoked with:', {
    httpMethod: event.httpMethod,
    queryStringParameters: event.queryStringParameters,
    headers: event.headers,
    path: event.path
  });
  console.log('[cancel-job] Function invoked with event:', event); // Added immediate debugging
  
  // Verify method
  if (event.httpMethod !== 'POST') {
    console.log('[cancel-job] Method not allowed:', event.httpMethod);
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
    try {
      const token = authHeader.split(' ')[1];
      console.log('[cancel-job] Access Token from header (preview):', token ? `${token.slice(0, 8)}...${token.slice(-5)}` : 'null...null');
      
      // Basic token validation
      if (!token || typeof token !== 'string') {
        console.warn('[cancel-job] Token missing or not a string');
      } else {
        // Check token format (three parts separated by dots)
        const tokenParts = token.split('.');
        if (tokenParts.length !== 3) {
          console.warn('[cancel-job] Token does not have three parts as required for JWT format');
        } else {
          try {
            // Base64 decode and parse the payload
            const base64Payload = tokenParts[1];
            const decodedPayload = Buffer.from(base64Payload, 'base64').toString('utf8');
            const payload = JSON.parse(decodedPayload);
            
            userId = payload.sub;
            console.log('[cancel-job] Extracted user ID:', userId);
          } catch (decodeError) {
            console.warn('[cancel-job] Error decoding token payload:', decodeError.message);
          }
        }
      }
    } catch (tokenError) {
      console.warn('[cancel-job] Error processing token:', tokenError.message);
    }
  }

  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Could not determine user.' }) };
  }

  try {
    const supabase = getSupabaseAdmin();
    
    console.log(`[cancel-job] Attempting to cancel job: ${jobId} for user: ${userId}`);
    
    // First, verify the job belongs to this user and get current status
    console.log(`[cancel-job] Querying database for job_id: "${jobId}" (type: ${typeof jobId})`);
    console.log(`[cancel-job] Job ID length: ${jobId.length}`);
    console.log(`[cancel-job] Job ID format validation: ${/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(jobId) ? 'Valid UUID' : 'Invalid UUID'}`);
    
    // Try to find the job with exact match
    const { data: jobData, error: fetchError } = await supabase
      .from('podcast_jobs')
      .select('status, user_id')
      .eq('job_id', jobId)
      .single();
      
    // Also check if job exists regardless of user for debugging
    const { data: allJobs, error: allFetchError } = await supabase
      .from('podcast_jobs')
      .select('job_id, user_id, status')
      .order('created_at', { ascending: false })
      .limit(10);
    
    console.log(`[cancel-job] Recent jobs in database:`, allJobs?.map(j => ({ job_id: j.job_id, status: j.status, user_id: j.user_id.slice(0, 8) + '...' })));
    console.log(`[cancel-job] Looking for job: "${jobId}"`);
    console.log(`[cancel-job] Job found: ${jobData ? 'Yes' : 'No'}`);
    console.log(`[cancel-job] Fetch error:`, fetchError);
      
    // Also check if job exists regardless of user for debugging
    const { data: anyJobData, error: anyFetchError } = await supabase
      .from('podcast_jobs')
      .select('job_id, user_id, status')
      .eq('job_id', jobId);
    
    console.log(`[cancel-job] Any job found:`, anyJobData);
    console.log(`[cancel-job] Any fetch error:`, anyFetchError);

    if (fetchError) {
      console.error('[cancel-job] Error fetching job:', fetchError);
      console.error('[cancel-job] Job not found in database:', { jobId, userId });
      return { statusCode: 404, body: JSON.stringify({ error: 'Job not found.' }) };
    }
    
    console.log('[cancel-job] Found job:', { jobId: jobId, jobUserId: jobData.user_id, requestingUserId: userId });

    // Verify the job belongs to the authenticated user
    if (jobData.user_id !== userId) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: Job does not belong to this user.' }) };
    }

    // Allow cancellation regardless of job status - users should be able to cancel at any time
    const currentStatus = jobData.status?.toLowerCase();
    if (currentStatus === 'cancelled') {
      return { 
        statusCode: 200, 
        body: JSON.stringify({ 
          message: 'Job already cancelled',
          status: currentStatus
        }) 
      };
    }

    // Update the job status to 'cancelled'
    const { error: updateError } = await supabase
      .from('podcast_jobs')
      .update({ 
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('job_id', jobId);

    if (updateError) {
      console.error('[cancel-job] Error updating job status:', updateError);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to cancel job.' }) };
    }

    console.log(`[cancel-job] Successfully cancelled job ${jobId} for user ${userId}`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: 'Job cancelled successfully',
        jobId: jobId,
        status: 'cancelled'
      })
    };

  } catch (error) {
    console.error('[cancel-job] Unexpected error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error.' })
    };
  }
};
