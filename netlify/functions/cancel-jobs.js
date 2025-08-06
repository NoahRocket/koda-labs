const { getSupabaseAdmin } = require('./supabaseClient');

// Retrieve environment variables
const { SUPABASE_URL, SUPABASE_KEY } = process.env;

exports.handler = async (event) => {
  // Verify method
  if (event.httpMethod !== 'POST') {
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
    
    // First, verify the job belongs to this user and get current status
    const { data: jobData, error: fetchError } = await supabase
      .from('podcast_jobs')
      .select('status, user_id')
      .eq('job_id', jobId)
      .single();

    if (fetchError) {
      console.error('[cancel-job] Error fetching job:', fetchError);
      return { statusCode: 404, body: JSON.stringify({ error: 'Job not found.' }) };
    }

    // Verify the job belongs to the authenticated user
    if (jobData.user_id !== userId) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: Job does not belong to this user.' }) };
    }

    // Check if job is already completed or failed (can't cancel)
    const currentStatus = jobData.status?.toLowerCase();
    if (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'cancelled') {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ 
          error: `Cannot cancel job with status: ${currentStatus}`,
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
