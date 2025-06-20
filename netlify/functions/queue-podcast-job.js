const fetch = require('node-fetch');
const { getSupabaseAdmin } = require('./supabaseClient');

// Retrieve environment variables
const { SUPABASE_URL, SUPABASE_KEY } = process.env;

// Helper function to generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  
  // Check for required environment variables
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing required server environment variables');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // --- Authentication using Manual JWT Token Decoding ---
  const authHeader = event.headers.authorization || event.headers.Authorization;
  let userId;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing or invalid authentication header.' }) };
  }
  
  try {
    // Extract token from header
    const token = authHeader.substring(7);
    console.log('[queue-podcast-job] Access Token from header (preview):', token ? `${token.slice(0, 8)}...${token.slice(-5)}` : 'null...null');
    
    // Basic token validation
    if (!token || typeof token !== 'string') {
      throw new Error('Token missing or not a string');
    }

    // Validate token format (three parts separated by dots)
    const tokenParts = token.split('.');
    if (tokenParts.length !== 3) {
      throw new Error('Token does not have three parts as required for JWT format');
    }

    // Decode the payload
    try {
      // Base64 decode and parse the payload
      const base64Payload = tokenParts[1];
      const decodedPayload = Buffer.from(base64Payload, 'base64').toString('utf8');
      const payload = JSON.parse(decodedPayload);
      
      // Extract user ID from sub claim
      if (!payload.sub) {
        throw new Error('Invalid token payload: missing user ID');
      }
      
      // Use sub claim as the user ID
      userId = payload.sub;
      console.log(`[queue-podcast-job] Successfully decoded token for user: ${userId}`);
    } catch (decodeError) {
      console.error('[queue-podcast-job] Token decode error:', decodeError);
      throw new Error('Failed to decode token: ' + decodeError.message);
    }
  } catch (error) {
    console.error('[queue-podcast-job] Exception during token validation:', error.message);
    return { statusCode: 401, body: JSON.stringify({ error: `Unauthorized: ${error.message}` }) };
  }
  // --- End Authentication ---

  try {
    const { concepts, pdfName = 'Uploaded PDF', extractedText } = JSON.parse(event.body);

    if (!concepts || !Array.isArray(concepts) || concepts.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid concepts data.' }) };
    }
    // We don't require storagePath anymore, as we're not storing PDFs permanently
    if (!extractedText) {
      console.warn('[queue-podcast-job] Warning: Missing extractedText. Using empty text.');  
    }

    // Use the Admin client (service key) to insert the job
    const supabaseAdmin = getSupabaseAdmin();
    const { data: job, error } = await supabaseAdmin
      .from('podcast_jobs')
      .insert({
        user_id: userId,
        status: 'pending_analysis', // Initial status
        concepts: concepts, // These are still the simplified concepts for now
        filename: pdfName,
        generated_script: extractedText || '' // Store the extracted text instead of a PDF path
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating job:', error);
      throw new Error('Failed to create podcast job.');
    }

    // Log the entire job object to see its structure
    console.log('Created job:', job);
    
    // Extract the job ID - try job_id first, then fall back to id
    const jobId = job.job_id || job.id;
    
    if (!jobId) {
      console.error('No job ID returned from insert operation');
      throw new Error('Failed to create podcast job: No job ID returned');
    }
    
    console.log(`Created podcast job with ID: ${jobId}`);

    // Trigger the background worker with the job ID
    try {
      const domain = event.headers.host;
      const protocol = domain.includes('localhost') ? 'http' : 'https';
      const workerUrl = `${protocol}://${domain}/.netlify/functions/analyze-pdf-text`; // Changed to trigger analyze-pdf-text
      
      console.log(`Triggering text analysis worker at: ${workerUrl}`);
      
      // Launch worker asynchronously in a fire-and-forget approach
      const workerResponse = await fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}` // Using server key for background processing
        },
        body: JSON.stringify({ jobId: jobId }),
      });
      
      console.log(`Worker triggered with status: ${workerResponse.status}`);
      
      // If worker fails to start, we should still return success to the client, but log the error
      if (!workerResponse.ok) {
        const errorText = await workerResponse.text();
        console.error(`Warning: Worker failed to start properly: ${errorText}`);
      }
    } catch (workerError) {
      console.error('Failed to trigger worker function:', workerError);
      // We don't return an error to the client here as the job was created successfully
    }

    // Return the job ID to the client
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: 'Podcast generation has been queued.',
        jobId: jobId
      })
    };
  } catch (error) {
    console.error('Error queueing podcast job:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to queue podcast generation job.' })
    };
  }
};
