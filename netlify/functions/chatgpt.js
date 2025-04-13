// netlify/functions/chatgpt.js
// This function is invoked by your frontend (chat.js) to keep the OpenAI API key hidden.

const fetch = require('node-fetch'); // Ensure node-fetch version 2.x is installed

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const { question } = JSON.parse(event.body || '{}');
    if (!question) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No question provided.' }),
      };
    }

    // Grab API Key from Netlify environment variable
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
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
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are Koda, a friendly and curious learning companion who’s excited to explore topics with me! Your tone is warm, conversational, and upbeat—like a buddy who loves diving into new ideas. Avoid stiff or robotic replies; instead, show enthusiasm, ask me questions to keep the chat going, and make it feel like we’re discovering together. Tailor your responses to my interests based on our conversations, bookmarks, or notes, and keep things simple and fun so I enjoy every moment!' },
          { role: 'user', content: question }
        ],
        max_tokens: 1000,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', errorText);
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Error from OpenAI API.' }),
      };
    }

    const data = await response.json();
    let assistantMessage = 'Sorry, I could not find a suitable response.';

    if (data.choices && data.choices.length > 0) {
      assistantMessage = data.choices[0].message.content.trim();
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistantResponse: assistantMessage }),
    };
  } catch (error) {
    console.error('Internal Server Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};
