const pdf = require('pdf-parse');
const Busboy = require('busboy');
const { getSupabaseAdmin, PDF_BUCKET_NAME } = require('./supabaseClient');

exports.handler = async (event) => {
  console.log('[upload-pdf] Handler started');
  console.time('total-execution');

  // Check if the request method is POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  // Verify authentication using manual JWT token decoding
  console.log('[upload-pdf] Starting auth verification');
  console.time('auth-verification');
  let userId;
  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized: Authentication token required' }),
        headers: { 'Content-Type': 'application/json' },
      };
    }
    
    // Get token from Authorization header
    const token = authHeader.split(' ')[1];
    console.log('[upload-pdf] Access Token from header (preview):', token ? `${token.slice(0, 8)}...${token.slice(-5)}` : 'null...null');
    
    // Basic token validation
    if (!token || typeof token !== 'string') {
      throw new Error('Token missing or not a string');
    }

    // Check token format (three parts separated by dots)
    const tokenParts = token.split('.');
    if (tokenParts.length !== 3) {
      throw new Error('Token does not have three parts as required for JWT format');
    }

    // Decode and validate the payload
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
      console.log(`[upload-pdf] Successfully decoded token for user: ${userId}`);
    } catch (decodeError) {
      console.error('[upload-pdf] Token decode error:', decodeError);
      throw new Error('Failed to decode token: ' + decodeError.message);
    }
    
    console.timeEnd('auth-verification');
    console.log('[upload-pdf] Auth successful, userId:', userId);
  } catch (err) {
    console.error('[upload-pdf] Error during authentication processing:', err.message);
    return {
      statusCode: 401,
      body: JSON.stringify({ error: `Unauthorized: ${err.message}` }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  // Process the file upload using Busboy
  console.log('[upload-pdf] Processing request body');
  console.time('busboy-processing');
  
  try {
    // Create a Promise to properly handle Busboy's asynchronous events
    const fileUploadPromise = new Promise((resolve, reject) => {
      try {
        // Setup Busboy for multipart form parsing
        const busboy = Busboy({ headers: event.headers });
        let fileBuffer = null;
        let originalFilename = '';
        let mimetype = 'application/octet-stream';
        let fileProcessed = false;
        
        // Handler for file data
        busboy.on('file', (fieldname, file, info) => {
          console.log('[upload-pdf] File event triggered');
          fileProcessed = true;
          originalFilename = info.filename;
          mimetype = info.mimeType;
          console.log(`File [${fieldname}]: filename: ${originalFilename}, encoding: ${info.encoding}, mimetype: ${mimetype}`);
          
          // Collect file chunks
          const chunks = [];
          file.on('data', (chunk) => {
            chunks.push(chunk);
          });

          // When file is fully received
          file.on('end', () => {
            console.log('[upload-pdf] File receipt completed');
            fileBuffer = Buffer.concat(chunks);
            console.log(`File [${fieldname}] Finished. Buffer size: ${fileBuffer.length}`);
          });
        });

        // Handle completion of parsing
        busboy.on('finish', () => {
          console.timeEnd('busboy-processing');
          console.log('[upload-pdf] Busboy parsing finished');
          
          // Check if we received a file
          if (!fileProcessed) {
            return reject(new Error('No file was uploaded'));
          }
          
          // Check if file buffer is valid
          if (!fileBuffer || fileBuffer.length === 0) {
            return reject(new Error('File buffer is empty'));
          }
          
          // File is valid, resolve with file data
          resolve({
            buffer: fileBuffer,
            originalFilename,
            mimetype
          });
        });

        // Handle Busboy errors
        busboy.on('error', (error) => {
          console.error('[upload-pdf] Busboy error:', error);
          reject(error);
        });

        // Check if body exists and feed it to Busboy
        if (!event.body) {
          return reject(new Error('No request body found'));
        }
        
        // Process the request body based on encoding
        console.log('[upload-pdf] Request body format:', event.isBase64Encoded ? 'base64' : 'utf8');
        const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
        console.log('[upload-pdf] Request body size:', bodyBuffer.length, 'bytes');
        
        // Feed data to Busboy and signal end of input
        busboy.write(bodyBuffer);
        busboy.end();
        
      } catch (error) {
        console.error('[upload-pdf] Error in Busboy setup:', error);
        reject(error);
      }
    });

    // Wait for file processing to complete
    const fileData = await fileUploadPromise;
    
    // Process the PDF to extract text
    console.log('[upload-pdf] Starting PDF parsing');
    console.time('pdfParsing');
    let pdfExtractData;
    try {
      pdfExtractData = await pdf(fileData.buffer);
      console.timeEnd('pdfParsing');
      console.log('[upload-pdf] PDF parsing completed');
    } catch (pdfError) {
      console.error('[upload-pdf] PDF parsing error:', pdfError);
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: 'Failed to parse PDF file.', 
          details: pdfError.message 
        }),
        headers: { 'Content-Type': 'application/json' },
      };
    }
    
    // Extract text from the PDF
    const extractedText = pdfExtractData.text || 'No text found in PDF.';

    // Upload the PDF to Supabase Storage
    console.log('[upload-pdf] Starting Supabase Storage upload');
    console.time('supabaseUpload');
    
    // Create a unique path for the file in storage
    // Adding 'public/' prefix which is often required for Supabase RLS policies
    const filePath = `public/${userId}/${Date.now()}-${fileData.originalFilename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    console.log(`Attempting to upload to Supabase Storage: bucket='${PDF_BUCKET_NAME}', path='${filePath}'`);
    
    const supabaseAdmin = getSupabaseAdmin();
    
    // We DO NOT store the PDF file in Supabase Storage permanently
    // The PDF is only used for text extraction and then discarded
    console.log('[upload-pdf] Skipping permanent PDF storage - using extracted text only');
    
    // Log end of time measurement for consistency in logs
    console.timeEnd('supabaseUpload');
    
    // Store the response data
    const responseData = {
      extractedText: extractedText,
      originalFilename: fileData.originalFilename
    };
    
    // Create a new job in the podcast_jobs table
    console.log('[upload-pdf] Creating podcast job in database');
    
    try {
      // Insert the job into the podcast_jobs table
      const { data: jobData, error: dbError } = await supabaseAdmin
        .from('podcast_jobs')
        .insert([
          {
            user_id: userId,
            status: 'pending_analysis',
            filename: fileData.originalFilename,
            generated_script: extractedText,  // Store extracted text directly
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ])
        .select();
        
      if (dbError) {
        console.error('[upload-pdf] Error creating podcast job:', dbError);
      } else {
        // Get the database-generated job_id from the returned data
        const jobId = jobData?.[0]?.job_id;
        console.log(`[upload-pdf] Created podcast job with ID: ${jobId}`);
        
        // Trigger the queue-podcast-job function (which will handle the rest of the pipeline)
        console.log('[upload-pdf] Triggering queue-podcast-job function');
        try {
          // Extract simplified concepts from the text directly (basic implementation)
          // This is a simple placeholder - queue-podcast-job will pass this to analyze-pdf-text for proper analysis
          const simpleConcepts = [
            { concept: "Document Analysis", explanation: "Initial extraction from uploaded PDF" }
          ];

          // Call the queue-podcast-job function which will properly handle the multi-step pipeline
          // IMPORTANT: Pass the existing jobId to prevent duplicate job creation
          const queueResponse = await fetch(`${process.env.URL || 'http://localhost:8888'}/.netlify/functions/queue-podcast-job`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': event.headers.authorization || event.headers.Authorization
            },
            body: JSON.stringify({
              jobId: jobId, // Pass the existing job ID to prevent duplicates
              concepts: simpleConcepts,
              pdfName: fileData.originalFilename,
              extractedText: extractedText // Pass extracted text directly
            })
          });
          
          if (!queueResponse.ok) {
            console.error(`[upload-pdf] Error triggering queue-podcast-job: ${queueResponse.status} ${queueResponse.statusText}`);
          } else {
            console.log('[upload-pdf] Successfully triggered queue-podcast-job');
          }
        } catch (queueError) {
          console.error('[upload-pdf] Exception triggering queue-podcast-job:', queueError);
        }
      }
    } catch (jobError) {
      console.error('[upload-pdf] Exception creating podcast job:', jobError);
    }

    // Return success response with extracted text and storage details
    console.timeEnd('total-execution');
    console.log('[upload-pdf] Function completed successfully');
    return {
      statusCode: 200,
      body: JSON.stringify(responseData),
      headers: { 'Content-Type': 'application/json' },
    };
    
  } catch (error) {
    // Handle any errors in the process
    console.error('[upload-pdf] Error:', error);
    console.timeEnd('total-execution');
    console.log('[upload-pdf] Function failed with error');
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to process PDF file.', 
        details: error.message 
      }),
      headers: { 'Content-Type': 'application/json' },
    };
  }
};
