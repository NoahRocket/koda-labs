// Background Netlify Function: generate-tts-background
// Performs Google Cloud Text-to-Speech (Chirp3-HD) generation and triggers direct upload.
// Benefits from Netlify's background function timeout (~15 minutes).

const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { getSupabaseAdmin } = require('./supabaseClient');
const getMp3Duration = require('get-mp3-duration');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);

const { GOOGLE_CLOUD_CREDENTIALS, SUPABASE_URL, SUPABASE_KEY } = process.env;

// Define limits for podcast generation
const MAX_DURATION_SECONDS = 930; // 15.5 minutes, safely under 16 minutes
const MAX_PAYLOAD_SIZE_BYTES = 4.4 * 1024 * 1024; // 4.4MB, safely under Netlify's 4.5MB limit

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

    // Function to optimize text and split into chunks under 5000 characters
    function optimizeAndSplitText(text, maxChars = 4800) { // Using 4800 to leave some margin
      // Optimize text: normalize whitespace and reduce excessive newlines
      const optimized = text
        .replace(/\s+/g, ' ')         // Convert multiple whitespaces to a single space
        .replace(/\n\s*\n+/g, '\n')  // Replace multiple blank lines with a single newline
        .trim();
      
      // If the optimized text is under limit, return it as a single chunk
      if (optimized.length <= maxChars) {
        return [optimized];
      }
      
      // Otherwise, split by sentences at natural breakpoints
      const chunks = [];
      let currentChunk = '';
      
      // Split by sentences and try to keep sentences together
      const sentences = optimized.split(/(?<=[.!?])\s+/);
      
      for (const sentence of sentences) {
        // If adding this sentence exceeds the limit, start a new chunk
        if (currentChunk.length + sentence.length > maxChars) {
          // If current sentence is too long by itself, split it by words
          if (sentence.length > maxChars) {
            // First add the current chunk if not empty
            if (currentChunk) {
              chunks.push(currentChunk);
              currentChunk = '';
            }
            
            // Split long sentence by words
            let tempSentence = sentence;
            while (tempSentence.length > maxChars) {
              // Find a good breaking point (preferably at punctuation or space)
              let breakPoint = maxChars;
              while (breakPoint > 0 && !/[,;:\s]/.test(tempSentence.charAt(breakPoint))) {
                breakPoint--;
              }
              // If no good breaking point found, just break at the limit
              if (breakPoint === 0) breakPoint = maxChars;
              
              chunks.push(tempSentence.substring(0, breakPoint + 1).trim());
              tempSentence = tempSentence.substring(breakPoint + 1).trim();
            }
            // Add remaining part of the sentence
            if (tempSentence) currentChunk = tempSentence;
          } else {
            // Current sentence fits in a chunk by itself
            chunks.push(currentChunk);
            currentChunk = sentence;
          }
        } else {
          // Add sentence to current chunk
          currentChunk += (currentChunk ? ' ' : '') + sentence;
        }
      }
      
      // Add the last chunk if not empty
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      
      console.log(`Split text into ${chunks.length} smaller chunks to meet TTS character limit`);
      return chunks;
    }

    // Process each script chunk, splitting if necessary
    const processedScriptChunks = [];
    scriptChunks.forEach((script, index) => {
      if (!script || typeof script !== 'string') return;
      const splitChunks = optimizeAndSplitText(script);
      processedScriptChunks.push(...splitChunks);
    });
    
    console.log(`[generate-tts-background] Processing ${processedScriptChunks.length} script chunks for job ${jobId} (after optimization and splitting)`);

    // Initialize Text-to-Speech client
    const client = new TextToSpeechClient({
      credentials: JSON.parse(GOOGLE_CLOUD_CREDENTIALS),
    });

    // Generate TTS per chunk and collect durations
    let totalDurationInSeconds = 0;
    const audioBuffers = [];

    console.log(`Starting TTS generation with a max duration of ${MAX_DURATION_SECONDS} seconds.`);

    for (const [index, chunk] of processedScriptChunks.entries()) {
      if (totalDurationInSeconds >= MAX_DURATION_SECONDS) {
        console.log(`Max duration of ${MAX_DURATION_SECONDS}s reached. Stopping TTS generation at chunk ${index + 1}.`);
        break;
      }

      const request = {
        input: { text: chunk },
        voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Iapetus' },
        audioConfig: { audioEncoding: 'MP3', pitch: 0, speakingRate: 1.2 },
      };

      const [response] = await client.synthesizeSpeech(request);
      const audioBuffer = response.audioContent;
      const chunkDurationMs = getMp3Duration(audioBuffer);
      const chunkDurationSec = Math.round(chunkDurationMs / 1000);

      console.log(`TTS for chunk ${index + 1}/${processedScriptChunks.length}: duration=${chunkDurationSec}s, size=${audioBuffer.length} bytes. Total duration so far: ${totalDurationInSeconds + chunkDurationSec}s`);

      totalDurationInSeconds += chunkDurationSec;
      audioBuffers.push(audioBuffer);
    }

    if (audioBuffers.length === 0) {
      throw new Error('No audio was generated. The script might be empty or too short.');
    }

    // Use ffmpeg to concatenate audio buffers
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-audio-'));
    const listFilePath = path.join(tempDir, 'concat-list.txt');
    let finalAudioBuffer;

    try {
      const fileListContent = audioBuffers.map((_, i) => {
        const tempFilePath = path.join(tempDir, `chunk-${i}.mp3`);
        // On Windows, path.join uses backslashes. ffmpeg's concat demuxer requires forward slashes.
        return `file '${tempFilePath.split(path.sep).join('/')}'`;
      }).join('\n');

      await Promise.all(audioBuffers.map((buffer, i) => {
        const tempFilePath = path.join(tempDir, `chunk-${i}.mp3`);
        return fs.writeFile(tempFilePath, buffer);
      }));

      await fs.writeFile(listFilePath, fileListContent);

      const concatenatedAudioPath = path.join(tempDir, 'final-podcast.mp3');

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFilePath)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions('-c copy')
          .save(concatenatedAudioPath)
          .on('end', resolve)
          .on('error', (err) => reject(new Error(`ffmpeg concatenation failed: ${err.message}`)));
      });

      finalAudioBuffer = await fs.readFile(concatenatedAudioPath);
      console.log(`[generate-tts-background] Concatenated audio with ffmpeg. Total bytes: ${finalAudioBuffer.length}, duration: ${totalDurationInSeconds}s`);

    } finally {
      // Clean up temporary files and directory
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`Cleaned up temporary directory: ${tempDir}`);
    }

    await updateJobStatus(supabase, jobId, 'uploading');

    // Final safety check for payload size before triggering upload
    if (finalAudioBuffer.length > MAX_PAYLOAD_SIZE_BYTES) {
      const errorMsg = `Generated audio file (${(finalAudioBuffer.length / 1024 / 1024).toFixed(2)}MB) exceeds the size limit of ${(MAX_PAYLOAD_SIZE_BYTES / 1024 / 1024).toFixed(2)}MB.`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Create a human-readable name from the PDF filename
    let podcastName = 'podcast';
    if (jobData.filename) {
      podcastName = jobData.filename
        .replace(/\.pdf$/i, '') // Remove PDF extension
        .replace(/[^a-z0-9\s-]/gi, '') // Remove special characters
        .trim();
    }

    const filename = `${podcastName}.mp3`;
    
    // Calculate file sizes for logging and validation
    const fileSizeInBytes = finalAudioBuffer.length;
    const fileSizeInMB = fileSizeInBytes / (1024 * 1024);
    
    // Log detailed information about the audio file
    console.log(`[generate-tts-background] Audio duration: ${totalDurationInSeconds} seconds (${(totalDurationInSeconds/60).toFixed(2)} minutes)`);
    console.log(`[generate-tts-background] Audio file size: ${fileSizeInBytes} bytes (${fileSizeInMB.toFixed(2)} MB)`);
    
    // We already have a MAX_PAYLOAD_SIZE_BYTES check above, but let's add more detailed logging
    console.log(`[generate-tts-background] Upload limit: ${(MAX_PAYLOAD_SIZE_BYTES/1024/1024).toFixed(2)} MB, Current file: ${fileSizeInMB.toFixed(2)} MB`);
    
    const base64Audio = finalAudioBuffer.toString('base64');
    const base64SizeInMB = base64Audio.length / (1024 * 1024);
    console.log(`[generate-tts-background] Base64 encoded size: ${base64Audio.length} characters (${base64SizeInMB.toFixed(2)} MB)`);
    
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
