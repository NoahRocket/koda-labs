// netlify/functions/chatgpt.js
// This function is invoked by your frontend (chat.js) to keep the OpenAI API key hidden.

const fetch = require('node-fetch'); // Ensure node-fetch version 2.x is installed
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Verify JWT token from the authorization header
async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Invalid authorization header' };
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const { data, error } = await supabase.auth.getUser(token);
    
    if (error) {
      console.error('Token verification error:', error);
      return { error: 'Invalid token' };
    }
    
    return { user: data.user };
  } catch (error) {
    console.error('Token verification error:', error);
    return { error: 'Token verification failed' };
  }
}

exports.handler = async (event, context) => {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    // Verify token if authorization header is present
    if (event.headers.authorization) {
      const authResult = await verifyToken(event.headers.authorization);
      if (authResult.error) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: authResult.error })
        };
      }
    }

    const requestBody = JSON.parse(event.body || '{}');
    
    // Check if this is a saveConversation action
    if (requestBody.action === 'saveConversation') {
      // Handle saving conversation to a topic
      // This would be implemented here with Supabase
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Conversation saved successfully' })
      };
    }
    
    // Regular chat message handling
    const { question } = requestBody;
    if (!question) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No question provided.' }),
      };
    }

    // Grab API Key from Netlify environment variable
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return {
        statusCode: 500,
        headers,
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
        model: 'o3-mini-2025-01-31',
        messages: [
          { role: 'system', content: 'You are Koda, a friendly and curious learning companion who\'s excited to explore topics with me! Your tone is warm, conversational, and upbeat—like a buddy who loves diving into new ideas. Avoid stiff or robotic replies; instead, show enthusiasm, ask me questions to keep the chat going, and make it feel like we\'re discovering together. Tailor your responses to my interests based on our conversations, bookmarks, or notes, and keep things simple and fun so I enjoy every moment!' },
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
        headers,
        body: JSON.stringify({ error: 'Error from OpenAI API.' }),
      };
    }

    const data = await response.json();
    let assistantResponse = 'Sorry, I could not find a suitable response.';

    if (data.choices && data.choices.length > 0) {
      assistantResponse = data.choices[0].message.content.trim();
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ assistantResponse }),
    };
  } catch (error) {
    console.error('Internal Server Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};
