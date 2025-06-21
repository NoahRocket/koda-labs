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
    
    if (!filename || !jobId || !userId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required parameters: jobId, userId, and filename are required.' }) };
    }

    console.log(`Attempting direct upload for job: ${jobId}, filename: ${filename}`);

    // Perform a direct upload to Supabase storage using the REST API
    // Add 'public/' prefix to match RLS policies similar to PDF uploads
    // Also include the userId in the path to match our PDF storage pattern
    // Format: podcasts/public/userId/filename
    const uploadEndpoint = `${SUPABASE_URL}/storage/v1/object/podcasts/public/${userId}/${filename}`; 
    
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
    console.log(`Upload successful. Public URL: ${SUPABASE_URL}/storage/v1/object/public/podcasts/public/${userId}/${filename}`);

    // Generate the public URL - this requires the object to be accessible publicly
    // Note: The path here MUST match the actual storage path used above.
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/podcasts/public/${userId}/${filename}`;
    
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
