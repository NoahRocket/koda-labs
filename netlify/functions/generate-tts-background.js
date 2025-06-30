// Background Netlify Function: generate-tts-background
// Performs ElevenLabs TTS generation and triggers direct upload.
// Identical to generate-tts.js but benefits from Netlify's background
// function timeout (~15 minutes) instead of the standard 10–30 seconds.

const fetch = require('node-fetch');
const { getSupabaseAdmin } = require('./supabaseClient');

const { ELEVENLABS_API_KEY, SUPABASE_URL, SUPABASE_KEY } = process.env;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech/';
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Example voice ID

async function updateJobStatus(supabase, jobId, status, error = null, podcastUrl = null) {
  const updateData = { status, updated_at: new Date().toISOString() };
  if (error) updateData.error_message = error;
  if (podcastUrl) updateData.podcast_url = podcastUrl;
  const { data, error: updateError } = await supabase
    .from('podcast_jobs')
    .update(updateData)
    .eq('job_id', jobId)
    .select();

  if (updateError) {
    console.error(`Error updating job ${jobId} to ${status}:`, updateError);
  } else {
    console.log(`Job ${jobId} updated to ${status}. Result:`, data);
  }
}

exports.handler = async (event, context) => {
  console.log('generate-tts-background invoked');
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // Secure the endpoint: only allow calls with the service role key
  const authHeader = event.headers.authorization;
  const expectedAuth = `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
  if (!authHeader || authHeader !== expectedAuth) {
    console.warn('[generate-tts-background] Unauthorized access attempt.');
    return { statusCode: 401, body: 'Unauthorized' };
  }
  if (!ELEVENLABS_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing ENV for TTS background');
    return { statusCode: 500, body: 'Server config error' };
  }

  const { jobId, userId, scriptText } = JSON.parse(event.body || '{}');
  if (!jobId || !userId || !scriptText) return { statusCode: 400, body: 'Missing params' };

  const supabase = getSupabaseAdmin();
  try {
    await updateJobStatus(supabase, jobId, 'generating_tts');
    const ttsRes = await fetch(`${ELEVENLABS_API_URL}${VOICE_ID}`, {
      method: 'POST',
      headers: {
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({ text: scriptText, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.7, similarity_boost: 0.8 } })
    });
    if (!ttsRes.ok) throw new Error(await ttsRes.text());
    const audioBuffer = await ttsRes.buffer();
    console.log(`TTS audio received. bytes= ${audioBuffer.length}`);

    await updateJobStatus(supabase, jobId, 'uploading');
    
    // Get the original PDF filename to create a human-readable podcast name
    const { data: jobData } = await supabase
      .from('podcast_jobs')
      .select('filename')
      .eq('job_id', jobId)
      .single();
    
    // Create a human-readable name from the PDF filename
    let podcastName = 'podcast';
    if (jobData && jobData.filename) {
      // Remove .pdf extension and clean up the filename
      podcastName = jobData.filename
        .replace(/\.pdf$/i, '') // Remove PDF extension
        .replace(/[^a-z0-9\s-]/gi, '') // Remove special characters
        .trim();
    }
    
    const filename = `${podcastName}_${Date.now()}.mp3`;
    const base64Audio = audioBuffer.toString('base64');

    const host = event.headers.host;
    const proto = host.includes('localhost') ? 'http' : 'https';
    const directUploadUrl = `${proto}://${host}/.netlify/functions/direct-upload`;
    const uploadPayload = {
      jobId: jobId,
      userId: userId,
      filename: filename,
      audioData: base64Audio
    };
    const uploadRes = await fetch(directUploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadPayload)
    });

    if (!uploadRes.ok) {
      const errorBody = await uploadRes.text();
      throw new Error(`Direct upload failed with status ${uploadRes.status}: ${errorBody}`);
    }

    const uploadResult = await uploadRes.json();
    const podcastUrl = uploadResult.publicUrl;

    if (!podcastUrl) {
      console.error('Direct upload succeeded but did not return a publicUrl.');
      throw new Error('Failed to get podcast URL after upload.');
    }

    console.log(`Podcast uploaded successfully. URL: ${podcastUrl}`);
    await updateJobStatus(supabase, jobId, 'completed', null, podcastUrl);

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Podcast generation completed successfully.', podcastUrl: podcastUrl })
    };
  } catch (error) {
    console.error('Error in TTS generation or upload trigger:', error);
    await updateJobStatus(supabase, jobId, 'failed', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
