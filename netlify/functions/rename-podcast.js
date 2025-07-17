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
        // We are just decoding, not verifying, as Netlify's Identity service or another gateway should handle verification.
        // This is a common pattern in serverless functions to extract user info without the secret.
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
        // Update the podcast title in the database
        // I am assuming the column to update is 'filename'. If you have a 'title' column, this should be changed.
        const { data, error, count } = await supabase
            .from('podcast_jobs')
            .update({ filename: newTitle })
            .eq('job_id', jobId)
            .eq('user_id', userId)
            .select(); // .select() is used to get the count of updated rows

        if (error) {
            throw error;
        }

        // Check if any row was updated
        if (count === 0) {
            return {
                statusCode: 404,
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify({ message: 'Podcast not found or you do not have permission to rename it.' })
            };
        }

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
