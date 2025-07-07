const { getSupabaseAdmin } = require('./supabaseClient');

exports.handler = async (event) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return { 
      statusCode: 405, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  let userId = null;
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const tokenParts = token.split('.');
      if (tokenParts.length !== 3) throw new Error('Invalid JWT format');
      
      let base64Payload = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base64Payload.length % 4) {
        base64Payload += '=';
      }
      const decodedPayload = Buffer.from(base64Payload, 'base64').toString('utf8');
      const payload = JSON.parse(decodedPayload);
      
      userId = payload.sub || payload.user_id || payload.id;
      if (!userId) throw new Error('No user ID found in token payload');
      
      console.log(`[list-podcasts] Authenticated as user: ${userId}`);
    } catch (err) {
      console.error('[list-podcasts] Auth error:', err.message);
      // Do not proceed without a valid user ID
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized: Invalid token' })
      };
    }
  } else {
    console.warn('[list-podcasts] No Authorization header found.');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Unauthorized: Missing Authorization header' })
    };
  }

  try {
    const supabase = getSupabaseAdmin();
    
    // Fetch completed podcast jobs for the user from the database.
    // This is the single source of truth for the user's podcasts.
    const { data: jobs, error: dbError } = await supabase
      .from('podcast_jobs')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });

    if (dbError) {
      console.error('[list-podcasts] Database error:', dbError);
      throw new Error('Failed to fetch podcast jobs from the database.');
    }

    // Map the database records to the response format.
    const podcastList = jobs.map(job => ({
      id: job.job_id, // Use job_id for consistency
      title: job.filename ? job.filename.replace(/\.pdf$/i, '') : 'Untitled Podcast',
      created_at: job.created_at,
      audio_url: job.podcast_url,
      source: 'database',
      status: job.status,
      concepts: job.concepts || [],
      duration_seconds: job.duration_seconds || 0, // Default to 0 if not present
      job_id: job.job_id
    }));

    console.log(`[list-podcasts] Found and returning ${podcastList.length} podcasts for user ${userId}.`);

    return {
      statusCode: 200,
      body: JSON.stringify({ podcasts: podcastList })
    };

  } catch (error) {
    console.error('[list-podcasts] Server error:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error fetching podcasts' })
    };
  }
};
