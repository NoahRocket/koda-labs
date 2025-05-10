// A simplified function for uploading to Supabase Storage without RLS issues
const fetch = require('node-fetch');

// Retrieve environment variables
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_KEY } = process.env;
const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Check for environment variables
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing required environment variables');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { jobId, userId, filename } = body;
    let audioData;
    
    // We need to handle both the data directly or extract from the request
    if (body.audioData) {
      audioData = Buffer.from(body.audioData, 'base64');
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'No audio data provided.' }) };
    }
    
    if (!filename || !jobId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required parameters.' }) };
    }

    console.log(`Attempting direct upload for job: ${jobId}, filename: ${filename}`);

    // Perform a direct upload to Supabase storage using the REST API
    // Corrected Path: Removed potentially problematic '/public/' from the upload path.
    // Bucket name is 'podcasts', assuming direct upload to the root of the bucket.
    // If files should be user-specific, the path might need userId, e.g., `podcasts/${userId}/${filename}`
    const uploadEndpoint = `${SUPABASE_URL}/storage/v1/object/podcasts/${filename}`; 
    
    // Make the REST call with admin token
    const uploadResponse = await fetch(uploadEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY,
        'Content-Type': 'audio/mpeg',
        // 'Cache-Control': 'public, max-age=3600' // optional
      },
      body: audioData
    });

    // Handle upload errors
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error(`Upload failed: ${uploadResponse.status}`, errorText);
      return { 
        statusCode: 500, 
        body: JSON.stringify({ 
          error: 'Upload failed', 
          details: errorText,
          statusCode: uploadResponse.status
        }) 
      };
    }

    // Get the upload result
    const uploadResult = await uploadResponse.json();
    console.log(`Upload successful. Public URL: ${SUPABASE_URL}/storage/v1/object/public/podcasts/${filename}`);

    // Generate the public URL - this requires the object to be accessible publicly
    // Note: The path here MUST match the actual storage path used above.
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/podcasts/${filename}`;
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'File uploaded successfully',
        uploadResult,
        publicUrl
      })
    };
  } catch (error) {
    console.error('Error in direct upload function:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error processing upload.' })
    };
  }
};
