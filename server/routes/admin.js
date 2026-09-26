const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');
const { getAdmin } = require('../supabase');

// ---------------------------------------------------------------------------
// POST /api/admin/seed — promote the calling user to admin (seed helper)
// ---------------------------------------------------------------------------
router.post('/api/admin/seed', authRequired, async (req, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const admin = getAdmin();
  const { error } = await admin
    .from('users')
    .update({ role: 'admin' })
    .eq('id', user.id);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ ok: true, message: `User ${user.email ?? user.id} promoted to admin` });
});

module.exports = router;
