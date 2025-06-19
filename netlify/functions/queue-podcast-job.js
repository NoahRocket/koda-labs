const fetch = require('node-fetch');
const { getSupabaseAdmin, getSupabaseAuthClient } = require('./supabaseClient');

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

  // --- Authentication & User-Scoped Supabase Client ---
  const authHeader = event.headers.authorization;
  let userId;
  let supabase;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const jwt = authHeader.substring(7, authHeader.length);
    // Use the Auth client (anon key) to verify the user's JWT
    const supabaseAuth = getSupabaseAuthClient();
    
    // Get the user ID from the JWT token
    try {
      const { data: { user }, error } = await supabaseAuth.auth.getUser(jwt);
      if (error) throw error;
      userId = user.id;
    } catch (error) {
      console.error('Error verifying token:', error);
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Invalid token.' }) };
    }
  } else {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Missing or invalid token.' }) };
  }
  // --- End Authentication ---

  try {
    const { concepts, pdfName = 'Uploaded PDF', storagePath } = JSON.parse(event.body);

    if (!concepts || !Array.isArray(concepts) || concepts.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid concepts data.' }) };
    }
    if (!storagePath) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing storagePath for the PDF.' }) };
    }

    // Use the Admin client (service key) to insert the job
    const supabaseAdmin = getSupabaseAdmin();
    const { data: job, error } = await supabaseAdmin
      .from('podcast_jobs')
      .insert({
        user_id: userId,
        status: 'pending_analysis', // Updated initial status
        concepts: concepts, // These are still the simplified concepts for now
        filename: pdfName,
        source_pdf_url: storagePath // Store the path to the PDF in Supabase Storage
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
