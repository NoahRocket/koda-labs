// Utility function for tracking and enforcing usage limits
const { getSupabaseAdmin } = require('./supabaseClient');
const { hasActivePremiumSubscription } = require('./stripeClient');

/**
 * Track usage of a specific feature and check if the user has exceeded their limits
 * @param {string} userId - The user's ID in Supabase
 * @param {string} feature - The feature being used (e.g., 'chat_messages', 'podcasts', etc.)
 * @param {number} freeTierLimit - The maximum usage allowed for free tier users
 * @returns {object} - Object containing usage information and whether the limit has been exceeded
 */
async function trackUsageAndCheckLimits(userId, feature, freeTierLimit) {
  try {
    const supabase = getSupabaseAdmin();
    
    // Check if the user has an active premium subscription
    const hasPremium = await hasActivePremiumSubscription(userId);
    
    // If user has premium, they have unlimited usage
    if (hasPremium) {
      return {
        hasPremium: true,
        currentUsage: 0,
        remainingUsage: Infinity,
        limitExceeded: false
      };
    }
    
    // For free users, check usage limits
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
    
    // Check if user has an existing usage record for this feature today
    const { data: usageData, error: usageError } = await supabase
      .from('usage_limits')
      .select('id, usage_count')
      .eq('user_id', userId)
      .eq('feature', feature)
      .gte('reset_date', startOfDay)
      .lt('reset_date', endOfDay)
      .single();
    
    if (usageError && usageError.code !== 'PGRST116') {
      console.error('Error checking usage limits:', usageError);
      throw new Error('Failed to check usage limits');
    }
    
    // If no usage record exists for today, create one
    if (!usageData) {
      const { data: newUsageData, error: newUsageError } = await supabase
        .from('usage_limits')
        .insert({
          user_id: userId,
          feature,
          usage_count: 1,
          reset_date: startOfDay
        })
        .select()
        .single();
        
      if (newUsageError) {
        console.error('Error creating usage record:', newUsageError);
        throw new Error('Failed to create usage record');
      }
      
      return {
        hasPremium: false,
        currentUsage: 1,
        remainingUsage: freeTierLimit - 1,
        limitExceeded: false
      };
    }
    
    // Update the existing usage record
    const newUsageCount = usageData.usage_count + 1;
    const limitExceeded = newUsageCount > freeTierLimit;
    
    // Only increment the usage count if the limit hasn't been exceeded
    if (!limitExceeded) {
      const { error: updateError } = await supabase
        .from('usage_limits')
        .update({ usage_count: newUsageCount })
        .eq('id', usageData.id);
        
      if (updateError) {
        console.error('Error updating usage count:', updateError);
        throw new Error('Failed to update usage count');
      }
    }
    
    return {
      hasPremium: false,
      currentUsage: limitExceeded ? usageData.usage_count : newUsageCount,
      remainingUsage: Math.max(0, freeTierLimit - (limitExceeded ? usageData.usage_count : newUsageCount)),
      limitExceeded: limitExceeded
    };
  } catch (error) {
    console.error('Error in trackUsageAndCheckLimits:', error);
    // Default to allowing usage if there's an error checking limits
    return {
      hasPremium: false,
      currentUsage: 0,
      remainingUsage: freeTierLimit,
      limitExceeded: false,
      error: error.message
    };
  }
}

module.exports = {
  trackUsageAndCheckLimits
};
