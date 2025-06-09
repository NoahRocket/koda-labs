const { Configuration, OpenAIApi } = require('openai');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse request body
    const { topicName } = JSON.parse(event.body);
    
    if (!topicName) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Topic name is required' })
      };
    }

    // Configure OpenAI
    const configuration = new Configuration({
      apiKey: process.env.OPENAI_API_KEY,
    });
    const openai = new OpenAIApi(configuration);

    // Prepare the prompt for OpenAI
    const prompt = `Please select a single emoji that best represents the topic: "${topicName}".
Reply with only the emoji character and nothing else.`;

    // Call OpenAI API to get emoji
    const response = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo', // Using a more economical model since this is a simple task
      messages: [
        { role: 'system', content: 'You are a helpful assistant that selects the most appropriate single emoji for a given topic. Respond with ONLY the emoji character and nothing else.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 10, // Limit to very short response
      temperature: 0.3, // Lower temperature for more predictable results
    });

    // Extract emoji from response
    const emoji = response.data.choices[0].message.content.trim();

    // Return the emoji
    return {
      statusCode: 200,
      body: JSON.stringify({ emoji })
    };
  } catch (error) {
    console.error('Error in assign-emoji function:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `An error occurred: ${error.message}` })
    };
  }
};
