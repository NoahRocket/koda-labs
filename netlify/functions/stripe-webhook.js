const { stripe, updateSubscriptionByStripeId, getUserIdFromStripeSubscription } = require('./stripeClient');
const { getSupabaseAdmin } = require('./supabaseClient');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const stripeSignature = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!stripeSignature || !webhookSecret) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing Stripe signature or webhook secret' })
    };
  }

  let stripeEvent;

  try {
    // Verify the event came from Stripe
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      stripeSignature,
      webhookSecret
    );
  } catch (error) {
    console.error('Webhook signature verification failed:', error.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid signature' })
    };
  }

  // Handle the event
  try {
    const supabase = getSupabaseAdmin();
    
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        
        // Only handle subscription checkouts
        if (session.mode === 'subscription') {
          const subscriptionId = session.subscription;
          const userId = session.metadata.userId;
          
          // Get the subscription details
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          
          // Determine the billing interval (monthly or yearly)
          const billingInterval = session.metadata.billingInterval || 'monthly';
          
          // Update the user's subscription record
          await updateSubscriptionByStripeId(subscriptionId, {
            stripe_subscription_id: subscriptionId,
            subscription_status: subscription.status,
            subscription_tier: 'premium',
            billing_interval: billingInterval,
            trial_start_date: subscription.trial_start ? new Date(subscription.trial_start * 1000).toISOString() : null,
            trial_end_date: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: subscription.cancel_at_period_end,
            updated_at: new Date().toISOString()
          });
        }
        break;
      }
      
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object;
        
        // Try to find the user associated with this subscription
        let userId;
        try {
          userId = await getUserIdFromStripeSubscription(subscription.id);
        } catch (error) {
          // If we can't find a user, the subscription might be new
          // In this case, we rely on checkout.session.completed to handle it
          console.log('No user found for subscription:', subscription.id);
          break;
        }
        
        // Determine billing interval by checking the subscription period duration
        // If it's longer than a month, it's probably yearly
        const periodSeconds = subscription.current_period_end - subscription.current_period_start;
        const isYearly = periodSeconds > 31 * 24 * 60 * 60; // More than 31 days
        const billingInterval = isYearly ? 'yearly' : 'monthly';
        
        // Update the user's subscription record
        await updateSubscriptionByStripeId(subscription.id, {
          subscription_status: subscription.status,
          subscription_tier: 'premium',
          billing_interval: billingInterval,
          trial_start_date: subscription.trial_start ? new Date(subscription.trial_start * 1000).toISOString() : null,
          trial_end_date: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          cancel_at_period_end: subscription.cancel_at_period_end,
          updated_at: new Date().toISOString()
        });
        break;
      }
      
      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object;
        
        // Update the user's subscription record
        await updateSubscriptionByStripeId(subscription.id, {
          subscription_status: 'canceled',
          subscription_tier: 'free',
          updated_at: new Date().toISOString()
        });
        break;
      }
      
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        
        if (invoice.subscription) {
          // Get the subscription details
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          
          // Update the user's subscription record
          await updateSubscriptionByStripeId(invoice.subscription, {
            subscription_status: subscription.status,
            updated_at: new Date().toISOString()
          });
        }
        break;
      }
      
      default:
        // Ignore other event types
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };
  } catch (error) {
    console.error('Error handling webhook event:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to process webhook' })
    };
  }
};
