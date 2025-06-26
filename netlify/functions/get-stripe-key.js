/**
 * Function to provide the Stripe publishable key to the frontend
 * This keeps the key out of the frontend code and allows for easier environment variable management
 */
exports.handler = async (event, context) => {
  // Set CORS headers for browser clients
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: ''
    };
  }

  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Get the publishable key from environment variables
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
    
    if (!publishableKey) {
      console.error('STRIPE_PUBLISHABLE_KEY environment variable is not set');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Stripe publishable key not configured' })
      };
    }
    
    // Return the publishable key
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ publishableKey })
    };
  } catch (error) {
    console.error('Error in get-stripe-key function:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to get Stripe publishable key' })
    };
  }
};
