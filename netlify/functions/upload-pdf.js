const pdf = require('pdf-parse');
const Busboy = require('busboy');
const { getSupabaseAuthClient, getSupabaseAdmin, PDF_BUCKET_NAME } = require('./supabaseClient');

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

  // Verify authentication
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
    
    const token = authHeader.split(' ')[1];
    const supabaseAuth = getSupabaseAuthClient();
    const { data: userAuthData, error: authError } = await supabaseAuth.auth.getUser(token);

    if (authError || !userAuthData.user) {
      console.error('Authentication error:', authError);
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized: Invalid or expired token' }),
        headers: { 'Content-Type': 'application/json' },
      };
    }
    
    userId = userAuthData.user.id;
    console.timeEnd('auth-verification');
    console.log('[upload-pdf] Auth successful, userId:', userId);
  } catch (err) {
    console.error('Error during authentication processing:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error during authentication' }),
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
    const filePath = `${userId}/${Date.now()}-${fileData.originalFilename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    console.log(`Attempting to upload to Supabase Storage: bucket='${PDF_BUCKET_NAME}', path='${filePath}'`);
    
    const supabaseAdmin = getSupabaseAdmin();
    const { data: storageData, error: storageError } = await supabaseAdmin.storage
      .from(PDF_BUCKET_NAME)
      .upload(filePath, fileData.buffer, {
        contentType: fileData.mimetype,
        upsert: true,
      });

    console.timeEnd('supabaseUpload');
    
    // Handle storage upload errors
    if (storageError) {
      console.error('Supabase Storage upload error:', storageError);
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: 'Failed to upload PDF to storage.', 
          details: storageError.message 
        }),
        headers: { 'Content-Type': 'application/json' },
      };
    }
    
    console.log('Supabase Storage upload successful:', storageData);

    // Return success response with extracted text and storage details
    console.timeEnd('total-execution');
    console.log('[upload-pdf] Function completed successfully');
    return {
      statusCode: 200,
      body: JSON.stringify({
        extractedText: extractedText,
        storagePath: storageData.path,
        originalFilename: fileData.originalFilename
      }),
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
