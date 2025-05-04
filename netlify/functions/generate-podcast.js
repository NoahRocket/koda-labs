const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// Retrieve environment variables
const { ELEVENLABS_API_KEY, SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY } = process.env;
const SUPABASE_BUCKET = 'podcasts'; // Or your desired bucket name

// ElevenLabs API details
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech/';
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Example voice ID (Adam) - replace if needed

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Check for required environment variables first
  if (!ELEVENLABS_API_KEY || !SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
    console.error('Missing required server environment variables');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // --- Authentication & User-Scoped Supabase Client ---
  const authHeader = event.headers.authorization;
  let supabase;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const jwt = authHeader.substring(7, authHeader.length);
    // Initialize Supabase client scoped to the user making the request
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: {
        headers: { Authorization: `Bearer ${jwt}` }
      }
    });
  } else {
    console.error('Authorization header missing or invalid.');
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing or invalid token.' }) };
  }
  // --- End Authentication ---

  try {
    const { concepts } = JSON.parse(event.body);

    if (!concepts || !Array.isArray(concepts) || concepts.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid concepts data.' }) };
    }

    console.log(`Received concepts: ${concepts.length}`);

    // --- 1. Generate Script using OpenAI --- 
    const intro = "Welcome to your Koda Compass podcast. Today, we'll explore some key concepts.\n\n";
    const outro = "\n\nThat concludes our summary. Thanks for listening!";

    // Prepare concepts for the prompt
    const conceptsString = concepts.map(({ concept, explanation }) => `- ${concept}: ${explanation}`).join('\n');

    const prompt = `You are a podcast script writer. Given the following key concepts and their explanations, generate a conversational and engaging podcast script body that explains these concepts clearly. Aim for a script that would take approximately 3-4 minutes to read aloud. Do not include an intro or outro, just the main content discussing the concepts.

Here are the concepts:
${conceptsString}

Generate only the script body.`;

    console.log('Calling OpenAI API to generate script...');
    let scriptBody = '';
    try {
        const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'o3-mini-2025-01-31', // Using specified model
                messages: [{ role: 'user', content: prompt }],
                max_completion_tokens: 800 // Reduced token limit for shorter script
                // No temperature parameter per memory
            })
        });

        if (!openaiResponse.ok) {
            const errorBody = await openaiResponse.text();
            console.error('OpenAI API Error:', openaiResponse.status, errorBody);
            throw new Error(`OpenAI API request failed: ${openaiResponse.statusText}`);
        }

        const openaiData = await openaiResponse.json();
        scriptBody = openaiData.choices[0]?.message?.content?.trim() || '';

        if (!scriptBody) {
             console.error('OpenAI API returned an empty script body.');
             throw new Error('Failed to generate script content from OpenAI.');
        }

    } catch (apiError) {
        console.error('Error calling OpenAI API:', apiError);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate podcast script.' }) };
    }
    
    // Assemble the full script
    const scriptText = intro + scriptBody + outro;

    console.log('Generated script text length:', scriptText.length);

    // --- 2. Call ElevenLabs TTS ---
    console.log('Calling ElevenLabs TTS API...');
    const elevenLabsResponse = await fetch(`${ELEVENLABS_API_URL}${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: scriptText,
        model_id: 'eleven_monolingual_v1', // Or another model
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    });

    if (!elevenLabsResponse.ok) {
      const errorBody = await elevenLabsResponse.text();
      console.error('ElevenLabs API Error:', elevenLabsResponse.status, errorBody);
      throw new Error(`ElevenLabs API request failed: ${elevenLabsResponse.statusText}`);
    }

    // Get audio data as a buffer
    const audioBuffer = await elevenLabsResponse.buffer();
    console.log('Received audio buffer from ElevenLabs. Size:', audioBuffer.length);

    // --- 3. Upload to Supabase Storage ---
    const filename = `podcast_${Date.now()}.mp3`;
    console.log(`Uploading to Supabase bucket '${SUPABASE_BUCKET}' as '${filename}'...`);

    // Upload the audio buffer to Supabase Storage using the user-scoped client
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(filename, audioBuffer, {
        contentType: 'audio/mpeg',
        upsert: false, // Don't overwrite existing files
      });

    if (uploadError) {
      console.error('Supabase Upload Error:', uploadError);
      throw new Error('Failed to upload podcast audio to storage.');
    }

    console.log('File uploaded to Supabase successfully:', uploadData.path);

    // --- 4. Get Public URL ---
    const { data: urlData } = supabase.storage
      .from(SUPABASE_BUCKET)
      .getPublicUrl(filename);

    if (!urlData || !urlData.publicUrl) {
      console.error('Supabase Get Public URL Error: URL not found');
      throw new Error('Failed to get public URL for the uploaded podcast.');
    }

    console.log('Public URL:', urlData.publicUrl);

    // --- 5. Return URL to Frontend ---
    return {
      statusCode: 200,
      body: JSON.stringify({ podcastUrl: urlData.publicUrl, filename: filename }),
      headers: { 'Content-Type': 'application/json' },
    };

  } catch (error) {
    console.error('Podcast generation error:', error);
    // Provide more specific error if it's a known Supabase error
    let errorMessage = 'Failed to generate podcast.';
    if (error.message && error.message.includes('storage')) { // Heuristic for storage errors
        errorMessage = 'Failed to upload podcast audio to storage.';
    }
    return { statusCode: 500, body: JSON.stringify({ error: errorMessage }) };
  }
};