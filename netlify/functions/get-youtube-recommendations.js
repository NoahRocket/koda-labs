const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const CACHE_DURATION_HOURS = 24;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let topicName, topicId;
  try {
    const body = JSON.parse(event.body);
    topicName = body.topicName;
    topicId = body.topicId;
  } catch (error) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }

  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    console.error('YouTube API key is missing.');
    return { statusCode: 500, body: JSON.stringify({ error: 'YouTube API key is not configured.' }) };
  }

  if (!topicName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'topicName is required.' }) };
  }
  if (!topicId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'topicId is required for caching.' }) };
  }

  // 1. Check cache
  try {
    const { data: cachedData, error: cacheError } = await supabase
      .from('topic_video_recommendations')
      .select('videos_data, cached_at')
      .eq('topic_id', topicId)
      .single();

    if (cacheError && cacheError.code !== 'PGRST116') { // PGRST116: 'No rows found'
      console.error('Error fetching from cache:', cacheError);
      // Proceed to fetch from API, but log this error
    }

    if (cachedData) {
      const cacheAgeHours = (new Date() - new Date(cachedData.cached_at)) / (1000 * 60 * 60);
      if (cacheAgeHours < CACHE_DURATION_HOURS) {
        console.log(`Serving YouTube recommendations for topicId ${topicId} from cache.`);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cachedData.videos_data),
        };
      }
      console.log(`Cache for topicId ${topicId} is stale. Fetching fresh data.`);
    }
  } catch (error) {
    console.error('Supabase cache check error:', error);
    // Proceed to fetch from API
  }

  // 2. Fetch from YouTube API if not in cache or cache is stale
  const youtubeApiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(topicName)}&type=video&maxResults=10&key=${apiKey}`;

  try {
    console.log(`Fetching YouTube recommendations for topic "${topicName}" (topicId: ${topicId}) from API.`);
    const response = await fetch(youtubeApiUrl);
    if (!response.ok) {
      const errorData = await response.json();
      console.error('YouTube API Error:', errorData);
      return { statusCode: response.status, body: JSON.stringify({ error: 'Failed to fetch videos from YouTube.', details: errorData }) };
    }

    const data = await response.json();
    const videos = data.items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      thumbnailUrl: item.snippet.thumbnails.default.url,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
    }));

    // 3. Store in cache
    try {
      const { error: upsertError } = await supabase
        .from('topic_video_recommendations')
        .upsert({
          topic_id: topicId,
          videos_data: videos,
          cached_at: new Date().toISOString(),
        }, { onConflict: 'topic_id' }); // Use onConflict to update if topic_id already exists

      if (upsertError) {
        console.error('Error saving to cache:', upsertError);
        // Still return data to user even if cache save fails
      } else {
        console.log(`Successfully cached YouTube recommendations for topicId ${topicId}.`);
      }
    } catch (dbError) {
        console.error('Supabase cache upsert error:', dbError);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(videos),
    };
  } catch (error) {
    console.error('Error fetching YouTube videos or processing cache:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error while fetching videos.' }) };
  }
};
