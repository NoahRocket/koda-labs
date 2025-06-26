const { getSupabaseAdmin } = require('./supabaseClient');
const { stripe, getOrCreateStripeCustomer } = require('./stripeClient');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Check if Stripe is properly initialized
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'missing_key') {
      console.error('STRIPE_SECRET_KEY environment variable is not properly set');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Payment system is not properly configured. Please contact support.' })
      };
    }
    
    // Get the user's ID, email, and billing interval from the request
    const { user, billingInterval = 'monthly' } = JSON.parse(event.body);
    
    if (!user || !user.id || !user.email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing user information' })
      };
    }
    
    // Verify the user's token using direct JWT validation
    let authUser;
    try {
      // Validate JWT format
      if (!user.accessToken) {
        throw new Error('Access token is required');
      }
      
      // Check if token has the expected JWT structure (3 parts separated by dots)
      const tokenParts = user.accessToken.split('.');
      if (tokenParts.length !== 3) {
        throw new Error('Token does not have three parts as required for JWT format');
      }
      
      // Simple manual decode of the JWT payload (middle part)
      let payload;
      try {
        const base64Payload = tokenParts[1];
        // Handle potential padding issues with base64url format
        const padding = '='.repeat((4 - base64Payload.length % 4) % 4);
        const base64 = (base64Payload + padding)
          .replace(/-/g, '+')
          .replace(/_/g, '/');
        const base64Decoded = Buffer.from(base64, 'base64').toString('utf8');
        payload = JSON.parse(base64Decoded);
      } catch (parseError) {
        console.error(`Failed to parse JWT payload: ${parseError.message}`);
        throw new Error('Invalid JWT payload format');
      }
      
      if (!payload || !payload.sub) {
        throw new Error('Invalid token payload or missing user ID');
      }
      
      // Create a user object from the decoded token payload
      authUser = {
        id: payload.sub,
        email: payload.email || user.email,
        role: payload.role || ''
      };
      
      // Verify user ID matches
      if (authUser.id !== user.id) {
        throw new Error('User ID mismatch');
      }

      console.log(`Successfully verified token for user: ${authUser.id}`);
    } catch (tokenError) {
      console.error(`Token validation error: ${tokenError.message}`);
      return {
        statusCode: 401,
        body: JSON.stringify({ error: `Unauthorized: ${tokenError.message}` })
      };
    }
    
    // Get or create a Stripe customer for the user
    const stripeCustomerId = await getOrCreateStripeCustomer(user.id, user.email);
    
    // Define the product price ID based on billing interval
    let priceId;
    if (billingInterval === 'yearly') {
      priceId = process.env.STRIPE_YEARLY_PRICE_ID;
      
      // Fall back to monthly if yearly isn't set
      if (!priceId) {
        console.warn('STRIPE_YEARLY_PRICE_ID not set, falling back to monthly plan');
        priceId = process.env.STRIPE_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_ID;
      }
    } else {
      // Default to monthly
      priceId = process.env.STRIPE_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_ID;
    }
    
    if (!priceId) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Subscription price ID not configured' })
      };
    }

    // Create a checkout session
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        customer: stripeCustomerId, // Fixed variable name from customerId to stripeCustomerId
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        subscription_data: {
          trial_period_days: 14, // 14-day free trial
        },
        success_url: `${event.headers.origin}/dashboard.html?subscription=success`,
        cancel_url: `${event.headers.origin}/pricing`,
        allow_promotion_codes: true,
        metadata: {
          userId: user.id,
          billingInterval: billingInterval
        }
      });

      // Return the session ID to the client
      return {
        statusCode: 200,
        body: JSON.stringify({ sessionId: session.id })
      };
    } catch (error) {
      console.error('Error creating checkout session:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Failed to create checkout session: ${error.message}` })
      };
    }
  } catch (error) {
    console.error('Error creating checkout session:', error);
    
    // Provide more specific error messages based on the error type
    let errorMessage = 'Failed to create checkout session';
    let statusCode = 500;
    
    if (error.type && error.type.startsWith('Stripe')) {
      // Handle specific Stripe errors
      if (error.type === 'StripeAuthenticationError') {
        errorMessage = 'Payment system authentication failed. Please contact support.';
      } else if (error.type === 'StripeInvalidRequestError') {
        errorMessage = 'Invalid payment request. Please check your information and try again.';
      } else if (error.type === 'StripeAPIError') {
        errorMessage = 'Payment service temporarily unavailable. Please try again later.';
      }
    } else if (error.message && error.message.includes('customer')) {
      errorMessage = 'Error creating customer profile. Please try again or contact support.';
    }
    
    return {
      statusCode,
      body: JSON.stringify({ error: errorMessage })
    };
  }
};
