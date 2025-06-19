const pdf = require('pdf-parse');
const Busboy = require('busboy');
const stream = require('stream');
const { getSupabaseAuthClient, getSupabaseAdmin, PDF_BUCKET_NAME } = require('./supabaseClient');

exports.handler = (event) => {
  return new Promise(async (resolve, reject) => {
    if (event.httpMethod !== 'POST') {
      return resolve({
        statusCode: 405,
        body: JSON.stringify({ error: 'Method Not Allowed' }),
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let userId;
    try {
      const authHeader = event.headers.authorization || event.headers.Authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return resolve({
          statusCode: 401,
          body: JSON.stringify({ error: 'Unauthorized: Authentication token required' }),
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const token = authHeader.split(' ')[1];
      const supabaseAuth = getSupabaseAuthClient();
      const { data: userAuthData, error: authError } = await supabaseAuth.auth.getUser(token);

      if (authError || !userAuthData.user) {
        console.error('Authentication error:', authError);
        return resolve({
          statusCode: 401,
          body: JSON.stringify({ error: 'Unauthorized: Invalid or expired token' }),
          headers: { 'Content-Type': 'application/json' },
        });
      }
      userId = userAuthData.user.id;
    } catch (err) {
      console.error('Error during authentication processing:', err);
      return resolve({
        statusCode: 500,
        body: JSON.stringify({ error: 'Server error during authentication' }),
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const busboy = Busboy({ headers: event.headers });
    let fileBuffer = null;
    let originalFilename = '';
    let mimetype = 'application/octet-stream'; // Default mimetype

    busboy.on('file', (fieldname, file, info) => {
      originalFilename = info.filename; 
      mimetype = info.mimeType;
      console.log(`File [${fieldname}]: filename: ${originalFilename}, encoding: ${info.encoding}, mimetype: ${mimetype}`);
      
      const chunks = [];
      file.on('data', (chunk) => {
        chunks.push(chunk);
      });

      file.on('end', async () => {
        fileBuffer = Buffer.concat(chunks);
        console.log(`File [${fieldname}] Finished. Buffer size: ${fileBuffer.length}`);
        
        if (!fileBuffer || fileBuffer.length === 0) {
          console.error('File buffer is empty. Cannot process.');
          return resolve({
            statusCode: 400,
            body: JSON.stringify({ error: 'No file data received or file is empty.' }),
            headers: { 'Content-Type': 'application/json' },
          });
        }

        try {
          // 1. Perform PDF text extraction
          const pdfExtractData = await pdf(fileBuffer);
          const extractedText = pdfExtractData.text || 'No text found in PDF.';

          // 2. Upload PDF to Supabase Storage
          const supabaseAdmin = getSupabaseAdmin();
          const filePath = `${userId}/${Date.now()}-${originalFilename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
          
          console.log(`Attempting to upload to Supabase Storage: bucket='${PDF_BUCKET_NAME}', path='${filePath}'`);

          const { data: storageData, error: storageError } = await supabaseAdmin.storage
            .from(PDF_BUCKET_NAME)
            .upload(filePath, fileBuffer, {
              contentType: mimetype, // Use the mimetype from busboy
              upsert: true, // Overwrite if file exists (though timestamp makes it unique)
            });

          if (storageError) {
            console.error('Supabase Storage upload error:', storageError);
            return resolve({
              statusCode: 500,
              body: JSON.stringify({ error: 'Failed to upload PDF to storage.', details: storageError.message }),
              headers: { 'Content-Type': 'application/json' },
            });
          }
          console.log('Supabase Storage upload successful:', storageData);

          // 3. Resolve with extracted text, storage path, and original filename
          resolve({
            statusCode: 200,
            body: JSON.stringify({
              extractedText: extractedText,
              storagePath: storageData.path, // path within the bucket
              originalFilename: originalFilename
            }),
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('Error processing PDF, extracting text, or uploading to storage:', error);
          resolve({
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process PDF file.', details: error.message }),
            headers: { 'Content-Type': 'application/json' },
          });
        }
      });
    });

    busboy.on('error', (error) => {
      console.error('Busboy error:', error);
      // Ensure not to call resolve/reject if already done
      resolve({
        statusCode: 500,
        body: JSON.stringify({ error: 'Error parsing form data' }),
        headers: { 'Content-Type': 'application/json' },
      });
    });

    busboy.on('finish', () => {
      console.log('Done parsing form!');
      // If no file was processed, busboy might finish without 'file' event's resolve being called.
      // This typically means no file was part of the multipart request.
      // We should ensure that a response is always sent.
      // However, if 'file' event is emitted, its 'end' handler is responsible for resolving.
      // If no 'file' event, this 'finish' might be the first point to realize it.
      // For robust handling, check if a response has already been sent.
    });

    let bodyContents = event.body;
    if (event.isBase64Encoded) {
        bodyContents = Buffer.from(event.body, 'base64');
    }
  });
};
