// Add to your existing handler
case 'getTopicSummary':
  const { data: summary } = await supabase
    .from('summaries')
    .select('*')
    .eq('topic_id', topicId)
    .eq('user_id', userId)
    .single();

  if (!summary) {
    return {
      statusCode: 200,
      body: JSON.stringify({ summary: null, needsUpdate: false })
    };
  }

  // Check if content has been updated since last summary
  const { data: latestContent } = await supabase
    .rpc('get_latest_content_timestamp', { topic_id: topicId });

  const needsUpdate = latestContent > summary.last_source_updated_at;

  return {
    statusCode: 200,
    body: JSON.stringify({ summary, needsUpdate })
  };

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { action, topic_id: topicId } = JSON.parse(event.body);
  const userId = event.headers.authorization?.split(' ')[1]; // Get user ID from token

  try {
    switch (action) {
      case 'getTopicDetails':
        // Get topic details including summary
        const { data: topic, error: topicError } = await supabase
          .from('topics')
          .select(`
            *,
            notes (content, created_at, updated_at),
            conversations (content, created_at),
            bookmarks (url, created_at),
            summaries (
              content,
              created_at,
              last_source_updated_at
            )
          `)
          .eq('id', topicId)
          .single();

        if (topicError) throw topicError;

        // Check if content has been updated since last summary
        let needsUpdate = false;
        if (topic.summaries && topic.summaries.length > 0) {
          const lastSummaryUpdate = new Date(topic.summaries[0].last_source_updated_at);
          
          const allTimestamps = [
            ...(topic.notes?.map(n => new Date(n.updated_at || n.created_at)) || []),
            ...(topic.conversations?.map(c => new Date(c.created_at)) || []),
            ...(topic.bookmarks?.map(b => new Date(b.created_at)) || [])
          ];

          if (allTimestamps.length > 0) {
            const latestContentUpdate = new Date(Math.max(...allTimestamps));
            needsUpdate = latestContentUpdate > lastSummaryUpdate;
          }
        }

        return {
          statusCode: 200,
          body: JSON.stringify({
            ...topic,
            summary: topic.summaries?.[0] || null,
            needsUpdate
          })
        };

      // ... other cases ...
    }
  } catch (error) {
    console.error('Error in topics function:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to process request' })
    };
  }
}; 