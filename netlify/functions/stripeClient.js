const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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
    const customer = await stripe.customers.create({
      email,
      metadata: {
        userId
      }
    });
    
    // Update the user's subscription record with the new Stripe customer ID
    const { error: updateError } = await supabase
      .from('user_subscriptions')
      .update({ stripe_customer_id: customer.id })
      .eq('user_id', userId);
    
    if (updateError) {
      console.error('Error updating user subscription with Stripe customer ID:', updateError);
      throw new Error('Failed to update user with Stripe customer ID');
    }
    
    return customer.id;
  } catch (error) {
    console.error('Error creating Stripe customer:', error);
    throw new Error('Failed to create Stripe customer');
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
