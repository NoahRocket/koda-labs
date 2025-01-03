// chat.js
// This file handles the request to ChatGPT.

const OPENAI_API_KEY = localStorage.getItem('OPENAI_API_KEY') || 'YOUR_LOCAL_ENV_API_KEY_HERE';
// Alternatively, you could read from Netlify environment variables at build time, 
// but that typically requires a serverless function or bundling step.

async function fetchChatGPTResponse(question) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: question }
        ],
        max_tokens: 150,
        temperature: 0.7
      }),
    });

    const data = await response.json();
    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message.content.trim();
    } else {
      return 'Sorry, I could not find a suitable response. Please try again.';
    }
  } catch (error) {
    console.error('Error fetching data from ChatGPT:', error);
    return 'Oops! Something went wrong.';
  }
}