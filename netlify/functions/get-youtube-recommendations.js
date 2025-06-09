const fetch = require('node-fetch');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { topicName } = JSON.parse(event.body);
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    console.error('YouTube API key is missing.');
    return { statusCode: 500, body: JSON.stringify({ error: 'YouTube API key is not configured.' }) };
  }

  if (!topicName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'topicName is required.' }) };
  }

  const youtubeApiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(topicName)}&type=video&maxResults=10&key=${apiKey}`;

  try {
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

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(videos),
    };
  } catch (error) {
    console.error('Error fetching YouTube videos:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error while fetching videos.' }) };
  }
};
