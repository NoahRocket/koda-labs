// netlify/functions/chatgpt.js
// This function is invoked by your frontend (chat.js) to keep the OpenAI API key hidden.

const fetch = require('node-fetch'); // Ensure node-fetch version 2.x is installed
const { getSupabaseAuthClient } = require('./supabaseClient');

// Verify JWT token from the authorization header
async function verifyToken(authHeader) {
  const supabase = getSupabaseAuthClient();
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
    
    console.log(`Access Token from header: ${token.slice(0, 10)}...${token.slice(-4)}`);
    
    return { user: data.user };
  } catch (error) {
    console.error('Token verification error:', error);
    return { error: 'Token verification failed' };
  }
}

// Helper function to convert markdown to plain text
function markdownToPlainText(markdown) {
  if (!markdown) return '';
  
  // Replace bold/italic formatting
  let text = markdown
    .replace(/\*\*(.*?)\*\*/g, '$1') // Remove bold **text**
    .replace(/\*(.*?)\*/g, '$1')     // Remove italic *text*
    .replace(/__(.*?)__/g, '$1')     // Remove bold __text__
    .replace(/_(.*?)_/g, '$1')       // Remove italic _text_
    
    // Replace headers
    .replace(/#{1,6}\s+(.+)/g, '$1') // Replace # Header with just Header
    
    // Replace links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1') // Replace [text](url) with just text
    
    // Replace lists
    .replace(/^\s*[-*+]\s+/gm, '• ') // Replace bullet lists with plain bullets
    .replace(/^\s*\d+\.\s+/gm, '$1. ') // Keep numbering for numbered lists
    
    // Replace code blocks and inline code
    .replace(/```(?:.*?)\n([\s\S]*?)```/g, '$1') // Remove code block markers
    .replace(/`([^`]+)`/g, '$1'); // Remove inline code markers
  
  return text;
}

// Format conversation messages into a readable text string
function formatConversationForSaving(messages) {
  // Filter out system messages
  const userMessages = messages.filter(msg => msg.role !== 'system');
  
  // Convert the conversation to a readable format
  let formattedText = '';
  
  userMessages.forEach(msg => {
    if (msg.role === 'user') {
      formattedText += `You: ${markdownToPlainText(msg.content)}\n\n`;
    } else if (msg.role === 'assistant') {
      formattedText += `Koda: ${markdownToPlainText(msg.content)}\n\n`;
    }
  });
  
  return formattedText.trim();
}

module.exports.handler = async (event, context) => {
  const startTime = Date.now();
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
      const token = event.headers.authorization.split(' ')[1];
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_KEY;
      
      // Create a properly authenticated Supabase client
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        },
        global: {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      });
      
      const { userId, topicId, messages } = requestBody;
      
      // Validate required fields
      if (!topicId || !messages) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Missing required fields for saving conversation' })
        };
      }
      
      try {
        // Format conversation data
        const conversationData = {
          topic_id: topicId,
          // user_id: authUserId, // REMOVED: conversations table does not have a user_id column directly
          content: formatConversationForSaving(messages),
          created_at: new Date().toISOString()
        };
        
        // Save to Supabase using the authenticated client
        const { data, error } = await supabase
          .from('conversations')
          .insert([conversationData]);
        
        if (error) {
          console.error('Supabase error saving conversation:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to save conversation', details: error.message })
          };
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            success: true, 
            message: 'Conversation saved successfully',
            data
          })
        };
      } catch (error) {
        console.error('Error saving conversation:', error);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Internal server error saving conversation' })
        };
      }
    }
    
    // Check if this is a deleteConversation action
    if (requestBody.action === 'deleteConversation') {
      const token = event.headers.authorization.split(' ')[1];
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_KEY;
      
      // Create a properly authenticated Supabase client
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        },
        global: {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      });
      
      const { conversationId } = requestBody;
      
      // Validate required fields
      if (!conversationId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Missing conversation ID' })
        };
      }
      
      try {
        // Delete the conversation
        const { data, error } = await supabase
          .from('conversations')
          .delete()
          .eq('id', conversationId);
        
        if (error) {
          console.error('Supabase error deleting conversation:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to delete conversation', details: error.message })
          };
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            success: true, 
            message: 'Conversation deleted successfully'
          })
        };
      } catch (error) {
        console.error('Error deleting conversation:', error);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Internal server error deleting conversation' })
        };
      }
    }
    
    // Check if this is a typing indicator request
    if (requestBody.action === 'typing') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          typing: true, 
          message: "Koda is thinking..." 
        })
      };
    }
    
    // Regular chat message handling
    const { messages } = requestBody; // Extract messages array
    if (!messages || !Array.isArray(messages) || messages.length === 0) { // Check if messages is a valid, non-empty array
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No messages provided in the request.' }),
      };
    }

    // Only send the last 5 messages to OpenAI
    const trimmedMessages = messages.slice(-5);

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
        model: 'gpt-4.1-2025-04-14', 
        messages: [ // New structure: System prompt + conversation history
          { role: 'system', content: 'You are Koda, a friendly and curious learning companion who\'s excited to explore topics with me! Your tone is warm, conversational, and upbeat—like a buddy who loves diving into new ideas. Avoid stiff or robotic replies; instead, show enthusiasm, ask me questions to keep the chat going, and make it feel like we\'re discovering together. Tailor your responses to my interests based on our conversations, bookmarks, or notes, and keep things simple and fun so I enjoy every moment! Try to use ideally less then 500 tokens per response but if you feel like a question warrants a longer response, do so. **Use Markdown formatting (e.g., bold, italics) to emphasize key terms and concepts.**' },
          ...trimmedMessages // Only the last 5 messages
        ],
        max_completion_tokens: 1500 // Increased token limit
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', errorText);
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ 
          error: 'Error from OpenAI API.', 
          details: errorText,
          status: response.status,
          statusText: response.statusText 
        }),
      };
    }

    const data = await response.json();
    let assistantResponse = data.choices[0]?.message?.content || 'No response';

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
  } finally {
    console.log(`Request processed in ${Date.now() - startTime}ms`);
  }
};
