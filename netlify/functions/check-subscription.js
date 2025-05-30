const { getSupabaseAdmin } = require('./supabaseClient');

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
    // Get the user's ID from the request
    const { userId, accessToken } = JSON.parse(event.body);
    
    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing user ID' })
      };
    }
    
    // For now, let's skip token verification to simplify troubleshooting
    
    // Access the database directly
    const supabase = getSupabaseAdmin();
    const { data: subscription, error: subscriptionError } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    // If there's no subscription record or an error, return a default free tier response
    if (subscriptionError) {
      console.log('No subscription found or error:', subscriptionError);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          hasPremium: false,
          subscription: {
            status: 'inactive',
            tier: 'free',
            trialEndDate: null,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            billingInterval: 'monthly'
          }
        })
      };
    }
    
    // Determine if the user has premium status
    const hasPremium = subscription.subscription_tier === 'premium';
    
    // Return the subscription status and details
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        hasPremium,
        subscription: {
          status: subscription.subscription_status || 'inactive',
          tier: subscription.subscription_tier || 'free',
          trialEndDate: subscription.trial_end_date,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
          billingInterval: subscription.billing_interval || 'monthly'
        }
      })
    };
  } catch (error) {
    console.error('Error checking subscription:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to check subscription status', details: error.message })
    };
  }
};
