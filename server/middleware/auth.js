const { getUserFromToken, getAdmin } = require('../supabase');

function getToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function authRequired(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { user, supabase } = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    req.supabase = supabase;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

async function optionalAuth(req, res, next) {
  const token = getToken(req);
  req.user = null;
  req.supabase = null;
  if (token) {
    try {
      const { user, supabase } = await getUserFromToken(token);
      req.user = user;
      req.supabase = supabase;
    } catch (e) { /* anonymous */ }
  }
  next();
}

// Loads req.profile = { role, is_master } from the users table.
async function loadProfile(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const admin = getAdmin();
  const { data: profile } = await admin
    .from('users')
    .select('role, is_master')
    .eq('id', req.user.id)
    .single();
  req.profile = profile || null;
  next();
}

// requireRole('poster', 'admin') — use after authRequired + loadProfile.
// is_master counts as admin.
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.profile?.is_master && roles.includes('admin')) return next();
    if (!req.profile || !roles.includes(req.profile.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { getToken, authRequired, optionalAuth, loadProfile, requireRole };
