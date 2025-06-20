const fetch = require('node-fetch');
const { getSupabaseAdmin } = require('./supabaseClient'); // Correct path and specific client

// Retrieve environment variables
const { ELEVENLABS_API_KEY, SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY } = process.env;
const SUPABASE_BUCKET = 'podcasts'; // Or your desired bucket name

// ElevenLabs API details
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech/';
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Example voice ID (Adam) - replace if needed

// Helper function to update job status
async function updateJobStatus(supabase, jobId, status, error = null, podcastUrl = null, script = null) {
  console.log(`Updating job ${jobId} to status: ${status}${error ? ' with error: ' + error : ''}${script ? ' and storing script' : ''}`);
  
  const updateData = { 
    status: status, 
    updated_at: new Date().toISOString()
  };
  
  if (error) updateData.error_message = error;
  if (podcastUrl) updateData.podcast_url = podcastUrl;
  if (script) updateData.generated_script = script; // Store the generated script
  
  const { error: updateError } = await supabase
    .from('podcast_jobs')
    .update(updateData)
    .eq('job_id', jobId);
    
  if (updateError) {
    console.error('Error updating job status:', updateError);
    throw new Error(`Failed to update job status: ${updateError.message}`);
  }
  
  console.log(`Job ${jobId} status updated to ${status}`);
  return true;
}

exports.handler = async (event) => {
  console.log('Starting podcast job processing...');
  
  // Verify environment variables
  if (!ELEVENLABS_API_KEY || !SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
    console.error('Missing required environment variables');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  try {
    const { jobId } = JSON.parse(event.body);
    
    if (!jobId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing job ID.' }) };
    }
    
    console.log(`Looking for job with ID: ${jobId}`);

    // Initialize Supabase admin client WITH SERVICE ROLE for RLS bypass
    const supabase = getSupabaseAdmin(); // Use Admin client

    // Get the job using direct SQL to bypass RLS
    const { data, error } = await supabase
      .rpc('admin_get_podcast_job', { job_id_param: jobId });
    
    // Fallback to legacy method if RPC not available
    let job = data?.[0]; // Get the first row from the result set
    if (error || !job) {
      console.log('RPC call failed or not available, trying direct query with service role key...');
      
      // Try direct query with explicit auth bypass
      const { data: directData, error: directError } = await supabase
        .from('podcast_jobs')
        .select('*')
        .eq('job_id', jobId)
        .maybeSingle();
        
      if (directError || !directData) {
        console.error('Error fetching job via direct query:', directError);
        return { statusCode: 404, body: JSON.stringify({ error: 'Job not found.' }) };
      }
      
      job = directData;
    }
    
    if (!job) {
      console.error('Could not find job after trying multiple methods');
      return { statusCode: 404, body: JSON.stringify({ error: 'Job not found after multiple attempts.' }) };
    }
    
    console.log(`Found job:`, job);
    
    // Check job status - should be 'text_analyzed' from the previous step
    if (job.status !== 'text_analyzed') {
      // If the job is already past the text_analyzed stage, we can just return its current status
      // This prevents re-triggering background jobs multiple times
      return { 
        statusCode: 200, 
        body: JSON.stringify({ 
          message: `Job is already in '${job.status}' status.`,
          jobId: job.job_id,
          status: job.status
        }) 
      };
    }

    // Update job status to 'delegating_to_background'
    try {
      await updateJobStatus(supabase, job.job_id, 'delegating_to_background');
    } catch (err) {
      console.error('Failed to update job status:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update job status.' }) };
    }

    console.log(`Processing podcast job ${job.job_id} for user ${job.user_id}`);
    
    try {
      // Instead of directly generating the script with OpenAI here, we'll delegate to our background worker
      // This avoids the Netlify function timeout limit
      
      console.log(`Delegating script generation to background worker for job ${job.job_id}`);
      
      // Trigger the background script generation function
      try {
        const domain = event.headers.host;
        const protocol = domain.includes('localhost') ? 'http' : 'https';
        const scriptGenerationUrl = `${protocol}://${domain}/.netlify/functions/generate-script-background`;
        
        console.log(`Triggering background script generation at: ${scriptGenerationUrl} for job ${job.job_id}`);
        
        const response = await fetch(scriptGenerationUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Use service role key for background processing
            'Authorization': `Bearer ${SUPABASE_KEY}`
          },
          body: JSON.stringify({
            jobId: job.job_id
          })
        });
        
        // Special handling for 202 Accepted (async processing started)
        if (response.status === 202) {
          console.log(`Background script generation successfully initiated for job ${job.job_id}`);
          let responseText = '';
          try {
            // Try to read the response, but don't fail if it can't be parsed as JSON
            responseText = await response.text();
            const result = JSON.parse(responseText);
            console.log(`Background script generation response:`, result);
          } catch (parseError) {
            // It's ok if we can't parse the response as long as we got a 202
            console.log(`Note: Could not parse 202 response as JSON: ${responseText}`);
          }
        }
        // Handle other error cases
        else if (!response.ok) {
          const errorText = await response.text();
          console.error(`Error starting background script generation: ${response.status} - ${errorText}`);
          throw new Error(`Failed to start background script generation: ${response.status} - ${errorText}`);
        }
        // Handle 200 OK (synchronous completion)
        else {
          try {
            const result = await response.json();
            console.log(`Background script generation completed synchronously:`, result);
          } catch (parseError) {
            console.warn(`Warning: Received OK status but could not parse response: ${parseError.message}`);
          }
        }
        
        // Return success immediately, before the 30-second timeout
        return {
          statusCode: 200,
          body: JSON.stringify({ 
            success: true,
            message: 'Podcast generation in progress',
            jobId: job.job_id
          })
        };
      } catch (error) {
        console.error('Error triggering TTS generation function:', error);
        await updateJobStatus(supabase, job.job_id, 'failed', 'Failed to start TTS generation: ' + error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to continue podcast generation.' }) };
      }
    } catch (error) {
      console.error('Error processing podcast job:', error);
      
      // Update job status to failed
      try {
        await updateJobStatus(supabase, job.job_id, 'failed', error.message || 'Unknown error occurred');
      } catch (statusError) {
        console.error('Additionally failed to update status:', statusError);
      }
        
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: 'Failed to process podcast job.',
          message: error.message
        })
      };
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error processing podcast job.' })
    };
  }
};
