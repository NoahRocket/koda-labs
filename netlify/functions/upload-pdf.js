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
    
    // Note: We're assuming the 'podcasts' bucket already exists in Supabase
    // We'll skip the bucket existence check as the service role may not have permission to list buckets
    console.log(`[upload-pdf] Assuming bucket '${PDF_BUCKET_NAME}' exists and attempting direct upload`);
    
    const { data: storageData, error: storageError } = await supabaseAdmin.storage
      .from(PDF_BUCKET_NAME)
      .upload(filePath, fileData.buffer, {
        contentType: fileData.mimetype,
        upsert: true,
      });

    console.timeEnd('supabaseUpload');
    
    // Handle storage upload errors
    if (storageError) {
      console.error('[upload-pdf] Storage upload failed with error code:', storageError.statusCode || storageError.status);
      console.error('[upload-pdf] Storage error message:', storageError.message);
      console.error('[upload-pdf] Storage error details:', JSON.stringify(storageError, null, 2));
      console.error(`[upload-pdf] Upload attempted for: bucket='${PDF_BUCKET_NAME}', path='${filePath}'`);
      
      // Check if this could be a permission issue
      if (storageError.statusCode === 400 || storageError.status === 400 || 
          storageError.message?.includes('security policy')) {
        return {
          statusCode: 500,
          body: JSON.stringify({ 
            error: 'Storage permission error. Make sure your service role has proper permissions.', 
            details: `The server has permission to access the API but lacks permission to upload to the '${PDF_BUCKET_NAME}' bucket. Check bucket permissions in Supabase dashboard.`,
            code: storageError.code || storageError.statusCode || 'permission_denied'
          }),
          headers: { 'Content-Type': 'application/json' },
        };
      }

      // General error response
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: 'Failed to upload PDF to storage.', 
          details: storageError.message,
          code: storageError.statusCode || storageError.status || 'unknown'
        }),
        headers: { 'Content-Type': 'application/json' },
      };
    }
    
    console.log('Supabase Storage upload successful:', storageData);
    
    // Store the response data
    const responseData = {
      extractedText: extractedText,
      storagePath: storageData.path,
      originalFilename: fileData.originalFilename
    };

    // After successfully parsing, delete the PDF since we don't need to store it permanently
    // The extracted text will be stored in the podcast_jobs table
    try {
      console.log(`[upload-pdf] Cleaning up: Deleting temporary PDF from storage: ${filePath}`);
      const { error: deleteError } = await supabaseAdmin.storage
        .from(PDF_BUCKET_NAME)
        .remove([filePath]);
      
      if (deleteError) {
        console.warn(`[upload-pdf] Warning: Could not delete temporary PDF: ${deleteError.message}`);
        // Continue despite deletion error - this is not critical
      } else {
        console.log('[upload-pdf] Temporary PDF successfully deleted from storage');
      }
    } catch (deleteErr) {
      console.warn('[upload-pdf] Exception during PDF deletion cleanup:', deleteErr);
      // Continue despite error - PDF cleanup is not critical to the main flow
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
