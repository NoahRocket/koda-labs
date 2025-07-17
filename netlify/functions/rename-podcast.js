const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

exports.handler = async (event, context) => {
    // Standard OPTIONS and POST checks
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: JSON.stringify({ message: 'Successful preflight call.' }) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'Method Not Allowed' }) };
    }

    // Authentication
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'Authorization header is missing or invalid.' }) };
    }
    const token = authHeader.split(' ')[1];
    let decodedToken;
    try {
        decodedToken = jwt.decode(token);
        if (!decodedToken || !decodedToken.sub) throw new Error('Invalid token payload');
    } catch (error) {
        return { statusCode: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'Invalid or malformed token.' }) };
    }
    const userId = decodedToken.sub;
    
    // Body parsing
    let body;
    try {
        body = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'Invalid JSON body.' }) };
    }
    const { jobId, newTitle } = body;
    if (!jobId || !newTitle) {
        return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'jobId and newTitle are required.' }) };
    }

    try {
        // 1. Get the current filename from the database
        const { data: jobs, error: fetchError } = await supabase
            .from('podcast_jobs')
            .select('filename')
            .eq('job_id', jobId)
            .eq('user_id', userId);

        if (fetchError) throw new Error(`Database fetch error: ${fetchError.message}`);
        if (!jobs || jobs.length === 0) {
            return { statusCode: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: `Podcast with job ID ${jobId} not found.` }) };
        }

        const oldFilename = jobs[0].filename;
        
        // 2. Preserve the timestamp and extension
        const timestampMatch = oldFilename.match(/_(\d{13})\./);
        const timestamp = timestampMatch ? timestampMatch[1] : Date.now();
        const extension = oldFilename.split('.').pop() || 'mp3';

        const newFilename = `${newTitle}_${timestamp}.${extension}`;

        if (oldFilename === newFilename) {
            return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'No change in title, operation skipped.' }) };
        }

        // 3. Rename the file in Supabase Storage
        const oldPath = `${userId}/${oldFilename}`;
        const newPath = `${userId}/${newFilename}`;

        const { error: moveError } = await supabase.storage
            .from('podcasts')
            .move(oldPath, newPath);

        if (moveError && moveError.message !== 'The resource was not found') {
            console.error(`Storage move error for job ${jobId}:`, moveError);
            throw new Error(`Failed to rename file in storage: ${moveError.message}`);
        }

        // 4. Update the podcast filename in the database
        const { error: updateError } = await supabase
            .from('podcast_jobs')
            .update({ filename: newFilename })
            .eq('job_id', jobId)
            .eq('user_id', userId);

        if (updateError) {
            console.error(`DB update error for job ${jobId}:`, updateError);
            throw new Error(`Failed to update database: ${updateError.message}`);
        }

        return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'Podcast renamed successfully.' }) };

    } catch (error) {
        console.error(`Error renaming podcast for job ${jobId}:`, error);
        return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'Internal Server Error', error: error.message }) };
    }
};
