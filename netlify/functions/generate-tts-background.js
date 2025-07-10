// Background Netlify Function: generate-tts-background
// Performs Google Cloud Text-to-Speech (Chirp3-HD) generation and triggers direct upload.
// Benefits from Netlify's background function timeout (~15 minutes).

const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { getSupabaseAdmin } = require('./supabaseClient');
const getMp3Duration = require('get-mp3-duration');

const { GOOGLE_CLOUD_CREDENTIALS, SUPABASE_URL, SUPABASE_KEY } = process.env;

async function updateJobStatus(supabase, jobId, status, { error = null, podcastUrl = null, duration = null } = {}) {
  const updateData = { status, updated_at: new Date().toISOString() };
  if (error) updateData.error_message = error;
  if (podcastUrl) updateData.podcast_url = podcastUrl;
  if (duration) updateData.duration_seconds = duration;
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
  if (!GOOGLE_CLOUD_CREDENTIALS || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing ENV for TTS background');
    return { statusCode: 500, body: 'Server config error' };
  }

  const { jobId, userId } = JSON.parse(event.body || '{}');
  if (!jobId || !userId) return { statusCode: 400, body: 'Missing params' };

  const supabase = getSupabaseAdmin();
  try {
    await updateJobStatus(supabase, jobId, 'generating_tts');

    // Fetch script_chunks (fallback to generated_script)
    const { data: jobData, error: fetchError } = await supabase
      .from('podcast_jobs')
      .select('script_chunks, generated_script, filename')
      .eq('job_id', jobId)
      .single();

    if (fetchError || !jobData) {
      throw new Error(`Failed to fetch job ${jobId}: ${fetchError?.message || 'No job data'}`);
    }

    let scriptChunks = jobData.script_chunks || [jobData.generated_script];
    if (!scriptChunks || scriptChunks.length === 0 || scriptChunks.every(s => !s || typeof s !== 'string' || s.trim().length === 0)) {
      throw new Error(`Job ${jobId} is missing valid script chunks or generated script`);
    }

    console.log(`[generate-tts-background] Processing ${scriptChunks.length} script chunks for job ${jobId}`);

    // Initialize Text-to-Speech client
    const client = new TextToSpeechClient({
      credentials: JSON.parse(GOOGLE_CLOUD_CREDENTIALS),
    });

    // Generate TTS per chunk and collect durations
    let totalDurationInSeconds = 0;
    const audioBuffers = await Promise.all(scriptChunks.map(async (script, index) => {
      if (script.length > 5000) {
        throw new Error(`Script chunk ${index + 1} exceeds 5000 characters`);
      }
      const request = {
        input: { text: script },
        voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Iapetus' },
        audioConfig: { audioEncoding: 'MP3', pitch: 0, speakingRate: 1.2 },
      };

      const [response] = await client.synthesizeSpeech(request);
      const audioBuffer = response.audioContent;
      console.log(`TTS audio for chunk ${index + 1} received. bytes= ${audioBuffer.length}`);

      // Accumulate duration per chunk
      const chunkDurationMs = getMp3Duration(audioBuffer);
      totalDurationInSeconds += Math.round(chunkDurationMs / 1000);

      return audioBuffer;
    }));

    // Concatenate audio buffers directly (works for identical MP3 encodings)
    const finalAudioBuffer = Buffer.concat(audioBuffers);
    console.log(`[generate-tts-background] Concatenated audio. Total bytes: ${finalAudioBuffer.length}, duration: ${totalDurationInSeconds}s`);

    await updateJobStatus(supabase, jobId, 'uploading');

    // Create a human-readable name from the PDF filename
    let podcastName = 'podcast';
    if (jobData.filename) {
      podcastName = jobData.filename
        .replace(/\.pdf$/i, '') // Remove PDF extension
        .replace(/[^a-z0-9\s-]/gi, '') // Remove special characters
        .trim();
    }

    const filename = `${podcastName}_${Date.now()}.mp3`;
    const base64Audio = finalAudioBuffer.toString('base64');

    const host = event.headers.host;
    const proto = host.includes('localhost') ? 'http' : 'https';
    const directUploadUrl = `${proto}://${host}/.netlify/functions/direct-upload`;
    const uploadPayload = {
      jobId: jobId,
      userId: userId,
      filename: filename,
      audioData: base64Audio,
    };
    const uploadRes = await fetch(directUploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadPayload),
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
    await updateJobStatus(supabase, jobId, 'completed', { podcastUrl, duration: totalDurationInSeconds });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Podcast generation completed successfully.', podcastUrl: podcastUrl }),
    };
  } catch (error) {
    console.error('Error in TTS generation or upload trigger:', error);
    await updateJobStatus(supabase, jobId, 'failed', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
