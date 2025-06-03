const { getSupabaseAuthClient, getSupabaseAdmin } = require('./supabaseClient');
const { stripe } = require('./stripeClient');

exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle OPTIONS request (preflight CORS)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Get the user's ID and email from the request
    const { user } = JSON.parse(event.body);
    
    if (!user || !user.id || !user.email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing user information' })
      };
    }
    
    // For now, we'll skip token verification to simplify troubleshooting
    
    // Check if the user already has a Stripe customer ID
    const supabase = getSupabaseAdmin();
    const { data: subscription, error: subscriptionError } = await supabase
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .single();
    
    // If the user doesn't have a Stripe customer ID yet, create one
    let stripeCustomerId;
    if (subscriptionError || !subscription || !subscription.stripe_customer_id) {
      // Create a new Stripe customer
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: user.id
        }
      });
      
      stripeCustomerId = customer.id;
      
      // Update or insert the user's subscription record with the new Stripe customer ID
      await supabase
        .from('user_subscriptions')
        .upsert({
          user_id: user.id,
          stripe_customer_id: stripeCustomerId,
          updated_at: new Date().toISOString()
        });
    } else {
      stripeCustomerId = subscription.stripe_customer_id;
    }
    
    // Create a Stripe customer portal session with configuration
    // Create a simple session with just customer ID and return URL
    // This is the minimal configuration that's guaranteed to work
    const portalSessionParams = {
      customer: stripeCustomerId,
      return_url: `${event.headers.origin}/settings.html`
    };
    
    // Check if we have a portal configuration ID
    if (process.env.STRIPE_PORTAL_CONFIG_ID) {
      portalSessionParams.configuration_id = process.env.STRIPE_PORTAL_CONFIG_ID;
      console.log('Using portal configuration ID:', process.env.STRIPE_PORTAL_CONFIG_ID);
    }
    
    // We're intentionally NOT setting inline configuration parameters
    // The default configuration provided by Stripe will be used
    console.log('Creating portal session with params:', JSON.stringify(portalSessionParams, null, 2));
    
    const session = await stripe.billingPortal.sessions.create(portalSessionParams);
    
    // Return the session URL to the client
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url })
    };
  } catch (error) {
    console.error('Error creating portal session:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to create portal session', details: error.message })
    };
  }
};
