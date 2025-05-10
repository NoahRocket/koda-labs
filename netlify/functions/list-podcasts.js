const { getSupabaseAdmin, getSupabaseAuthClient } = require('./supabaseClient');

exports.handler = async (event) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return { 
      statusCode: 405, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  // Get authorization header for user verification
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { 
      statusCode: 401, 
      body: JSON.stringify({ error: 'Unauthorized: Authentication required' }) 
    };
  }

  let userId;
  try {
    // Verify the user's token and get their ID
    const token = authHeader.split(' ')[1];
    const supabaseAuth = getSupabaseAuthClient();
    const { data, error } = await supabaseAuth.auth.getUser(token);
    
    if (error || !data.user) {
      console.error('Auth error:', error);
      return { 
        statusCode: 401, 
        body: JSON.stringify({ error: 'Unauthorized: Invalid token' }) 
      };
    }
    
    userId = data.user.id;
  } catch (err) {
    console.error('Error parsing auth token:', err);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: 'Server error processing authentication' }) 
    };
  }

  try {
    // Use the admin client to query the database
    const supabase = getSupabaseAdmin();
    
    // Get completed podcasts for this user
    const { data, error } = await supabase
      .from('podcast_jobs')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Database error:', error);
      return { 
        statusCode: 500, 
        body: JSON.stringify({ error: 'Failed to retrieve podcasts' }) 
      };
    }
    
    // Return the list of podcasts
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        podcasts: data.map(podcast => ({
          id: podcast.job_id,
          title: podcast.filename || 'Untitled Podcast',
          created_at: podcast.created_at,
          url: podcast.podcast_url,
          // Add other relevant fields as needed
          concepts: podcast.concepts || []
        }))
      })
    };
  } catch (error) {
    console.error('Error fetching podcasts:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server error fetching podcasts' })
    };
  }
};
