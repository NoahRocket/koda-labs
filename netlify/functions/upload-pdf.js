const pdf = require('pdf-parse');
const Busboy = require('busboy');
const { getSupabaseAdmin } = require('./supabaseClient');
const { trackUsageAndCheckLimits } = require('./usage-tracking');
const { hasActivePremiumSubscription } = require('./stripeClient');

// Free tier limits
const FREE_TIER_MONTHLY_PODCAST_LIMIT = 1;

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

  // Check if user has premium subscription or has not exceeded podcast conversion limit
  console.log('[upload-pdf] Checking usage limits');
  try {
    const hasPremium = await hasActivePremiumSubscription(userId);
    
    if (!hasPremium) {
      // Check podcast conversion usage for this month
      const usageResult = await trackUsageAndCheckLimits(userId, 'podcast_conversions', FREE_TIER_MONTHLY_PODCAST_LIMIT);
      
      if (usageResult.limitExceeded) {
        return {
          statusCode: 403,
          body: JSON.stringify({
            error: 'Free tier limit reached',
            message: `You have reached the maximum of ${FREE_TIER_MONTHLY_PODCAST_LIMIT} PDF to Podcast conversion allowed per month on the free plan. Please upgrade to Premium for unlimited conversions.`,
            limit: FREE_TIER_MONTHLY_PODCAST_LIMIT,
            current: usageResult.currentUsage
          }),
          headers: { 'Content-Type': 'application/json' },
        };
      }
    }
  } catch (limitError) {
    console.error('[upload-pdf] Error checking usage limits:', limitError);
    // Continue processing even if limit check fails to avoid blocking users
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
    const extractedText = pdfExtractData.text.replace(/\u0000/g, '') || 'No text found in PDF.';
    const textLength = extractedText.length;
    const needsChunking = textLength > 20000;  // Threshold for chunking; adjust as needed for optimal learning tool performance
    console.log(`[upload-pdf] Extracted text length: ${textLength} characters. Needs chunking: ${needsChunking}`);

    // We don't store the PDF file in Supabase Storage
    // The PDF is only used for text extraction and then discarded
    console.log('[upload-pdf] Using extracted text only - PDF not stored');
    
    // Store the response data
    const responseData = {
      extractedText: extractedText,
      originalFilename: fileData.originalFilename
    };
    
    console.log('[upload-pdf] Checking for existing jobs with the same filename');
    
    let jobId;
    try {
      // First check if there's already a job for this filename and user
      const { data: existingJobs, error: searchError } = await getSupabaseAdmin()
        .from('podcast_jobs')
        .select('job_id, status')
        .eq('user_id', userId)
        .eq('filename', fileData.originalFilename);
        
      if (searchError) {
        console.error('[upload-pdf] Error searching for existing jobs:', searchError);
        // Continue with creating a new job as fallback
      } else if (existingJobs && existingJobs.length > 0) {
        // Found an existing job with the same filename
        const existingJob = existingJobs[0];
        jobId = existingJob.job_id;
        const status = existingJob.status;
        
        console.log(`[upload-pdf] Found existing job ${jobId} with status ${status} for filename ${fileData.originalFilename}`);
        
        // If job is not in a final state (completed or failed), we don't need to do anything more
        if (status !== 'completed' && status !== 'failed') {
          console.log(`[upload-pdf] Using existing job ${jobId} which is still processing`);
          responseData.jobId = jobId;
          // Return early with the existing job ID
          console.timeEnd('total-execution');
          console.log('[upload-pdf] Function completed with existing job');
          return {
            statusCode: 200,
            body: JSON.stringify(responseData),
            headers: { 'Content-Type': 'application/json' },
          };
        }
        
        // If the job is completed or failed, we'll update it instead of creating a new one
        console.log(`[upload-pdf] Updating existing job ${jobId} from ${status} to pending_analysis`);
        const { error: updateError } = await getSupabaseAdmin()
          .from('podcast_jobs')
          .update({
            status: 'pending_analysis',
            extracted_text: extractedText,  // Updated field name for clarity
            needs_chunking: needsChunking,
            updated_at: new Date().toISOString(),
            error_message: null // Clear any previous error messages
          })
          .eq('job_id', jobId);
          
        if (updateError) {
          console.error('[upload-pdf] Error updating existing job:', updateError);
          // Continue with creating a new job as fallback
          jobId = null;
        }
      }
      
      // If no existing job was found or if updating failed, create a new job
      if (!jobId) {
        console.log('[upload-pdf] Creating new podcast job in database');
        
        const { data: jobData, error: dbError } = await getSupabaseAdmin()
          .from('podcast_jobs')
          .insert([
            {
              user_id: userId,
              status: 'pending',
              filename: fileData.originalFilename,
              extracted_text: extractedText,  // Updated field name for clarity
              needs_chunking: needsChunking,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          ])
          .select();
          
        if (dbError) {
          console.error('[upload-pdf] Error creating podcast job:', dbError);
        } else {
          // Get the database-generated job_id from the returned data
          jobId = jobData?.[0]?.job_id;
          console.log(`[upload-pdf] Created podcast job with ID: ${jobId}`);
        }
      }
      
      // Add the jobId to the response data
      responseData.jobId = jobId;
      
      if (jobId) {
        // Trigger the analyze-pdf-text function to start the analysis pipeline
        console.log('[upload-pdf] Triggering analyze-pdf-text function for job:', jobId);
        try {
          // Use a more robust URL construction
          const host = event.headers.host;
          const proto = host.includes('localhost') ? 'http' : 'https';
          const analyzeUrl = `${proto}://${host}/.netlify/functions/analyze-pdf-text`;
          
          console.log(`[upload-pdf] Calling analyze-pdf-text at: ${analyzeUrl}`);
          
          const analyzeResponse = await fetch(analyzeUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': event.headers.authorization || event.headers.Authorization || `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
            },
            body: JSON.stringify({
              jobId: jobId,
              extractedText: extractedText
            })
          });

          const responseStatus = analyzeResponse.status;
          console.log(`[upload-pdf] analyze-pdf-text response status: ${responseStatus}`);
          
          if (!analyzeResponse.ok) {
            const errorText = await analyzeResponse.text();
            console.error(`[upload-pdf] Error triggering analyze-pdf-text: ${responseStatus} ${analyzeResponse.statusText}`);
            console.error(`[upload-pdf] Error response body: ${errorText}`);
            
            // Update the job status to indicate there was a problem
            try {
              const { error } = await getSupabaseAdmin()
                .from('podcast_jobs')
                .update({ 
                  status: 'failed',
                  error_message: `Failed to start analysis: ${responseStatus} ${analyzeResponse.statusText}`
                })
                .eq('job_id', jobId);
                
              if (error) {
                console.error(`[upload-pdf] Failed to update job status to failed:`, error);
              }
            } catch (updateError) {
              console.error(`[upload-pdf] Exception updating job status:`, updateError);
            }
          } else {
            // Try to parse the response for additional debugging
            try {
              const responseData = await analyzeResponse.json();
              console.log('[upload-pdf] Successfully triggered analyze-pdf-text with response:', responseData);
            } catch (parseError) {
              console.log('[upload-pdf] Successfully triggered analyze-pdf-text, but couldn\'t parse response');
            }
          }
        } catch (analyzeError) {
          console.error('[upload-pdf] Exception triggering analyze-pdf-text:', analyzeError);
          
          // Update the job status to indicate there was a problem
          try {
            const { error } = await getSupabaseAdmin()
              .from('podcast_jobs')
              .update({ 
                status: 'failed',
                error_message: `Exception triggering analysis: ${analyzeError.message}`
              })
              .eq('job_id', jobId);
              
            if (error) {
              console.error(`[upload-pdf] Failed to update job status to failed:`, error);
            }
          } catch (updateError) {
            console.error(`[upload-pdf] Exception updating job status:`, updateError);
          }
        }
      }
    } catch (jobError) {
      console.error('[upload-pdf] Exception handling podcast job:', jobError);
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
