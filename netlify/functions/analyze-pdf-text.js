const fetch = require('node-fetch');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  let text;
  try {
    const body = JSON.parse(event.body);
    text = body.text;
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request body.' })
    };
  }

  if (!text || typeof text !== 'string' || !text.trim()) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'No text provided for analysis.' })
    };
  }

  // Word count check
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount > 10000) {
    return {
      statusCode: 413,
      body: JSON.stringify({ error: 'Text is too long (max 10,000 words).' })
    };
  }

  // Prepare prompt for LLM
  // Prepare prompt for LLM
  const prompt = `Analyze the following text. Identify the top 3-5 key concepts and provide a brief (1-2 sentence) explanation for each. Return your answer as a JSON array of objects with \'concept\' and \'explanation\' fields.\n\nText:\n"""${text.substring(0, 8000)}"""`;

  // Securely load API key
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'LLM API key not configured.' })
    };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an expert assistant for extracting key concepts from documents.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 700,
        temperature: 0.3
      })
    });
    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    // Attempt to parse LLM response as JSON
    let concepts = null;
    try {
      concepts = JSON.parse(content);
    } catch {
      // Try to extract JSON from within text if LLM returns extra text
      const match = content.match(/\[.*\]/s);
      if (match) {
        concepts = JSON.parse(match[0]);
      }
    }
    if (!Array.isArray(concepts)) {
      throw new Error('LLM response not in expected format.');
    }
    // Sanitize output (basic)
    concepts = concepts.map(({ concept, explanation }) => ({
      concept: String(concept).replace(/[<>]/g, ''),
      explanation: String(explanation).replace(/[<>]/g, '')
    }));
    return {
      statusCode: 200,
      body: JSON.stringify({ concepts })
    };
  } catch (error) {
    console.error('LLM analysis error:', error);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Unable to analyze text. Please try again later.' })
    };
  }
};
