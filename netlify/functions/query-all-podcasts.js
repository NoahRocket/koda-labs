const { getSupabaseAdmin } = require('./supabaseClient');

exports.handler = async (event) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return { 
      statusCode: 405, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  try {
    // Use the admin client to query the database
    const supabase = getSupabaseAdmin();
    
    // Get all podcasts in the system
    const { data, error } = await supabase
      .from('podcast_jobs')
      .select('*');
      
    if (error) {
      console.error('Database error:', error);
      return { 
        statusCode: 500, 
        body: JSON.stringify({ error: 'Failed to retrieve podcasts' }) 
      };
    }
    
    // Log what we found
    console.log(`Total podcasts in database: ${data.length}`);
    
    if (data.length > 0) {
      console.log('Podcasts found:');
      data.forEach(podcast => {
        console.log(`ID: ${podcast.job_id}, User: ${podcast.user_id}, Status: ${podcast.status}, Created: ${podcast.created_at}`);
      });
    } else {
      console.log('No podcasts found in the database at all');
    }
    
    // Return the list of all podcasts
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        podcastCount: data.length,
        podcasts: data.map(podcast => ({
          id: podcast.job_id,
          user_id: podcast.user_id,
          status: podcast.status,
          created_at: podcast.created_at,
          podcast_url: podcast.podcast_url
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
