const express = require('express');
const router = express.Router();
const { authRequired, optionalAuth, loadProfile, requireRole } = require('../middleware/auth');
const { getAdmin, getUserClient } = require('../supabase');

// ---------------------------------------------------------------------------
// OTP helpers: prefer server/lib/otp (same exports as lib/otp.ts);
// if missing, inline a minimal version (random 6-digit, in-memory expiry map).
// ---------------------------------------------------------------------------
function createInlineOtp() {
  const { createHash, randomInt } = require('node:crypto');

  const OTP_TTL_MS = 10 * 60 * 1000;
  const RESEND_COOLDOWN_MS = 60 * 1000;
  const MAX_ATTEMPTS = 5;

  // In-memory store — fine for a single self-hosted server.
  // Codes are hashed so they can't be read even if memory is inspected.
  const store = new Map();

  function hashCode(email, otp) {
    return createHash('sha256').update(`${email.toLowerCase()}::${otp}`).digest('hex');
  }

  function cleanup() {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt < now) store.delete(key);
    }
  }

  return {
    generateOtp(email) {
      cleanup();
      const key = email.toLowerCase();
      const existing = store.get(key);

      if (existing && existing.lastSentAt + RESEND_COOLDOWN_MS > Date.now()) {
        const retryInSec = Math.ceil((existing.lastSentAt + RESEND_COOLDOWN_MS - Date.now()) / 1000);
        return { ok: false, retryInSec };
      }

      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      store.set(key, {
        hash: hashCode(key, otp),
        expiresAt: Date.now() + OTP_TTL_MS,
        attempts: 0,
        lastSentAt: Date.now(),
      });
      return { ok: true, otp };
    },

    verifyOtp(email, otp) {
      cleanup();
      const key = email.toLowerCase();
      const entry = store.get(key);

      if (!entry) return { ok: false, error: 'No reset code requested. Please request a new one.' };
      if (entry.expiresAt < Date.now()) {
        store.delete(key);
        return { ok: false, error: 'Code expired. Please request a new one.' };
      }

      entry.attempts += 1;
      if (entry.attempts > MAX_ATTEMPTS) {
        store.delete(key);
        return { ok: false, error: 'Too many incorrect attempts. Please request a new code.' };
      }

      if (entry.hash !== hashCode(key, otp)) {
        return { ok: false, error: `Incorrect code. ${MAX_ATTEMPTS - entry.attempts} attempts remaining.` };
      }

      store.delete(key);
      return { ok: true };
    },
  };
}

let otpLib;
try {
  otpLib = require('../lib/otp');
} catch (_e) {
  otpLib = createInlineOtp();
}
const generateOtp = otpLib.generateOtp.bind(otpLib);
const verifyOtp = otpLib.verifyOtp.bind(otpLib);

// ---------------------------------------------------------------------------
// Mail helper: prefers server/lib/mail (same exports as lib/mail.ts);
// if missing, inlines a minimal SMTP version via nodemailer.
// ---------------------------------------------------------------------------
function createInlineMail() {
  const nodemailer = require('nodemailer');

  let transporter = null;

  function getTransporter() {
    if (!transporter) {
      const host = process.env.SMTP_HOST;
      const port = Number(process.env.SMTP_PORT || 587);
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;

      if (!host) throw new Error('SMTP_HOST is not configured');

      transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user && pass ? { user, pass } : undefined,
      });
    }
    return transporter;
  }

  function getFromAddress() {
    return process.env.SMTP_FROM || `SproutNet <${process.env.SMTP_USER || 'no-reply@sproutnet.in'}>`;
  }

  return {
    getTransporter,
    getFromAddress,
    async sendOtpEmail(to, otp) {
      const transport = getTransporter();
      await transport.sendMail({
        from: getFromAddress(),
        to,
        subject: `${otp} is your SproutNet password reset code`,
        text: `Your SproutNet password reset code is ${otp}. It expires in 10 minutes. If you did not request this, you can safely ignore this email.`,
        html: `
          <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF8F4;border-radius:12px;">
            <div style="text-align:center;margin-bottom:24px;">
              <span style="font-size:22px;font-weight:700;color:#1C1410;">Sprout<span style="color:#2D6A4F;">Net</span></span>
            </div>
            <div style="background:#ffffff;border:1px solid rgba(28,20,16,0.08);border-radius:10px;padding:28px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;color:#4A3F38;">Use this code to reset your password</p>
              <p style="margin:0 0 16px;font-size:34px;font-weight:700;letter-spacing:8px;color:#1C1410;">${otp}</p>
              <p style="margin:0;font-size:13px;color:#9CA3A0;">This code expires in 10 minutes.</p>
            </div>
            <p style="text-align:center;font-size:12px;color:#9CA3A0;margin-top:20px;">
              If you didn't request a password reset, you can safely ignore this email.
            </p>
          </div>
        `,
      });
    },
  };
}

let mailLib;
try {
  mailLib = require('../lib/mail');
} catch (_e) {
  mailLib = createInlineMail();
}
const sendOtpEmail = mailLib.sendOtpEmail.bind(mailLib);

// ---------------------------------------------------------------------------
// GET /api/auth/profile — fetch own profile
// ---------------------------------------------------------------------------
router.get('/api/auth/profile', authRequired, async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const admin = getAdmin();
  const { data: profile } = await admin
    .from('users')
    .select('*')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  return res.status(200).json({ profile });
});

// ---------------------------------------------------------------------------
// POST /api/auth/profile — create/update own profile
// ---------------------------------------------------------------------------
router.post('/api/auth/profile', authRequired, async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const updates = { id: user.id };

  if (body.name) updates.name = body.name;
  if (body.role) updates.role = body.role;
  if (body.dept) updates.dept = body.dept;
  if (body.year) updates.year = body.year;
  if (body.city) updates.city = body.city;
  if (body.org_type) updates.org_type = body.org_type;

  const admin = getAdmin();

  const { error } = await admin
    .from('users')
    .upsert(updates, { onConflict: 'id' });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/auth/signout — sign out, clear auth cookies, redirect home (302)
// ---------------------------------------------------------------------------
router.post('/api/auth/signout', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m) {
      const supabase = getUserClient(m[1]);
      await supabase.auth.signOut();
    }
  } catch (_e) {
    // Even if sign-out fails, clear auth cookies and send the user home.
  }

  // Best-effort cookie cleanup so no stale session remains.
  const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').match(/https?:\/\/([^.]+)/)?.[1];
  if (projectRef) {
    for (const name of [`sb-${projectRef}-auth-token`, `sb-${projectRef}-auth-token-code-verifier`]) {
      res.cookie(name, '', { maxAge: -1, path: '/' });
    }
  }

  return res.redirect(302, '/');
});

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password — request a password-reset OTP
// ---------------------------------------------------------------------------
router.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const result = generateOtp(email);

    if (!result.ok) {
      return res.status(429).json(
        { error: `Please wait ${result.retryInSec}s before requesting another code.` }
      );
    }

    // Don't reveal whether the account exists — always respond the same way.
    const admin = getAdmin();
    const { data } = await admin.from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
    if (!data) {
      return res.status(200).json({ success: true });
    }

    await sendOtpEmail(email.toLowerCase(), result.otp);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[forgot-password]', err);
    return res.status(500).json(
      { error: 'Failed to send reset code. Please check SMTP configuration or try again later.' }
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password — verify OTP and set a new password
// ---------------------------------------------------------------------------
router.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, otp, password } = req.body || {};

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and code are required.' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const result = verifyOtp(email, String(otp));
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    const admin = getAdmin();
    const { data: profile } = await admin
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (!profile) {
      return res.status(404).json({ error: 'No account found with this email.' });
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(profile.id, {
      password,
    });

    if (updateError) {
      console.error('[reset-password] update failed:', updateError);
      return res.status(500).json({ error: 'Could not update password. Please try again.' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[reset-password]', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
