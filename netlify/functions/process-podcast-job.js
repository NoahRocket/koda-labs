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
      return { 
        statusCode: 200, 
        body: JSON.stringify({ 
          message: `Job is already ${job.status}.`,
          jobId: job.job_id,
          status: job.status
        }) 
      };
    }

    // Update job status to 'generating_script'
    try {
      await updateJobStatus(supabase, job.job_id, 'generating_script');
    } catch (err) {
      console.error('Failed to update job status to processing:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update job status.' }) };
    }

    console.log(`Processing podcast job ${job.job_id} for user ${job.user_id}`);
    
    try {
      // --- 1. Generate Script using OpenAI --- 
      const intro = "Welcome to your Koda Tutor podcast. Today, we'll explore some key concepts.\n\n";
      const outro = "\n\nThat concludes our summary. Thanks for listening!";

      // Prepare concepts for the prompt
      console.log('Preparing concepts for prompt...');
      const conceptsString = job.concepts.map(({ concept, explanation }) => `- ${concept}: ${explanation}`).join('\n');
      console.log('Concepts prepared:', conceptsString);

      const prompt = `You are a podcast script writer. Given the following key concepts and their explanations, generate a conversational and engaging podcast script body that explains these concepts clearly. Aim for a script that would take approximately 3-4 minutes to read aloud. Do not include an intro or outro, just the main content discussing the concepts.

Here are the concepts:
${conceptsString}

Generate only the script body.`;

      console.log('Calling OpenAI API to generate script...');
      let scriptBody = '';
      try {
          const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${OPENAI_API_KEY}`
              },
              body: JSON.stringify({
                  model: 'gpt-4o-mini-2024-07-18',
                  messages: [{ role: 'user', content: prompt }],
                  max_completion_tokens: 800 // Using correct parameter for the model
              })
          });

          if (!openaiResponse.ok) {
              const errorBody = await openaiResponse.text();
              console.error('OpenAI API Error:', openaiResponse.status, errorBody);
              throw new Error(`OpenAI API request failed: ${openaiResponse.statusText}`);
          }

          const openaiData = await openaiResponse.json();
          console.log('OpenAI response:', JSON.stringify(openaiData).substring(0, 200) + '...');
          
          scriptBody = openaiData.choices?.[0]?.message?.content?.trim() || '';

          if (!scriptBody) {
               console.error('OpenAI API returned an empty script body.');
               throw new Error('Failed to generate script content from OpenAI.');
          }
          
          console.log('Script body generated successfully:', scriptBody.substring(0, 100) + '...');

      } catch (apiError) {
          console.error('Error calling OpenAI API:', apiError);
          await updateJobStatus(supabase, job.job_id, 'failed', 'Failed to generate podcast script.');
          return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate podcast script.' }) };
      }
      
      // Assemble the full script
      const scriptText = intro + scriptBody + outro;

      console.log('Generated script text length:', scriptText.length);

      // Store the script and update status to 'script_generated'
      try {
        await updateJobStatus(supabase, job.job_id, 'script_generated', null, null, scriptText);
        console.log(`Job ${job.job_id} status updated to script_generated and script stored.`);
      } catch (scriptSaveError) {
        console.error('Failed to save script or update status to script_generated:', scriptSaveError);
        // Don't necessarily fail the whole process if only status update failed, but log it.
        // If saving script itself failed, it's more critical.
        // For now, we proceed to trigger TTS, but this could be a point of failure to handle more gracefully.
      }

      // Trigger the TTS generation function
      try {
        const domain = event.headers.host;
        const protocol = domain.includes('localhost') ? 'http' : 'https';
        const ttsGenerationUrl = `${protocol}://${domain}/.netlify/functions/generate-tts-background`;
        
        console.log(`Triggering TTS generation at: ${ttsGenerationUrl} for job ${job.job_id}`);
        
        // Note: generate-tts-background should update status to 'generating_tts' upon starting.
        
        fetch(ttsGenerationUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jobId: job.job_id,
            userId: job.user_id, // Pass userId needed for storage path/policy later
            scriptText: scriptText
          }),
        }).catch(err => console.error('Error triggering TTS generation:', err));
        
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
