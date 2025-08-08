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

async function updateJobStatus(supabase, jobId, status, options = {}) {
  const { error = null, podcastUrl = null, duration = null, filename = null, ...rest } = options;
  const updateData = { updated_at: new Date().toISOString() };
  if (status) updateData.status = status; // Only set status if provided to avoid check constraint issues
  if (error) updateData.error_message = error;
  if (podcastUrl) updateData.podcast_url = podcastUrl;
  if (duration) updateData.duration_seconds = duration;
  if (filename) updateData.filename = filename;
  // include any additional fields like progress
  Object.assign(updateData, rest);
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

// Helper to check if job has been cancelled
async function checkJobCancelled(supabase, jobId) {
  const { data: job, error } = await supabase
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
    // Avoid setting status to values that may violate DB check constraints; just bump updated_at
    await updateJobStatus(supabase, jobId, null);

    // Fetch script_chunks (fallback to generated_script)
    const { data: jobData, error: fetchError } = await supabase
      .from('podcast_jobs')
      .select('script_chunks, generated_script, filename')
      .eq('job_id', jobId)
      .single();

    if (fetchError || !jobData) {
      throw new Error(`Failed to fetch job ${jobId}: ${fetchError?.message || 'No job data'}`);
    }

    // Prefer unified generated_script when available to reduce total TTS calls
    let scriptChunks;
    if (jobData.generated_script && typeof jobData.generated_script === 'string' && jobData.generated_script.trim().length > 0) {
      scriptChunks = [jobData.generated_script];
    } else {
      scriptChunks = jobData.script_chunks;
    }
    if (!scriptChunks || scriptChunks.length === 0 || scriptChunks.every(s => !s || typeof s !== 'string' || s.trim().length === 0)) {
      throw new Error(`Job ${jobId} is missing valid script chunks or generated script`);
    }

    // Function to optimize text and split into chunks under 5000 bytes (UTF-8)
    function optimizeAndSplitText(text, maxBytes = 4200) { // More conservative to reduce 502/timeouts
      // Optimize text: normalize whitespace and reduce excessive newlines
      const optimized = text
        .replace(/\s+/g, ' ')         // Convert multiple whitespaces to a single space
        .replace(/\n\s*\n+/g, '\n')  // Replace multiple blank lines with a single newline
        .trim();

      // Use TextEncoder for accurate UTF-8 byte counting
      const encoder = new TextEncoder();
      
      // If the optimized text is under byte limit, return it as a single chunk
      if (encoder.encode(optimized).length <= maxBytes) {
        return [optimized];
      }

      // Note: This function is pure/synchronous. Do not place async control flow here.
      
      // Otherwise, split by sentences at natural breakpoints using byte limits
      const chunks = [];
      let currentChunk = '';
      
      // Split by sentences and try to keep sentences together
      const sentences = optimized.split(/(?<=[.!?])\s+/);
      
      for (const sentence of sentences) {
        const potentialChunk = currentChunk ? currentChunk + ' ' + sentence : sentence;
        const potentialBytes = encoder.encode(potentialChunk).length;
        
        // If adding this sentence exceeds the byte limit, start a new chunk
        if (potentialBytes > maxBytes) {
          // If current sentence is too long by itself, split it by words
          const sentenceBytes = encoder.encode(sentence).length;
          if (sentenceBytes > maxBytes) {
            // First add the current chunk if not empty
            if (currentChunk) {
              chunks.push(currentChunk);
              currentChunk = '';
            }
            
            // Split long sentence by characters to stay under byte limit
            let tempSentence = sentence;
            while (encoder.encode(tempSentence).length > maxBytes) {
              // Find a good breaking point (preferably at punctuation or space)
              let breakPoint = Math.floor(maxBytes / 4); // Conservative estimate for UTF-8
              let found = false;
              
              // Try to find a good breaking point
              for (let i = breakPoint; i > 0; i--) {
                const testChunk = tempSentence.substring(0, i);
                if (encoder.encode(testChunk).length <= maxBytes && /[,;:\s]/.test(tempSentence.charAt(i-1))) {
                  breakPoint = i;
                  found = true;
                  break;
                }
              }
              
              // If no good breaking point, just break at byte limit
              if (!found) {
                let low = 1, high = tempSentence.length;
                while (low < high) {
                  const mid = Math.floor((low + high) / 2);
                  if (encoder.encode(tempSentence.substring(0, mid)).length <= maxBytes) {
                    low = mid + 1;
                  } else {
                    high = mid;
                  }
                }
                breakPoint = low - 1;
              }
              
              if (breakPoint <= 0) breakPoint = 1; // Ensure we make progress
              
              chunks.push(tempSentence.substring(0, breakPoint).trim());
              tempSentence = tempSentence.substring(breakPoint).trim();
            }
            // Add remaining part of the sentence
            if (tempSentence) currentChunk = tempSentence;
          } else {
            // Current sentence fits in a chunk by itself, start new chunk
            if (currentChunk) {
              chunks.push(currentChunk);
            }
            currentChunk = sentence;
          }
        } else {
          // Add sentence to current chunk
          currentChunk = potentialChunk;
        }
      }
      
      // Add the last chunk if not empty
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      
      // Filter out any empty chunks
      const validChunks = chunks.filter(chunk => chunk && chunk.trim().length > 0);
      
      if (validChunks.length === 0) {
        throw new Error('No valid text chunks generated for TTS processing');
      }
      
      console.log(`Split text into ${validChunks.length} valid chunks to meet TTS byte limit`);
      return validChunks;
    }

    // Process each script chunk, splitting if necessary
    const processedScriptChunks = [];
    scriptChunks.forEach((script, index) => {
      if (!script || typeof script !== 'string') return;
      const splitChunks = optimizeAndSplitText(script);
      processedScriptChunks.push(...splitChunks);
    });
    
    console.log(`[generate-tts-background] Processing ${processedScriptChunks.length} script chunks for job ${jobId} (after optimization and splitting)`);

    // Check if job has been cancelled before starting TTS processing
    if (await checkJobCancelled(supabase, jobId)) {
      console.log(`[generate-tts-background] Job ${jobId} was cancelled, stopping TTS generation`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Job cancelled by user', cancelled: true })
      };
    }

    // Initialize Text-to-Speech client with timeout and retry configuration
    const client = new TextToSpeechClient({
      credentials: JSON.parse(GOOGLE_CLOUD_CREDENTIALS),
      // Configure timeouts and retries to handle 502 errors
      clientConfig: {
        // Reduce timeout to fail faster and retry
        'grpc.keepalive_time_ms': 30000,
        'grpc.keepalive_timeout_ms': 5000,
        'grpc.keepalive_permit_without_calls': true,
        'grpc.http2.max_pings_without_data': 0,
        'grpc.http2.min_time_between_pings_ms': 10000,
        'grpc.http2.min_ping_interval_without_data_ms': 300000
      },
      // Increase API timeout to 180 seconds for long texts
      timeout: 180000
    });

    const audioBuffers = [];
    let totalDurationInSeconds = 0;

    console.log(`Starting TTS generation with a max duration of ${MAX_DURATION_SECONDS} seconds.`);

    // Process each chunk
    for (let i = 0; i < processedScriptChunks.length; i++) {
      // Check for cancellation before processing each chunk
      if (await checkJobCancelled(supabase, jobId)) {
        console.log(`[generate-tts-background] Job ${jobId} was cancelled during TTS processing`);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'Job cancelled by user', cancelled: true })
        };
      }

      let chunk = processedScriptChunks[i];
      console.log(`[generate-tts-background] Processing chunk ${i + 1}/${processedScriptChunks.length} for job ${jobId}`);

      // Check for immediate cancellation before expensive TTS API call
      if (await checkJobCancelled(supabase, jobId)) {
        console.log(`[generate-tts-background] Job ${jobId} was cancelled before TTS call, stopping immediately`);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'Job cancelled by user', cancelled: true })
        };
      }

      // Log chunk size in bytes for visibility
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      console.log(`[generate-tts-background] Chunk ${i + 1}/${processedScriptChunks.length} size: ${chunkBytes} bytes`);

      const request = {
        input: { text: chunk },
        voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Iapetus' },
        audioConfig: { audioEncoding: 'MP3', pitch: 0, speakingRate: 1.1 },
      };

      // Retry logic for handling 502/timeout errors
      let response;
      let retryCount = 0;
      const maxRetries = 3;
      const baseDelay = 2000; // 2 seconds
      let splitAndRequeue = false;

      while (retryCount <= maxRetries) {
        try {
          console.log(`[TTS] Attempting synthesis for chunk ${i + 1}/${processedScriptChunks.length} (attempt ${retryCount + 1}/${maxRetries + 1})`);
          [response] = await client.synthesizeSpeech(request, { timeout: 180000 });
          break; // Success, exit retry loop
        } catch (error) {
          retryCount++;
          
          // Check if it's a retryable error (502, timeout, unavailable)
          const isRetryable = error.code === 14 || // UNAVAILABLE
                             error.code === 4 ||  // DEADLINE_EXCEEDED
                             error.message?.includes('502') ||
                             error.message?.includes('Bad Gateway') ||
                             error.message?.includes('timeout');
          
          if (!isRetryable || retryCount > maxRetries) {
            // Before giving up entirely, try to split this chunk into smaller subchunks and requeue them
            if (retryCount > maxRetries) {
              try {
                const targetBytes = Math.max(2000, Math.floor(chunkBytes / 2));
                const subChunks = optimizeAndSplitText(chunk, targetBytes);
                if (subChunks && subChunks.length > 1) {
                  console.warn(`[TTS] Max retries exceeded for chunk ${i + 1}. Splitting into ${subChunks.length} smaller subchunks (targetBytes=${targetBytes}).`);
                  // Replace current chunk with subchunks and reprocess from the first subchunk
                  processedScriptChunks.splice(i, 1, ...subChunks);
                  // Reset state to retry with the first subchunk on next loop iteration
                  splitAndRequeue = true;
                  break;
                }
              } catch (splitErr) {
                console.error('[TTS] Failed to split chunk after retries:', splitErr);
              }
            }
            console.error(`[TTS] Non-retryable error or max retries exceeded for chunk ${i + 1}:`, error);
            throw error;
          }
          
          // Exponential backoff with jitter
          const delay = baseDelay * Math.pow(2, retryCount - 1) + Math.random() * 1000;
          console.warn(`[TTS] Retryable error for chunk ${i + 1} (attempt ${retryCount}/${maxRetries + 1}). Retrying in ${Math.round(delay)}ms...`, error.message);
          
          // Check for cancellation during retry delay
          if (await checkJobCancelled(supabase, jobId)) {
            console.log(`[generate-tts-background] Job ${jobId} was cancelled during retry delay`);
            return {
              statusCode: 200,
              body: JSON.stringify({ message: 'Job cancelled by user', cancelled: true })
            };
          }
          
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      // If the chunk was split into subchunks and requeued, process the new subchunks next
      if (!response && splitAndRequeue) {
        // Step back index so next loop processes the first newly inserted subchunk
        i--;
        // Small delay to avoid hot-looping
        await new Promise(resolve => setTimeout(resolve, 150));
        continue;
      }
      const audioBuffer = response.audioContent;
      const chunkDurationMs = getMp3Duration(audioBuffer);
      const chunkDurationSec = Math.round(chunkDurationMs / 1000);

      console.log(`TTS for chunk ${i + 1}/${processedScriptChunks.length}: duration=${chunkDurationSec}s, size=${audioBuffer.length} bytes. Total duration so far: ${totalDurationInSeconds + chunkDurationSec}s`);

      totalDurationInSeconds += chunkDurationSec;
      audioBuffers.push(audioBuffer);

      // Check duration limit
      if (totalDurationInSeconds > MAX_DURATION_SECONDS) {
        console.warn(`[generate-tts-background] Total duration ${totalDurationInSeconds}s exceeds limit ${MAX_DURATION_SECONDS}s`);
        break;
      }

      // Small pacing delay to avoid hammering the TTS API
      await new Promise(resolve => setTimeout(resolve, 600));

      // Update progress
      await updateJobStatus(supabase, jobId, null, { 
        progress: `tts_${i + 1}/${processedScriptChunks.length}` 
      });
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
    await updateJobStatus(supabase, jobId, 'completed', { podcastUrl, duration: totalDurationInSeconds, filename });

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
