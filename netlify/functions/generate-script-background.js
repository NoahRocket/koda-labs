const fetch = require('node-fetch');
const { getSupabaseAdmin, releaseSupabaseConnections } = require('./supabaseClient');

// Helper to update job status and data in a single call
const updateJob = async (jobId, data) => {
  const supabaseAdmin = getSupabaseAdmin();
  console.log(`[generate-script-background] Updating job ${jobId} with data:`, data);
  
  const { error } = await supabaseAdmin
    .from('podcast_jobs')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('job_id', jobId);

  if (error) {
    console.error(`[generate-script-background] Supabase update error for job ${jobId}:`, error);
    return { error };
  }
  return { error: null };
};

// This function now lives here, as chatgpt.js is a generic handler
async function generatePodcastScript(concepts, extractedText) {
    console.log('[generatePodcastScript] Starting script generation');
    try {
        const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        if (!OPENAI_API_KEY) {
            throw new Error('OpenAI API key is not configured.');
        }
        
        console.log('[generatePodcastScript] Formatting concepts and extracting text');
        // Format concepts from the array of objects
        const conceptsText = Array.isArray(concepts) ? 
            concepts.map(c => `- ${c.concept}: ${c.explanation}`).join('\n') :
            JSON.stringify(concepts); // Fallback if concepts is not an array
        
        // Truncate the source text to avoid hitting token limits
        const MAX_TEXT_LENGTH = 10000; // Reduced to ensure we stay under limits
        const truncatedText = extractedText ? extractedText.substring(0, MAX_TEXT_LENGTH) : '';
        if (!truncatedText) {
            throw new Error('Extracted text is empty or undefined');
        }
        
        console.log(`[generatePodcastScript] Prepared ${conceptsText.length} bytes of concepts and ${truncatedText.length} bytes of text`);

        const prompt = `You are a professional podcast script writer. Your task is to create an engaging, educational podcast script based on the following key concepts and the provided source text. The script should be conversational, clear, and approximately 3-5 minutes when read aloud.

Key Concepts to Cover:
${conceptsText}

Source Text for Context:
${truncatedText}

Please generate the podcast script. The tone should be informative yet accessible. Structure it with a brief introduction, a main body that discusses each concept, and a short outro. Do not include placeholders like "intro music" or "outro music" or any other stage directions. Return ONLY the script content as plain text, focusing solely on the spoken content.`;

        console.log('[generatePodcastScript] Making OpenAI API call');
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4.1-mini', // Use more reliable model instead of gpt-4.1-mini
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7,
                max_tokens: 5000, // Reduced for better reliability
            })
        });

        console.log(`[generatePodcastScript] OpenAI API response status: ${response.status}`);
        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`[generatePodcastScript] OpenAI API error: ${response.status}`, errorBody);
            throw new Error(`OpenAI API error: ${response.status} - ${errorBody}`);
        }

        console.log('[generatePodcastScript] Parsing OpenAI response');
        const data = await response.json();
        const script = data.choices?.[0]?.message?.content;

        if (!script) {
            console.error('[generatePodcastScript] Invalid response structure from OpenAI:', data);
            throw new Error('Invalid response structure from OpenAI API or empty script.');
        }
        
        console.log(`[generatePodcastScript] Successfully generated script of length ${script.length}`);
        return script.trim();
    } catch (error) {
        console.error('[generatePodcastScript] Error generating script:', error);
        throw error; // Re-throw to be handled by the caller
    }
}


exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let jobId;
  try {
    const body = JSON.parse(event.body);
    jobId = body.jobId;
    if (!jobId) {
      throw new Error('Missing jobId in request body');
    }
  } catch (error) {
    console.error('[generate-script-background] Invalid request body:', error);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request: Missing or malformed jobId' }) };
  }

  console.log(`[generate-script-background] Starting processing for job ${jobId}`);

  // Set a handler timeout to prevent the function from stalling indefinitely
  const timeoutId = setTimeout(() => {
    console.error(`[generate-script-background] Operation timed out after 50 seconds for job ${jobId}`);
    // We can't update the job status here because the function might have already exited
  }, 50000);
  
  try {
    await updateJob(jobId, { status: 'generating_script' });

    const supabaseAdmin = getSupabaseAdmin();

    // Add a timeout to the database query
    const fetchPromise = supabaseAdmin
      .from('podcast_jobs')
      .select('concepts, generated_script, user_id')
      .eq('job_id', jobId)
      .single();
    
    // Use Promise.race to ensure the query doesn't hang indefinitely
    const { data: job, error: fetchError } = await Promise.race([
      fetchPromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Database query timed out after 10s')), 10000)
      )
    ]);

    if (fetchError || !job) {
      throw new Error(`Failed to fetch job ${jobId}: ${fetchError ? fetchError.message : 'Not found'}`);
    }

    const { concepts, generated_script: extractedText, user_id: userId } = job;
    
    // More robust input validation
    if (!extractedText || typeof extractedText !== 'string' || extractedText.trim().length === 0) {
      throw new Error(`Job ${jobId} is missing valid extracted text`);
    }
    
    if (!concepts) {
      console.warn(`Job ${jobId} is missing concepts, using fallback empty array`);
      concepts = [];
    }

    console.log(`[generate-script-background] Generating script for job ${jobId}...`);
    const scriptText = await generatePodcastScript(concepts, extractedText);
    console.log(`[generate-script-background] Script generated successfully for job ${jobId}.`);

    await updateJob(jobId, { status: 'script_generated', generated_script: scriptText });

    console.log(`[generate-script-background] Triggering TTS generation for job ${jobId}...`);
    const ttsFunctionUrl = `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/generate-tts-background`;
    
    const response = await fetch(ttsFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ jobId, userId, scriptText })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to trigger TTS generation. Status: ${response.status}. Body: ${errorBody}`);
    }

    await updateJob(jobId, { status: 'delegated_to_tts' });
    console.log(`[generate-script-background] Job ${jobId} successfully delegated to TTS generation.`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: `Job ${jobId} processed and delegated to TTS.` })
    };

  } catch (error) {
    console.error(`[generate-script-background] CRITICAL ERROR processing job ${jobId}:`, error);
    await updateJob(jobId, { status: 'failed', error_message: error.message });
    
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Failed to process job ${jobId}: ${error.message}` })
    };
  } finally {
    releaseSupabaseConnections();
    console.log(`[generate-script-background] Execution for job ${jobId} finished.`);
  }
};
