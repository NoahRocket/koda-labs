const fetch = require('node-fetch');
const { getSupabaseAdmin } = require('./supabaseClient');
const pdf = require('pdf-parse');

const PDF_BUCKET_NAME = 'podcasts'; // Changed to match upload-pdf.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Helper to update job status and error
async function updateJobStatus(jobId, status, errorMessage = null, concepts = null) {
  const supabaseAdmin = getSupabaseAdmin();
  const updateData = { status: status };
  if (errorMessage) updateData.error_message = errorMessage;
  if (concepts) updateData.concepts = concepts;

  const { error } = await supabaseAdmin
    .from('podcast_jobs')
    .update(updateData)
    .eq('job_id', jobId);
  if (error) {
    console.error(`Failed to update job ${jobId} to status ${status}:`, error);
  }
}

// Helper to trigger the next step in the pipeline
async function triggerNextStep(jobId, currentEvent) {
  try {
    const domain = currentEvent.headers.host;
    const protocol = domain.includes('localhost') ? 'http' : 'https';
    // Corrected endpoint to trigger script generation directly
    const workerUrl = `${protocol}://${domain}/.netlify/functions/generate-script-background`;

    console.log(`[analyze-pdf-text] Triggering generate-script-background for job ${jobId} at: ${workerUrl}`);

    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Use service role key for inter-function communication
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({ jobId: jobId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // This is a critical failure in the pipeline, so it should be logged as an error.
      console.error(`[analyze-pdf-text] CRITICAL: Failed to trigger generate-script-background for job ${jobId}: ${response.status} ${errorText}`);
      // Update job status to reflect this failure.
      await updateJobStatus(jobId, 'failed', `Failed to trigger script generation: ${response.status}`);
    } else {
      console.log(`[analyze-pdf-text] Successfully triggered generate-script-background for job ${jobId}.`);
    }
  } catch (error) {
    console.error(`[analyze-pdf-text] CRITICAL: Error triggering generate-script-background for job ${jobId}:`, error);
    await updateJobStatus(jobId, 'failed', `Error triggering script generation: ${error.message}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!OPENAI_API_KEY) {
    console.error('[analyze-pdf-text] OPENAI_API_KEY not configured.');
    // No jobId available here to update status, this is a server config issue
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: LLM API key missing.' }) };
  }

  let jobId;
  try {
    const body = JSON.parse(event.body);
    jobId = body.jobId;
    if (!jobId) throw new Error('Missing jobId in request body.');
  } catch (parseError) {
    console.error('[analyze-pdf-text] Invalid request body:', parseError);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body. Expected { jobId: "..." }' }) };
  }

  console.log(`[analyze-pdf-text] Processing job ID: ${jobId}`);
  await updateJobStatus(jobId, 'analyzing_text');

  try {
    // 1. Fetch job details with the extracted text we already have
    const supabaseAdmin = getSupabaseAdmin();
    const { data: jobData, error: fetchError } = await supabaseAdmin
      .from('podcast_jobs')
      .select('generated_script, filename')
      .eq('job_id', jobId)
      .single();

    if (fetchError || !jobData) {
      await updateJobStatus(jobId, 'failed', `Failed to fetch job details: ${fetchError?.message || 'No job data'}`);
      return { statusCode: 404, body: JSON.stringify({ error: 'Job not found.' }) };
    }

    // 2. Get the text that was previously extracted in upload-pdf.js
    console.log(`[analyze-pdf-text] Using pre-extracted text from job record for: ${jobData.filename}`);
    const extractedText = jobData.generated_script || '';
    if (!extractedText.trim()) {
      await updateJobStatus(jobId, 'failed', 'No text found in PDF.');
      return { statusCode: 400, body: JSON.stringify({ error: 'No text could be extracted from the PDF.' }) };
    }
    console.log(`[analyze-pdf-text] Extracted ${extractedText.length} characters.`);

    // Word count check (optional, can be adjusted)
    const wordCount = extractedText.trim().split(/\s+/).length;
    if (wordCount > 15000) { // Increased limit slightly
      await updateJobStatus(jobId, 'failed', 'Text content too long (max 15,000 words).');
      return { statusCode: 413, body: JSON.stringify({ error: 'Text is too long (max 15,000 words).' }) };
    }

    // 4. Analyze concepts using OpenAI
    const prompt = `Analyze the following text. Identify the top 3-5 key concepts and provide a brief (1-2 sentence) explanation for each. Return your answer as a JSON array of objects with 'concept' and 'explanation' fields.\n\nText:\n"""${extractedText.substring(0, 12000)}"""`; // Use a larger substring for prompt if text is long
    
    console.log('[analyze-pdf-text] Sending text to OpenAI for concept extraction.');
    const llmResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini', 
        messages: [
          { role: 'system', content: 'You are an expert assistant for extracting key concepts from documents.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3, // Lower temperature for more consistent results
        max_tokens: 800 // Parameter name correction for better reliability
      })
    });

    if (!llmResponse.ok) {
      const errorBody = await llmResponse.text();
      await updateJobStatus(jobId, 'failed', `LLM API error: ${llmResponse.status} - ${errorBody}`);
      throw new Error(`LLM API error: ${llmResponse.status} - ${errorBody}`);
    }

    const llmData = await llmResponse.json();
    const llmContent = llmData.choices?.[0]?.message?.content;
    let conceptsArray = null;
    try {
      conceptsArray = JSON.parse(llmContent);
    } catch {
      const match = llmContent.match(/\[.*?\]/s); // More robust regex for JSON array
      if (match && match[0]) conceptsArray = JSON.parse(match[0]);
    }

    if (!Array.isArray(conceptsArray)) {
      await updateJobStatus(jobId, 'failed', 'LLM response for concepts not in expected JSON array format.');
      throw new Error('LLM response not in expected format.');
    }
    
    const sanitizedConcepts = conceptsArray.map(({ concept, explanation }) => ({
      concept: String(concept || '').replace(/[<>]/g, ''),
      explanation: String(explanation || '').replace(/[<>]/g, '')
    })).filter(c => c.concept && c.explanation); // Ensure concepts are valid

    console.log(`[analyze-pdf-text] Concepts extracted successfully for job ${jobId}.`);

    // 5. Update job with concepts and new status
    await updateJobStatus(jobId, 'text_analyzed', null, sanitizedConcepts);

    // 6. Trigger next step (generate-script-background.js)
    await triggerNextStep(jobId, event);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: `Text analysis complete for job ${jobId}. Triggered script generation.` })
    };

  } catch (error) {
    console.error(`[analyze-pdf-text] Error processing job ${jobId}:`, error);
    // Ensure status is updated to failed if not already
    await updateJobStatus(jobId, 'failed', error.message || 'Unknown error during text analysis.');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Failed to analyze text for job ${jobId}: ${error.message}` })
    };
  }
};
