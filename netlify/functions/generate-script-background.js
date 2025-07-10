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
async function generatePodcastScriptChunk(concepts, chunk, index, totalChunks) {
  console.log(`[generatePodcastScriptChunk] Starting script generation for chunk ${index + 1}/${totalChunks}`);
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured.');
    }
    
    console.log('[generatePodcastScriptChunk] Formatting concepts and chunk text');
    // Format concepts from the array of objects
    const conceptsText = Array.isArray(concepts) ? 
      concepts.map(c => `- ${c.concept}: ${c.explanation}`).join('\n') :
      JSON.stringify(concepts); // Fallback if concepts is not array
    
    // No truncation needed per chunk (already sized appropriately)
    if (!chunk) {
      throw new Error('Chunk text is empty or undefined');
    }
    
    console.log(`[generatePodcastScriptChunk] Prepared ${conceptsText.length} bytes of concepts and ${chunk.length} bytes of text`);

    const partLabel = totalChunks > 1 ? `Part ${index + 1} of ${totalChunks}` : '';
    const prompt = `You are a professional podcast script writer. Create a concise, engaging educational podcast script segment (${partLabel}) based on the key concepts and this source text chunk. Keep it to 3-4 minutes when read aloud (~3000-4000 characters).

Key Concepts to Cover:
${conceptsText}

Source Text for Context:
${chunk}

The script should be conversational and accessible. Structure: brief intro (link to previous if not first), main body discussing relevant concepts, short outro (tease next if not last). Focus on spoken content only—no stage directions. Return ONLY the script as plain text.`;

    console.log('[generatePodcastScriptChunk] Making OpenAI API call');
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
        max_tokens: 1000,  // Enforce brevity
      })
    });

    console.log(`[generatePodcastScriptChunk] OpenAI API response status: ${response.status}`);
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[generatePodcastScriptChunk] OpenAI API error: ${response.status}`, errorBody);
      throw new Error(`OpenAI API error: ${response.status} - ${errorBody}`);
    }

    console.log('[generatePodcastScriptChunk] Parsing OpenAI response');
    const data = await response.json();
    const script = data.choices?.[0]?.message?.content;

    if (!script) {
      console.error('[generatePodcastScriptChunk] Invalid response structure from OpenAI:', data);
      throw new Error('Invalid response structure from OpenAI API or empty script.');
    }
    
    console.log(`[generatePodcastScriptChunk] Successfully generated script of length ${script.length} for chunk ${index + 1}`);
    return script.trim();
  } catch (error) {
    console.error('[generatePodcastScriptChunk] Error generating script:', error);
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

  try {
    await updateJob(jobId, { status: 'generating_script' });

    const supabaseAdmin = getSupabaseAdmin();

    // Fetch with timeout
    const fetchPromise = supabaseAdmin
      .from('podcast_jobs')
      .select('concepts, text_chunks, extracted_text, user_id')
      .eq('job_id', jobId)
      .single();
    
    const { data: job, error: fetchError } = await Promise.race([
      fetchPromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Database query timed out after 10s')), 10000)
      )
    ]);

    if (fetchError || !job) {
      throw new Error(`Failed to fetch job ${jobId}: ${fetchError ? fetchError.message : 'Not found'}`);
    }

    const { concepts, text_chunks: textChunks, extracted_text: extractedText, user_id: userId } = job;
    
    // Validate inputs
    if (!concepts) {
      console.warn(`Job ${jobId} is missing concepts, using fallback empty array`);
      concepts = [];
    }

    let chunks = textChunks || [extractedText];
    if (!chunks || chunks.length === 0 || chunks.every(c => !c || typeof c !== 'string' || c.trim().length === 0)) {
      throw new Error(`Job ${jobId} is missing valid text chunks or extracted text`);
    }

    console.log(`[generate-script-background] Generating scripts for ${chunks.length} chunks in job ${jobId}...`);
    
    const scriptPromises = chunks.map((chunk, index) => 
      generatePodcastScriptChunk(concepts, chunk, index, chunks.length)
    );
    
    const scriptChunks = await Promise.all(scriptPromises);
    
    console.log(`[generate-script-background] Scripts generated successfully for job ${jobId}.`);

    await updateJob(jobId, { 
      status: 'script_generated', 
      script_chunks: scriptChunks  // Array for chunked processing
    });

    console.log(`[generate-script-background] Triggering TTS generation for job ${jobId}...`);
    const ttsFunctionUrl = `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/generate-tts-background`;
    
    const response = await fetch(ttsFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ jobId, userId })  // No scriptText; TTS will fetch from DB
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
