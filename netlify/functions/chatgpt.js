// netlify/functions/chatgpt.js
// This function is invoked by your frontend (chat.js) to keep the OpenAI API key hidden.

const fetch = require('node-fetch'); // If you're using Node 18+ you might not need this import

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const { question } = JSON.parse(event.body || '{}');
    if (!question) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No question provided.' }),
      };
    }

    // Grab API Key from Netlify environment variable
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Missing OpenAI API key in environment.' }),
      };
    }

    // Forward request to OpenAI ChatGPT
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: question }
        ],
        max_tokens: 150,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: errorText }),
      };
    }

    const data = await response.json();
    let assistantMessage = 'Sorry, I could not find a suitable response.';

    if (data.choices && data.choices.length > 0) {
      assistantMessage = data.choices[0].message.content.trim();
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ assistantResponse: assistantMessage }),
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};
