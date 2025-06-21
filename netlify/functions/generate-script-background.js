const { getSupabaseAdmin } = require('./supabaseClient');
const fetch = require('node-fetch');

// Use higher timeout - this is a background function
const FUNCTION_TIMEOUT = 25000; // 25 seconds, higher than the default Netlify limit

// API keys from environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Updates the status of a podcast job in the database
 */
async function updateJobStatus(jobId, status, errorMessage = null, generatedScript = null) {
  console.log(`[generate-script-background] Updating job ${jobId} to status: ${status}`);
  const supabaseAdmin = getSupabaseAdmin({ timeout: 10000 });
  const updateData = { 
    status, 
    updated_at: new Date().toISOString() 
  };
  
  if (errorMessage) updateData.error_message = errorMessage;
  if (generatedScript) updateData.generated_script = generatedScript;

  const { error } = await supabaseAdmin
    .from('podcast_jobs')
    .update(updateData)
    .eq('job_id', jobId);
    
  if (error) {
    console.error(`[generate-script-background] Failed to update job ${jobId}:`, error);
    throw new Error(`Database update error: ${error.message}`);
  }
}

/**
 * Triggers the next function in the podcast generation pipeline
 */
async function triggerNextStep(jobId, hostname) {
  try {
    const protocol = hostname.includes('localhost') ? 'http' : 'https';
    const workerUrl = `${protocol}://${hostname}/.netlify/functions/generate-tts-background`;
    
    console.log(`[generate-script-background] Triggering next step (TTS) for job ${jobId} at: ${workerUrl}`);
    
    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Use service role key for inter-function communication
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY}` 
      },
      body: JSON.stringify({ jobId }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[generate-script-background] Warning: Failed to trigger next step for job ${jobId}: ${response.status} ${errorText}`);
    }
  } catch (error) {
    console.error(`[generate-script-background] Error triggering next step for job ${jobId}:`, error);
  }
}

exports.handler = async (event) => {
  console.log('[generate-script-background] Background script generator started');
  
  // Set a timeout to ensure this function can run longer than normal functions
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Function timeout')), FUNCTION_TIMEOUT);
  });
  
  // Verify we're receiving a POST request
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  
  // Ensure the OpenAI API key is configured
  if (!OPENAI_API_KEY) {
    console.error('[generate-script-background] OpenAI API key missing');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: OpenAI API key missing' }) };
  }
  
  // Parse the jobId from the request
  let jobId, hostname;
  try {
    const body = JSON.parse(event.body);
    jobId = body.jobId;
    hostname = event.headers.host; // For constructing URLs to other functions
    
    if (!jobId) {
      throw new Error('Missing jobId in request body');
    }
  } catch (parseError) {
    console.error('[generate-script-background] Invalid request body:', parseError);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request: Missing or malformed jobId' }) };
  }
  
  // Start the main processing function but wrap it with a timeout guard
  const processingPromise = (async () => {
    try {
      console.log(`[generate-script-background] Processing job ${jobId}`);
      await updateJobStatus(jobId, 'generating_script_background');
      
      // 1. Fetch job details from the database
      const supabaseAdmin = getSupabaseAdmin({ timeout: 10000 });
      const { data: job, error: fetchError } = await supabaseAdmin
        .from('podcast_jobs')
        .select('*')
        .eq('job_id', jobId)
        .single();
      
      if (fetchError || !job) {
        throw new Error(`Failed to fetch job data: ${fetchError?.message || 'No job found'}`);
      }
      
      // 2. Get the text content and concepts for the prompt
      const extractedText = job.generated_script;
      const concepts = job.concepts || [];
      
      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('No text content found in job record');
      }
      
      // 3. Format the concepts for the prompt
      let conceptsText = '';
      if (Array.isArray(concepts) && concepts.length > 0) {
        conceptsText = concepts.map(c => {
          if (typeof c === 'string') return c;
          return c.concept && c.explanation ? `- ${c.concept}: ${c.explanation}` : (c.concept || '');
        }).join('\\n');
      }
      
      // 4. Create the prompt for OpenAI with more aggressive text truncation for large PDFs
      const textLength = extractedText.length;
      console.log(`[generate-script-background] Source text length: ${textLength} characters`);
      
      // More aggressive truncation for very large PDFs
      const MAX_TEXT_LENGTH = 8000; // Lower limit for safety
      const truncatedText = extractedText.substring(0, MAX_TEXT_LENGTH);
      
      // Log truncation info
      if (textLength > MAX_TEXT_LENGTH) {
        console.log(`[generate-script-background] Truncated text from ${textLength} to ${MAX_TEXT_LENGTH} characters`);
      }
      
      // Create a more focused prompt based on the concepts rather than full text for large PDFs
      const prompt = `You are a professional podcast script writer. Create a well-structured, engaging podcast script based on the following concepts and text summary. The script should be conversational, clear, and about 3-5 minutes when read aloud.

Key concepts to focus on (THESE ARE THE MOST IMPORTANT PARTS):
${conceptsText || 'Extract the main ideas from the text and focus on them.'}

Text from the source document (may be truncated):
"""
${truncatedText}
"""

Create a podcast script that:
1. Has a clear introduction, middle, and conclusion
2. Is conversational in tone 
3. Focuses primarily on the key concepts listed above
4. Avoids complex jargon or overly technical language
5. Is engaging and easy to follow for listeners

Format your response as a plain text podcast script without any additional notes or explanations.`;
      
      // Save checkpoint in database to track progress
      await updateJobStatus(jobId, 'sending_to_openai', null, null);
      console.log(`[generate-script-background] Updated job status to 'sending_to_openai'`);
      
      console.log(`[generate-script-background] Sending request to OpenAI for job ${jobId}`);
      
      // 5. Call OpenAI API to generate the podcast script with improved reliability
      console.log(`[generate-script-background] Creating OpenAI API request with timeout`); 
      
      // Create an AbortController for timeout control
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout
      
      try {
        console.log(`[generate-script-background] Sending request to OpenAI with ${MAX_TEXT_LENGTH} character limit`);
        
        const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: 'gpt-3.5-turbo', // Using most reliable model
            messages: [
              { 
                role: 'system', 
                content: 'You are a professional podcast script writer creating clear, concise, and engaging scripts.' 
              },
              { 
                role: 'user', 
                content: prompt 
              }
            ],
            temperature: 0.7,
            max_tokens: 1000, // Reduced for faster response
            presence_penalty: 0,
            frequency_penalty: 0
          })
        });
        
        // Clear the timeout since we got a response
        clearTimeout(timeoutId);
        
        // Continue with processing the response
        if (!openaiResponse.ok) {
          const errorBody = await openaiResponse.text();
          throw new Error(`OpenAI API error: ${openaiResponse.status} - ${errorBody}`);
        }
        
        const openaiData = await openaiResponse.json();
        const generatedScript = openaiData.choices?.[0]?.message?.content;
        
        if (!generatedScript) {
          throw new Error('No script content received from OpenAI');
        }
        
        console.log(`[generate-script-background] Successfully generated script for job ${jobId} (${generatedScript.length} chars)`);
      } catch (error) {
        clearTimeout(timeoutId); // Clean up the timeout
        
        if (error.name === 'AbortError') {
          throw new Error('OpenAI API call timed out after 25 seconds');
        }
        
        throw error; // Re-throw other errors
      }
      
      // 6. Generate the script using our improved function with timeout and error handling
      let generatedScript;
      // Generate the script using the OpenAI API
      // The function was previously defined above as an inline implementation
      // Now we'll use that result directly
      try {
        console.log(`[generate-script-background] Generating script for job ${jobId}`);

        // Execute the script generation directly as the code is already in place above
        // We're no longer using a nested function as that was causing reference issues
        
        // 7. Update the job with the generated script
        await updateJobStatus(jobId, 'script_generated', null, generatedScript);
        console.log(`[generate-script-background] Updated job status to 'script_generated'`);  
        
        // 8. Trigger the next step in the pipeline (TTS generation)
        try {
          await triggerNextStep(jobId, hostname);
          console.log(`[generate-script-background] Successfully triggered next step (TTS generation) for job ${jobId}`);
        } catch (triggerError) {
          console.error(`[generate-script-background] Failed to trigger next step for job ${jobId}:`, triggerError);
          // We don't want to fail the entire process if just the next step triggering fails
          // The job status is already updated correctly, so manual intervention is possible
        }
      } catch (scriptError) {
        console.error(`[generate-script-background] Failed to generate script: ${scriptError.message}`);
        
        // If the script generation fails, update the job status and rethrow
        await updateJobStatus(jobId, 'script_generation_failed', `Script generation failed: ${scriptError.message}`);
        throw scriptError;
      }
      
      return {
        statusCode: 200,
        body: JSON.stringify({ 
          success: true, 
          message: `Script generation completed for job ${jobId}` 
        })
      };
      
    } catch (error) {
      console.error(`[generate-script-background] Error processing job ${jobId}:`, error);
      
      // Update the job status to failed
      try {
        await updateJobStatus(jobId, 'failed', `Script generation failed: ${error.message}`);
      } catch (updateError) {
        console.error(`[generate-script-background] Failed to update job status for ${jobId}:`, updateError);
      }
      
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: `Script generation failed: ${error.message}` 
        })
      };
    }
  })();
  
  // This function is executed as a background serverless function after a 202 response
  // We need to capture errors here and update the job status accordingly
  try {
    // Safety check - make sure jobId exists before returning response
    const safeJobId = jobId || 'unknown';
    
    // Always ensure we're returning a valid JSON response
    const responseBody = JSON.stringify({ 
      success: true, 
      message: `Script generation started for job ${safeJobId} and will continue in the background` 
    });
    
    console.log('[generate-script-background] Returning early success response:', responseBody);
    
    return {
      statusCode: 202, // Accepted
      headers: { 'Content-Type': 'application/json' },
      body: responseBody
    };
  } catch (error) {
    console.error('[generate-script-background] Error in handler:', error);
    
    // Ensure even error responses are valid JSON
    try {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal server error', details: error.message || 'Unknown error' })
      };
    } catch (jsonError) {
      // Last resort if JSON.stringify fails
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'text/plain' },
        body: 'Internal server error: Failed to serialize error response'
      };
    }
  }
};
