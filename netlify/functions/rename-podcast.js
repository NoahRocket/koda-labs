const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

exports.handler = async (event, context) => {
    // Handle pre-flight CORS request
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
            },
            body: JSON.stringify({ message: 'Successful preflight call.' }),
        };
    }

    // Ensure the request is a POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ message: 'Method Not Allowed' })
        };
    }

    // Authenticate the user from the JWT
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return {
            statusCode: 401,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ message: 'Authorization header is missing or invalid.' })
        };
    }

    const token = authHeader.split(' ')[1];
    let decodedToken;
    try {
        decodedToken = jwt.decode(token);
        if (!decodedToken || !decodedToken.sub) {
            throw new Error('Invalid token payload');
        }
    } catch (error) {
        return {
            statusCode: 401,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ message: 'Invalid or malformed token.' })
        };
    }

    const userId = decodedToken.sub;
    
    // Parse the request body
    let body;
    try {
        body = JSON.parse(event.body);
    } catch (error) {
        return {
            statusCode: 400,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ message: 'Invalid JSON body.' })
        };
    }

    const { jobId, newTitle } = body;

    if (!jobId || !newTitle) {
        return {
            statusCode: 400,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ message: 'jobId and newTitle are required.' })
        };
    }

    try {
        // 1. Get the current filename from the database
        const { data: jobData, error: fetchError } = await supabase
            .from('podcast_jobs')
            .select('filename')
            .eq('job_id', jobId)
            .eq('user_id', userId)
            .single();

        if (fetchError) throw fetchError;

        if (!jobData) {
            return {
                statusCode: 404,
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify({ message: 'Podcast not found or you do not have permission to access it.' })
            };
        }

        const oldTitle = jobData.filename;
        const fileExtension = oldTitle.split('.').pop();
        const newTitleWithExtension = `${newTitle}.${fileExtension}`;

        // 2. Rename the file in Supabase Storage
        const oldPath = `${userId}/${oldTitle}`;
        const newPath = `${userId}/${newTitleWithExtension}`;

        const { error: moveError } = await supabase.storage
            .from('podcasts')
            .move(oldPath, newPath);

        if (moveError) {
            // If the file doesn't exist in storage, we might still want to update the DB
            // This depends on how you want to handle inconsistencies.
            // For now, we'll throw an error.
            throw new Error(`Failed to rename file in storage: ${moveError.message}`);
        }

        // 3. Update the podcast title in the database
        const { error: updateError } = await supabase
            .from('podcast_jobs')
            .update({ filename: newTitleWithExtension })
            .eq('job_id', jobId)
            .eq('user_id', userId);

        if (updateError) throw updateError;

        return {
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ message: 'Podcast renamed successfully.' })
        };

    } catch (error) {
        console.error('Error renaming podcast:', error);
        return {
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ message: 'Internal Server Error', error: error.message })
        };
    }
};
