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
    let { concepts, pdfName = 'Uploaded PDF', extractedText, jobId: existingJobId } = JSON.parse(event.body);

    // Backwards compatibility fix:
    // If extractedText is missing, but the 'concepts' field contains a single long string,
    // treat that string as the extractedText and reset concepts to an empty array.
    if (!extractedText && Array.isArray(concepts) && concepts.length > 0 && typeof concepts[0] === 'string' && concepts[0].length > 200) {
        console.warn('[queue-podcast-job] `extractedText` was missing. Using the content of the `concepts` field as a fallback.');
        extractedText = concepts[0];
        concepts = []; // Reset concepts, as they will be generated in the next step.
    }

    // Now, we must have extracted text to proceed.
    if (!extractedText) {
        const errorMsg = '[queue-podcast-job] Critical error: No extracted text was provided or could be recovered. Cannot queue job.';
        console.error(errorMsg);
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required extractedText.' }) };
    }

    // Use the Admin client (service key)
    const supabaseAdmin = getSupabaseAdmin();
    let job;
    let jobError;
    let currentJobId;
    
    // Check if we're updating an existing job or creating a new one
    if (existingJobId) {
      console.log(`[queue-podcast-job] Using existing job ID: ${existingJobId}`);
      
      // Update the existing job instead of creating a new one
      const { data: updatedJob, error: updateError } = await supabaseAdmin
        .from('podcast_jobs')
        .update({
          concepts: concepts && concepts.length > 0 ? concepts : null,
          generated_script: extractedText,
          filename: pdfName,
          updated_at: new Date().toISOString()
        })
        .eq('job_id', existingJobId)
        .select()
        .single();
      
      job = updatedJob;
      jobError = updateError;
      currentJobId = existingJobId;
    } else {
      // Create a new job (original behavior)
      const { data: newJob, error: insertError } = await supabaseAdmin
        .from('podcast_jobs')
        .insert({
          user_id: userId,
          status: 'pending_analysis',
          concepts: concepts && concepts.length > 0 ? concepts : null,
          filename: pdfName,
          generated_script: extractedText
        })
        .select()
        .single();
      
      job = newJob;
      jobError = insertError;
      if (job) {
        currentJobId = job.job_id || job.id;
      }
    }

    if (jobError) {
      console.error('Error processing job:', jobError);
      throw new Error('Failed to process podcast job.');
    }

    // Log the entire job object to see its structure
    console.log('Job being processed:', job);
    
    if (!currentJobId) {
      console.error('No job ID available');
      throw new Error('Failed to process podcast job: No job ID available');
    }
    
    // Log operation type - new or updated job
    if (existingJobId) {
      console.log(`Updated existing podcast job with ID: ${currentJobId}`);
    } else {
      console.log(`Created new podcast job with ID: ${currentJobId}`);
    }

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
        body: JSON.stringify({ jobId: currentJobId }),
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
        jobId: currentJobId
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
