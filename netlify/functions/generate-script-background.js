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

// Updated to generate script per chunk
async function generatePodcastScript(concepts, chunk, previousScript, partLabel, isLastChunk) {
  console.log(`[generatePodcastScript] Starting script generation for ${partLabel}`);
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured.');
    }

    const conceptsText = Array.isArray(concepts)
      ? concepts.map(c => `- ${c.concept}: ${c.explanation}`).join('\n')
      : JSON.stringify(concepts);

    if (!chunk) {
      throw new Error('Chunk text is empty or undefined');
    }

    // Dynamically create the prompt based on position in the script
    let prompt;
    if (!previousScript) {
      // First chunk: Create a welcoming intro
      prompt = `You are a professional podcast script writer. Create the first segment of an engaging educational podcast (${partLabel}) based on the key concepts and source text that is understandable to a high school student. The segment should be 3-4 minutes when read aloud (~3000-4000 characters).\n\nKey Concepts to Cover:\n${conceptsText}\n\nSource Text for Context:\n${chunk}\n\nStructure: Start the script with the exact phrase "Welcome to another episode of ResearchPod!...". Then, discuss the relevant concepts and end this segment by smoothly transitioning to the main content. Return ONLY the spoken script as plain text, with no stage directions or sound effect placeholders like [Intro Music].`;
    } else if (isLastChunk) {
      // Last chunk: Create a concluding outro
      prompt = `You are a professional podcast script writer finishing a script. Here is the end of the previous part:\n"...${previousScript.slice(-1500)}"\n\nCreate the final segment using the new source text below. Ensure a seamless transition to a concluding summary. Wrap up the key concepts and provide a strong, memorable spoken outro for the entire podcast. This is the final part: ${partLabel}.\n\nKey Concepts to Cover:\n${conceptsText}\n\nSource Text for Context:\n${chunk}\n\nReturn ONLY the final spoken script as plain text, with no stage directions or sound effect placeholders.`;
    } else {
      // Middle chunks: Continue the narrative
      prompt = `You are a professional podcast script writer continuing a script. Here is the end of the previous part:\n"...${previousScript.slice(-1500)}"\n\nContinue the script using the new source text below. Ensure a seamless transition. Do not create a new intro or outro. Focus on the key concepts and smoothly connect to the next part. This is ${partLabel}.\n\nKey Concepts to Cover:\n${conceptsText}\n\nSource Text for Context:\n${chunk}\n\nReturn ONLY the new script segment as plain text, with no stage directions or sound effect placeholders.`;
    }

    console.log('[generatePodcastScript] Making OpenAI API call');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1500, // Increased slightly for more context flexibility
      })
    });

    console.log(`[generatePodcastScript] OpenAI API response status: ${response.status}`);
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[generatePodcastScript] OpenAI API error: ${response.status}`, errorBody);
      throw new Error(`OpenAI API error: ${response.status} - ${errorBody}`);
    }

    const data = await response.json();
    const script = data.choices?.[0]?.message?.content;

    if (!script) {
      console.error('[generatePodcastScript] Invalid response structure from OpenAI:', data);
      throw new Error('Invalid response structure from OpenAI API or empty script.');
    }

    console.log(`[generatePodcastScript] Successfully generated script of length ${script.length} for ${partLabel}`);
    return script.trim();
  } catch (error) {
    console.error('[generatePodcastScript] Error generating script:', error);
    throw error;
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

  try {
    await updateJob(jobId, { status: 'generating_script' });

    const supabaseAdmin = getSupabaseAdmin();

    const { data: job, error: fetchError } = await supabaseAdmin
      .from('podcast_jobs')
      .select('concepts, text_chunks, extracted_text, user_id')
      .eq('job_id', jobId)
      .single();

    if (fetchError || !job) {
      throw new Error(`Failed to fetch job ${jobId}: ${fetchError ? fetchError.message : 'Not found'}`);
    }

    let { concepts, text_chunks: textChunks, extracted_text: extractedText, user_id: userId } = job;
    
    if (!concepts) {
      console.warn(`Job ${jobId} is missing concepts, using fallback empty array`);
      concepts = [];
    }

    let chunks = textChunks || [extractedText];
    if (!chunks || chunks.length === 0 || chunks.every(c => !c || typeof c !== 'string' || c.trim().length === 0)) {
      throw new Error(`Job ${jobId} is missing valid text chunks or extracted text`);
    }

    console.log(`[generate-script-background] Generating a coherent script from ${chunks.length} chunks for job ${jobId}...`);
    
    let fullScript = '';
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const partLabel = `Part ${i + 1} of ${chunks.length}`;
      const isLastChunk = i === chunks.length - 1;
      
      // Pass the previous script content as context
      const scriptSegment = await generatePodcastScript(concepts, chunk, fullScript, partLabel, isLastChunk);
      
      fullScript += (fullScript ? '\n\n' : '') + scriptSegment;
      
      // Optional: Update progress in the database if needed
      // await updateJob(jobId, { progress: `${i + 1}/${chunks.length}` });
    }
    
    console.log(`[generate-script-background] Coherent script generated successfully for job ${jobId}.`);

    // Now we save the single, unified script
    await updateJob(jobId, { 
      status: 'script_generated', 
      generated_script: fullScript, // Store the final script
      script_chunks: null // Clear the old chunked data
    });

    console.log(`[generate-script-background] Triggering TTS generation for job ${jobId}...`);
    const ttsFunctionUrl = `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/generate-tts-background`;
    
    const response = await fetch(ttsFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ jobId, userId })
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
