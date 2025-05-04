const pdf = require('pdf-parse');
const Busboy = require('busboy');
const stream = require('stream');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  // Debug: log headers and buffer size
  console.log('Headers:', event.headers);
  const buffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  console.log('Buffer size:', buffer.length);

  return new Promise((resolve) => {
    try {
      const busboy = Busboy({
        headers: {
          'content-type': event.headers['content-type'] || event.headers['Content-Type'],
        },
      });

      let fileBuffer = Buffer.alloc(0);
      let fileFound = false;

      busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        console.log('Busboy file event:', { fieldname, filename, encoding, mimetype });
        // Accept any file type for debugging
        fileFound = true;
        file.on('data', (data) => {
          fileBuffer = Buffer.concat([fileBuffer, data]);
        });
      });

      busboy.on('finish', async () => {
        console.log('Busboy finish event. fileFound:', fileFound, 'fileBuffer size:', fileBuffer.length);
        if (!fileFound || fileBuffer.length === 0) {
          resolve({
            statusCode: 400,
            body: JSON.stringify({ error: 'No PDF file uploaded or file is empty.' }),
            headers: { 'Content-Type': 'application/json' },
          });
          return;
        }
        try {
          const data = await pdf(fileBuffer);
          resolve({
            statusCode: 200,
            body: JSON.stringify({ extractedText: data.text || 'No text found in PDF.' }),
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          let errorMessage = 'Failed to process PDF.';
          if (error.message && error.message.includes('password')) {
            errorMessage = 'Unable to extract text. The PDF might be password-protected.';
          } else if (error instanceof Error) {
            errorMessage = `Unable to extract text. ${error.message}`;
          }
          resolve({
            statusCode: 500,
            body: JSON.stringify({ error: errorMessage }),
            headers: { 'Content-Type': 'application/json' },
          });
        }
      });

      // Pipe buffer as a stream
      const readable = new stream.PassThrough();
      readable.end(buffer);
      readable.pipe(busboy);
    } catch (err) {
      console.log('Server error parsing upload:', err);
      resolve({
        statusCode: 500,
        body: JSON.stringify({ error: 'Server error parsing upload.' }),
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });
};
