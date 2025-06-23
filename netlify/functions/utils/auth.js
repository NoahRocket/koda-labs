const path = require('path');
const envPath = path.resolve(__dirname, '../../../.env');
console.log(`[utils/auth] Loading .env from path: ${envPath}`);
require('dotenv').config({ path: envPath });
console.log(`[utils/auth] SUPABASE_JWT_SECRET is ${process.env.SUPABASE_JWT_SECRET ? 'loaded' : 'NOT LOADED'}`);
const jwt = require('jsonwebtoken');

const verifyJwt = (token) => {
  try {
    if (!token) {
      return { user: null, error: 'No token provided.' };
    }

    // The verify function checks for expiration automatically.
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);

    // Standardize the user object to be returned.
    const user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      ...decoded,
    };

    return { user, error: null };
  } catch (error) {
    console.error('JWT Verification Error:', error.message);
    // Return a more generic error message to the client
    return { user: null, error: 'Invalid or expired token.' };
  }
};

module.exports = { verifyJwt };
