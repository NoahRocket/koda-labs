// chat.js
// This file handles the request to your Netlify serverless function instead of calling OpenAI directly.

async function fetchChatGPTResponse(question) {
  try {
    // Call the Netlify function (which is at /.netlify/functions/chatgpt)
    const response = await fetch('/.netlify/functions/chatgpt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question }),
    });

    const data = await response.json();

    if (data.assistantResponse) {
      return data.assistantResponse;
    } else if (data.error) {
      console.error('Error from function:', data.error);
      return 'Sorry, there was an error retrieving a response.';
    } else {
      return 'Sorry, I could not find a suitable response.';
    }
  } catch (error) {
    console.error('Error calling Netlify function:', error);
    return 'Oops! Something went wrong.';
  }
}
