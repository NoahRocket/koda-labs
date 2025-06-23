const { getSupabaseAdmin } = require('./supabaseClient');

/**
 * This serverless function rescues stuck podcast jobs by updating their status
 * and triggering the next step in the pipeline.
 */
exports.handler = async (event) => {
  // Secure this endpoint - only allow admin access
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  // Initialize Supabase
  const supabaseAdmin = getSupabaseAdmin();
  
  try {
    // Find jobs that are stuck in pending status for more than 5 minutes
    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);
    
    console.log(`[rescue-stuck-jobs] Looking for stuck jobs older than ${fiveMinutesAgo.toISOString()}`);

    // Get specific job ID if provided, otherwise find all stuck jobs
    const params = event.queryStringParameters || {};
    const jobId = params.jobId;
    
    let jobQuery = supabaseAdmin
      .from('podcast_jobs')
      .select('*')
      .eq('status', 'pending');
      
    if (jobId) {
      // If specific job ID provided, rescue just that one
      jobQuery = jobQuery.eq('job_id', jobId);
      console.log(`[rescue-stuck-jobs] Looking for specific job: ${jobId}`);
    }
    
    const { data: stuckJobs, error: queryError } = await jobQuery;
    
    if (queryError) {
      console.error('[rescue-stuck-jobs] Error querying for stuck jobs:', queryError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to query for stuck jobs' })
      };
    }
    
    if (!stuckJobs || stuckJobs.length === 0) {
      console.log('[rescue-stuck-jobs] No stuck jobs found');
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No stuck jobs found' })
      };
    }
    
    console.log(`[rescue-stuck-jobs] Found ${stuckJobs.length} stuck jobs`);
    
    // Process each stuck job
    const results = [];
    for (const job of stuckJobs) {
      console.log(`[rescue-stuck-jobs] Rescuing job ${job.job_id} (${job.filename})`);
      
      try {
        // Update job status to pending_analysis
        const { error: updateError } = await supabaseAdmin
          .from('podcast_jobs')
          .update({ 
            status: 'pending_analysis',
            updated_at: new Date().toISOString() 
          })
          .eq('job_id', job.job_id);
          
        if (updateError) {
          console.error(`[rescue-stuck-jobs] Failed to update job ${job.job_id}:`, updateError);
          results.push({
            jobId: job.job_id,
            success: false,
            error: updateError.message
          });
          continue;
        }
        
        // Trigger analyze-pdf-text to continue processing
        const host = event.headers.host;
        const proto = host.includes('localhost') ? 'http' : 'https';
        const analyzeUrl = `${proto}://${host}/.netlify/functions/analyze-pdf-text`;
        
        console.log(`[rescue-stuck-jobs] Triggering analyze-pdf-text for job ${job.job_id} at ${analyzeUrl}`);
        
        const analyzeResponse = await fetch(analyzeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader || `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
          },
          body: JSON.stringify({
            jobId: job.job_id
          })
        });
        
        if (!analyzeResponse.ok) {
          const errorText = await analyzeResponse.text();
          console.error(`[rescue-stuck-jobs] Failed to trigger analyze-pdf-text for job ${job.job_id}: ${analyzeResponse.status} ${errorText}`);
          results.push({
            jobId: job.job_id,
            success: false,
            error: `Failed to trigger next step: ${analyzeResponse.status}`
          });
        } else {
          console.log(`[rescue-stuck-jobs] Successfully triggered analyze-pdf-text for job ${job.job_id}`);
          results.push({
            jobId: job.job_id,
            success: true
          });
        }
      } catch (jobError) {
        console.error(`[rescue-stuck-jobs] Error processing job ${job.job_id}:`, jobError);
        results.push({
          jobId: job.job_id,
          success: false,
          error: jobError.message
        });
      }
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processed ${stuckJobs.length} stuck jobs`,
        results: results
      })
    };
  } catch (error) {
    console.error('[rescue-stuck-jobs] Unexpected error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to process stuck jobs', details: error.message })
    };
  }
};
