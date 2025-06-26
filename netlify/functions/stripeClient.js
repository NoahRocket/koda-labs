// Check if STRIPE_SECRET_KEY is set
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY environment variable is not set!');
}

// Initialize Stripe with the secret key
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'missing_key');
const { getSupabaseAdmin } = require('./supabaseClient');

/**
 * Creates a Stripe customer for a user if they don't already have one
 * @param {string} userId - The user's ID in Supabase
 * @param {string} email - The user's email address
 * @returns {string} - The Stripe customer ID
 */
const getOrCreateStripeCustomer = async (userId, email) => {
  const supabase = getSupabaseAdmin();
  
  // Check if the user already has a Stripe customer ID
  const { data: subscriptionData, error: subscriptionError } = await supabase
    .from('user_subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .single();
  
  if (subscriptionError && subscriptionError.code !== 'PGRST116') {
    console.error('Error fetching user subscription:', subscriptionError);
    throw new Error('Failed to retrieve user subscription information');
  }
  
  // If the user already has a Stripe customer ID, return it
  if (subscriptionData?.stripe_customer_id) {
    return subscriptionData.stripe_customer_id;
  }
  
  // Otherwise, create a new Stripe customer
  try {
    // Check if Stripe is properly initialized
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'missing_key') {
      console.error('STRIPE_SECRET_KEY environment variable is not properly set');
      throw new Error('Stripe API key is missing or invalid');
    }
    
    const customer = await stripe.customers.create({
      email,
      metadata: {
        userId
      }
    });
    
    // First check if a subscription record exists for this user
    const { data: existingSubscription, error: checkError } = await supabase
      .from('user_subscriptions')
      .select('id')
      .eq('user_id', userId)
      .single();
      
    if (checkError && checkError.code !== 'PGRST116') {
      console.error('Error checking existing subscription:', checkError);
    }
    
    // If no subscription record exists, create one
    if (!existingSubscription) {
      try {
        // First try with RPC call if available (bypasses RLS)
        const { error: rpcError } = await supabase
          .rpc('create_user_subscription', {
            p_user_id: userId,
            p_stripe_customer_id: customer.id,
            p_subscription_tier: 'free',
            p_subscription_status: 'inactive'
          });
          
        if (rpcError) {
          console.warn('RPC method not available, falling back to direct insert:', rpcError);
          
          // Fall back to direct insert
          const { error: insertError } = await supabase
            .from('user_subscriptions')
            .insert({
              user_id: userId,
              stripe_customer_id: customer.id,
              subscription_tier: 'free',
              subscription_status: 'inactive'
            });
            
          if (insertError) {
            console.error('Error creating user subscription record:', insertError);
            
            // If we can't create a record, just return the customer ID anyway
            // We'll handle the subscription status separately
            console.log('Proceeding with Stripe customer creation despite database error');
            return customer.id;
          }
        }
      } catch (dbError) {
        console.error('Database error when creating subscription record:', dbError);
        // Continue with the customer ID even if we can't create the subscription record
        // This allows the checkout process to continue
        return customer.id;
      }
    } else {
      // Update the existing record
      const { error: updateError } = await supabase
        .from('user_subscriptions')
        .update({ stripe_customer_id: customer.id })
        .eq('user_id', userId);
      
      if (updateError) {
        console.error('Error updating user subscription with Stripe customer ID:', updateError);
        throw new Error('Failed to update user with Stripe customer ID');
      }
    }
    
    return customer.id;
  } catch (error) {
    console.error('Error creating Stripe customer:', error);
    if (error.type === 'StripeAuthenticationError') {
      throw new Error('Stripe authentication failed. Please check your API key.');
    } else if (error.type === 'StripeInvalidRequestError') {
      throw new Error('Invalid Stripe request. Please check your parameters.');
    } else {
      throw new Error(`Failed to create Stripe customer: ${error.message}`);
    }
  }
};

/**
 * Updates a user's subscription status in the database
 * @param {string} userId - The user's ID in Supabase
 * @param {object} subscriptionData - The subscription data to update
 */
const updateUserSubscription = async (userId, subscriptionData) => {
  const supabase = getSupabaseAdmin();
  
  const { error } = await supabase
    .from('user_subscriptions')
    .update(subscriptionData)
    .eq('user_id', userId);
  
  if (error) {
    console.error('Error updating user subscription:', error);
    throw new Error('Failed to update user subscription status');
  }
};

/**
 * Updates a user's subscription status in the database based on Stripe subscription ID
 * @param {string} stripeSubscriptionId - The Stripe subscription ID
 * @param {object} subscriptionData - The subscription data to update
 */
const updateSubscriptionByStripeId = async (stripeSubscriptionId, subscriptionData) => {
  const supabase = getSupabaseAdmin();
  
  const { error } = await supabase
    .from('user_subscriptions')
    .update(subscriptionData)
    .eq('stripe_subscription_id', stripeSubscriptionId);
  
  if (error) {
    console.error('Error updating subscription by Stripe ID:', error);
    throw new Error('Failed to update subscription status');
  }
};

/**
 * Gets the user ID from a Stripe subscription ID
 * @param {string} stripeSubscriptionId - The Stripe subscription ID
 * @returns {string} - The user ID in Supabase
 */
const getUserIdFromStripeSubscription = async (stripeSubscriptionId) => {
  const supabase = getSupabaseAdmin();
  
  const { data, error } = await supabase
    .from('user_subscriptions')
    .select('user_id')
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .single();
  
  if (error) {
    console.error('Error fetching user ID from Stripe subscription:', error);
    throw new Error('Failed to find user associated with subscription');
  }
  
  return data.user_id;
};

/**
 * Checks if a user has an active premium subscription
 * @param {string} userId - The user's ID in Supabase
 * @returns {boolean} - Whether the user has an active premium subscription
 */
const hasActivePremiumSubscription = async (userId) => {
  const supabase = getSupabaseAdmin();
  
  const { data, error } = await supabase
    .from('user_subscriptions')
    .select('subscription_status, subscription_tier, trial_end_date, current_period_end')
    .eq('user_id', userId)
    .single();
  
  if (error) {
    console.error('Error checking subscription status:', error);
    return false;
  }
  
  const now = new Date();
  
  // Check if the user has a premium tier set (regardless of other conditions)
  // This allows for manually set premium status in the database
  if (data.subscription_tier === 'premium') {
    // If no period end is set or it's in the future, consider it active
    if (!data.current_period_end || new Date(data.current_period_end) > now) {
      return true;
    }
  }
  
  // Check if the user is on a trial that hasn't expired
  if (data.subscription_tier === 'premium' && 
      data.trial_end_date && 
      new Date(data.trial_end_date) > now) {
    return true;
  }
  
  // Check if the user has an active subscription
  if (data.subscription_status === 'active' && 
      data.subscription_tier === 'premium' && 
      data.current_period_end && 
      new Date(data.current_period_end) > now) {
    return true;
  }
  
  return false;
};

module.exports = {
  stripe,
  getOrCreateStripeCustomer,
  updateUserSubscription,
  updateSubscriptionByStripeId,
  getUserIdFromStripeSubscription,
  hasActivePremiumSubscription
};
