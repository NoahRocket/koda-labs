const { getSupabaseAuthClient } = require('./supabaseClient');
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
    // Get the user's ID, email, and billing interval from the request
    const { user, billingInterval = 'monthly' } = JSON.parse(event.body);
    
    if (!user || !user.id || !user.email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing user information' })
      };
    }
    
    // Verify the user's token
    const supabase = getSupabaseAuthClient();
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(user.accessToken);
    
    if (authError || !authUser || authUser.id !== user.id) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' })
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
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
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
      cancel_url: `${event.headers.origin}/pricing.html?subscription=canceled`,
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
      body: JSON.stringify({ error: 'Failed to create checkout session' })
    };
  }
};
