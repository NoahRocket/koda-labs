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

// Helper to check if job has been cancelled
const checkJobCancelled = async (jobId) => {
  const supabaseAdmin = getSupabaseAdmin();

  const { data: job, error } = await supabaseAdmin
    .from('podcast_jobs')
    .select('status')
    .eq('job_id', jobId)
    .single();
  if (error) {
    console.error(`[checkJobCancelled] Error checking job status:`, error);
    return false;
  }
  const isCancelled = job.status === 'cancelled';
  if (isCancelled) {
    console.log(`[checkJobCancelled] Job ${jobId} has been cancelled, stopping processing`);
  }

  return isCancelled;
};

// Updated to generate script per chunk with concept tracking
async function generatePodcastScript(jobId, concepts, chunk, previousScript, coveredConcepts, partLabel, isLastChunk) {
  console.log(`[generatePodcastScript] Starting script generation for ${partLabel}`);
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured.');
    }
    const conceptsText = Array.isArray(concepts)
      ? concepts.map(c => `- ${c.concept}: ${c.explanation}`).join('\n')
      : JSON.stringify(concepts);
    const coveredConceptsText = Array.isArray(coveredConcepts)
      ? coveredConcepts.map(c => `- ${c}`).join('\n')
      : '';
    if (!chunk) {
      throw new Error('Chunk text is empty or undefined');
    }

    // Dynamically create the prompt based on position in the script
    let prompt;
    if (!previousScript) {
      // First chunk: Create a welcoming intro
      prompt = `You are a professional podcast script writer specializing in making complex research accessible. Target audience: high school-educated listeners who are curious but not experts. Explain basic concepts clearly without assuming prior knowledge, while maintaining sophistication by discussing nuances and implications without oversimplifying or using pop-science hype. Create the first segment of an engaging educational podcast (${partLabel}) based on the key concepts and source text. The segment should be 3-4 minutes when read aloud (~3000-4000 characters).

    Key Guidelines:
    - Explain Terminology and Concepts: Identify key terms from the source (e.g., technical jargon, acronyms) and explain them step-by-step: start with a simple definition, then the underlying idea, and why it matters. Use relatable analogies only if they add depth without oversimplifying.
    - Build from Basics: Assume listeners know everyday concepts but not field-specific ones. Break down ideas progressively to ensure understanding.
    - Engagement: Make it conversational: pose rhetorical questions, use real-world examples tied to the research, and build excitement through clear storytelling.
    - Avoid Repetition: Focus on fresh insights; do not recap unless transitioning.
    - Style: Avoid em dashes and phrases like "it's more than X, it's Y" to maintain a professional tone.

    Key Concepts to Cover:
    ${conceptsText}

    Source Text for Context:
    ${chunk}

    Structure: Start the script with the exact phrase "Welcome to another episode of ResearchPod!...". Then, discuss the relevant concepts and end this segment by smoothly transitioning to the main content. Return ONLY the spoken script as plain text, with no stage directions or sound effect placeholders like [Intro Music].`;
    } else if (isLastChunk) {
      // Last chunk: Create a concluding outro
      prompt = `You are a professional podcast script writer specializing in making complex research accessible. Target audience: high school-educated listeners who are curious but not experts. Explain basic concepts clearly without assuming prior knowledge, while maintaining sophistication by discussing nuances and implications without oversimplifying or using pop-science hype. Here is the end of the previous part:
    "...${previousScript.slice(-500)}"

    Create the final segment using the new source text below. Ensure a seamless transition to a concluding summary. Wrap up the key concepts without repeating those already covered, emphasizing takeaways, real-world implications, and open questions for sophistication. This is the final part: ${partLabel}. The segment should be 3-4 minutes when read aloud (~3000-4000 characters).

    Key Guidelines:
    - Explain Terminology and Concepts: Identify key terms from the source (e.g., technical jargon, acronyms) and explain them step-by-step: start with a simple definition, then the underlying idea, and why it matters. Use relatable analogies only if they add depth without oversimplifying.
    - Build from Basics: Assume listeners know everyday concepts but not field-specific ones. Break down ideas progressively to ensure understanding.
    - Engagement: Make it conversational: pose rhetorical questions, use real-world examples tied to the research, and build excitement through clear storytelling.
    - Avoid Repetition: Do not re-explain concepts listed below that were covered in prior segments. Reference them subtly only if needed for context.
    - Style: Avoid em dashes and phrases like "it's more than X, it's Y" to maintain a professional tone.

    Concepts Already Covered in Previous Segments:
    ${coveredConceptsText}

    Key Concepts to Cover:
    ${conceptsText}

    Source Text for Context:
    ${chunk}

    Structure: End the script with the exact phrase "Thank you for tuning in to this episode and see you in the next one!". Return ONLY the final spoken script as plain text, with no stage directions or sound effect placeholders.`;
    } else {
      // Middle chunks: Continue the narrative
      prompt = `You are a professional podcast script writer specializing in making complex research accessible. Target audience: high school-educated listeners who are curious but not experts. Explain basic concepts clearly without assuming prior knowledge, while maintaining sophistication by discussing nuances and implications without oversimplifying or using pop-science hype. Here is the end of the previous part:
    "...${previousScript.slice(-500)}"

    Continue the script using the new source text below. Ensure a seamless transition. Do not create a new intro or outro. Focus on the key concepts not yet covered and smoothly connect to the next part. This is ${partLabel}. The segment should be 3-4 minutes when read aloud (~3000-4000 characters).

    Key Guidelines:
    - Explain Terminology and Concepts: Identify key terms from the source (e.g., technical jargon, acronyms) and explain them step-by-step: start with a simple definition, then the underlying idea, and why it matters. Use relatable analogies only if they add depth without oversimplifying.
    - Build from Basics: Assume listeners know everyday concepts but not field-specific ones. Break down ideas progressively to ensure understanding.
    - Engagement: Make it conversational: pose rhetorical questions, use real-world examples tied to the research, and build excitement through clear storytelling.
    - Avoid Repetition: Do not re-explain concepts listed below that were covered in prior segments. Reference them subtly only if needed for context.
    - Style: Avoid em dashes and phrases like "it's more than X, it's Y" to maintain a professional tone.

    Concepts Already Covered in Previous Segments:
    ${coveredConceptsText}

    Key Concepts to Cover:
    ${conceptsText}

    Source Text for Context:
    ${chunk}

    Return ONLY the new script segment as plain text, with no stage directions or sound effect placeholders.`;
    }

    console.log('[generatePodcastScript] Making OpenAI API call');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1500,
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
    let coveredConcepts = []; // Track concepts covered across chunks
    for (let i = 0; i < chunks.length; i++) {
      if (await checkJobCancelled(jobId)) {
        console.log(`[generate-script-background] Job ${jobId} was cancelled, stopping script generation`);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'Job cancelled by user', cancelled: true })
        };
      }

      const chunk = chunks[i];
      const partLabel = `Part ${i + 1} of ${chunks.length}`;
      const isLastChunk = i === chunks.length - 1;

      // Generate script for the current chunk, passing covered concepts
      const scriptSegment = await generatePodcastScript(jobId, concepts, chunk, fullScript, coveredConcepts, partLabel, isLastChunk);

      if (scriptSegment === null) {
        console.log(`[generate-script-background] Script generation cancelled for job ${jobId}`);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'Job cancelled by user during script generation', cancelled: true })
        };
      }

      fullScript += (fullScript ? '\n\n' : '') + scriptSegment;

      // Update covered concepts (simplified: assume concepts in current chunk are covered)
      const currentConcepts = Array.isArray(concepts)
        ? concepts.map(c => c.concept)
        : Object.keys(concepts);
      coveredConcepts = [...new Set([...coveredConcepts, ...currentConcepts])]; // Avoid duplicates
    }

    console.log(`[generate-script-background] Coherent script generated successfully for job ${jobId}.`);
    await updateJob(jobId, {
      status: 'script_generated',
      generated_script: fullScript,
      script_chunks: null
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
