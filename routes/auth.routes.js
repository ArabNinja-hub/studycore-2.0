const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { createToken, setAuthCookie, clearAuthCookie, requireAuth, attachUser } = require('../middleware/auth');
const { avatarUpload } = require('../middleware/upload');
const storage = require('../lib/storage');

const router = express.Router();

function publicUser(user) {
  if (!user) return null;
  const { password, avatar_key, ...safe } = user;
  // Only expose that a picture exists - never the storage key itself.
  return { ...safe, hasAvatar: Boolean(avatar_key) };
}

// Single source of truth for "what plan is this student on right now".
// Everything is computed from the server clock + the users table on each
// call, so clients can neither reset nor fake any of these states.
function subscriptionStatus(user) {
  const now = Date.now();
  const trialEnd = new Date(user.trial_end || 0).getTime();
  const subEnd = new Date(user.subscription_end || 0).getTime();
  const active = user.role === 'ADMIN' || (user.subscription === 'premium' && now < subEnd);
  const inTrial = user.role !== 'ADMIN' && !active && now < trialEnd;
  const paymentPending = Boolean(
    db.prepare(`SELECT 1 x FROM payments WHERE user_id = ? AND status = 'PENDING'`).get(user.id)
  );

  let state;
  if (user.role === 'ADMIN') state = 'premium_active';
  else if (active) state = 'premium_active';
  else if (user.subscription === 'premium') state = paymentPending ? 'payment_pending' : 'premium_expired';
  else if (inTrial) state = 'trial_active';
  else state = 'trial_expired';

  return {
    active,
    inTrial,
    paymentPending,
    state,
    trialEnd: user.trial_end,
    subscriptionEnd: user.subscription_end,
    trialDaysLeft: inTrial ? Math.max(0, Math.ceil((trialEnd - now) / 86400000)) : 0,
    subscriptionDaysLeft: active && user.role !== 'ADMIN' ? Math.max(0, Math.ceil((subEnd - now) / 86400000)) : 0
  };
}

router.post('/register', async (req, res) => {
  const { name, email, password, school, grade, learningLevel, ref } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: 'Full name is required.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'A valid email is required.' });
  if (!password || password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });

  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ message: 'An account with this email already exists.' });

  // A friend's invite link rewards ONLY the person who shared the code (the
  // referrer): when someone signs up through their link, +7 days are added to
  // the referrer's own access as a thank-you. The newly referred student gets
  // the standard 30-day trial - no bonus on their side. The code is looked up
  // case-insensitively since students will often retype it by hand off a
  // WhatsApp message.
  //
  // The referrer's reward is strictly one-time: only their very first
  // successful referral earns them the bonus, ever. Every friend they bring
  // in after that still counts toward the referrer's visible "friends joined"
  // total - the referrer just doesn't earn any further free days beyond that
  // first one.
  const REFERRAL_BONUS_DAYS = 7;
  const REFERRAL_REWARD_CAP = 1;
  let referrer = null;
  if (ref && typeof ref === 'string' && ref.trim()) {
    referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(ref.trim().toUpperCase());
  }

  const hashed = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  // The referred student gets the standard trial length - the 7-day bonus
  // goes only to the friend who shared the invite code, never the new signup.
  const trialDays = 30;
  const trialEnd = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
  const user = {
    id: `user-${uuidv4()}`,
    name: name.trim(),
    email: normalizedEmail,
    password: hashed,
    role: 'STUDENT', // role can never be set by the client - always STUDENT on public signup
    school: school || null,
    grade: grade || null,
    learning_level: learningLevel === 'tertiary' ? 'tertiary' : 'secondary',
    subscription: 'trial',
    trial_end: trialEnd,
    subscription_start: null,
    subscription_end: null,
    referral_code: db.generateReferralCode(),
    referred_by: referrer ? referrer.id : null,
    created_at: now
  };

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, school, grade, learning_level, subscription, trial_end, subscription_start, subscription_end, referral_code, referred_by, created_at)
    VALUES (@id, @name, @email, @password, @role, @school, @grade, @learning_level, @subscription, @trial_end, @subscription_start, @subscription_end, @referral_code, @referred_by, @created_at)
  `).run(user);

  if (referrer) {
    // Count how many successful referrals this person already had BEFORE
    // this new signup (the new user's own row, inserted just above, is
    // deliberately not counted here since we're checking prior history).
    const priorReferralCount = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ? AND id != ?').get(referrer.id, user.id).c;

    if (priorReferralCount < REFERRAL_REWARD_CAP) {
      const bonusMs = REFERRAL_BONUS_DAYS * 24 * 60 * 60 * 1000;
      if (referrer.subscription === 'premium' && referrer.subscription_end) {
        const newEnd = new Date(new Date(referrer.subscription_end).getTime() + bonusMs).toISOString();
        db.prepare('UPDATE users SET subscription_end = ? WHERE id = ?').run(newEnd, referrer.id);
      } else {
        const base = referrer.trial_end && new Date(referrer.trial_end).getTime() > Date.now()
          ? new Date(referrer.trial_end).getTime()
          : Date.now();
        const newTrialEnd = new Date(base + bonusMs).toISOString();
        db.prepare('UPDATE users SET trial_end = ? WHERE id = ?').run(newTrialEnd, referrer.id);
      }
    }
    // Past the cap: the referred_by relationship is still recorded (so the
    // referrer's dashboard count of "friends joined" keeps growing, which
    // is honest and still rewarding to see), it just stops adding more free
    // days once the cap is reached.
  }

  const token = createToken(user);
  setAuthCookie(res, token);
  res.status(201).json({ token, user: { ...publicUser(user), subscriptionStatus: subscriptionStatus(user) } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return res.status(401).json({ message: 'Invalid email or password.' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ message: 'Invalid email or password.' });

  const token = createToken(user);
  setAuthCookie(res, token);
  res.json({ token, user: { ...publicUser(user), subscriptionStatus: subscriptionStatus(user) } });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Logged out.' });
});

// Returns the current user when logged in, or `{ user: null }` for anonymous
// visitors. Previously this used requireAuth and returned 401 for guests,
// which fired a noisy "Failed to load resource: 401" console error (and a
// wasted round-trip) on every public page load when the nav queried the
// session. The anonymous response is the same shape the client already
// handled (null user), so nothing else changes.
router.get('/me', attachUser, (req, res) => {
  if (!req.user) return res.json({ user: null });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  res.json({ user: { ...publicUser(user), subscriptionStatus: subscriptionStatus(user) } });
});

router.get('/referral', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (!user.referral_code) {
    // Covers the rare case of an account that predates this feature and
    // somehow missed the startup backfill - assign one on the spot.
    const code = db.generateReferralCode();
    db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code, user.id);
    user.referral_code = code;
  }
  const REFERRAL_BONUS_DAYS = 7;
  const REFERRAL_REWARD_CAP = 1;
  const referredCount = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(user.id).c;
  res.json({
    code: user.referral_code,
    referredCount,
    bonusDaysPerReferral: REFERRAL_BONUS_DAYS,
    rewardCap: REFERRAL_REWARD_CAP,
    rewardedReferrals: Math.min(referredCount, REFERRAL_REWARD_CAP),
    capReached: referredCount >= REFERRAL_REWARD_CAP
  });
});

router.put('/profile', requireAuth, (req, res) => {
  const { name, school, grade, learningLevel } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (!name || !name.trim()) return res.status(400).json({ message: 'Name cannot be empty.' });

  db.prepare(`
    UPDATE users SET name = ?, school = ?, grade = ?, learning_level = ? WHERE id = ?
  `).run(name.trim(), school || null, grade || null, learningLevel === 'tertiary' ? 'tertiary' : 'secondary', user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: { ...publicUser(updated), subscriptionStatus: subscriptionStatus(updated) } });
});

router.put('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  const valid = await bcrypt.compare(currentPassword || '', user.password);
  if (!valid) return res.status(401).json({ message: 'Current password is incorrect.' });
  const hashed = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, user.id);
  res.json({ message: 'Password updated.' });
});

router.post('/subscribe', requireAuth, (req, res) => {
  const { phone, method, reference } = req.body;
  if (!phone || !method) return res.status(400).json({ message: 'Phone number and payment method are required.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });

  const paymentId = `payment-${uuidv4()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO payments (id, user_id, method, phone, amount, status, reference, created_at)
    VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
  `).run(paymentId, user.id, method, phone, 50, reference || null, now);

  // Real mobile-money charging needs a merchant account with MTN/Airtel and
  // is out of scope here - instead this creates a PENDING record that shows
  // up on the admin dashboard. The admin manually confirms the payment was
  // actually received (by checking their own mobile money app/SMS) and
  // approves it from there, which is what activates the subscription.
  res.status(201).json({
    message: 'Your payment request has been submitted. It will be activated once the admin confirms your payment was received - this is usually quick, but is not automatic.',
    paymentId
  });
});

router.get('/config', requireAuth, (req, res) => {
  res.json({
    maxUploadMB: Number(process.env.MAX_UPLOAD_MB || 2000)
  });
});

// ---------------------------------------------------------------------------
// Profile pictures
//
// Uploads stream to R2 under avatars/<userId> (the strict avatarUpload
// config in middleware/upload.js limits the file to real image extensions and
// 4MB). The extension check alone is NOT trusted - after the stream lands we
// fetch the first 16 bytes back from storage and verify the image signature
// (PNG/JPEG/WebP magic bytes). A mismatch means the object is deleted and
// the request fails, so the avatar pipeline cannot be used to store
// disguised files in the bucket.
// ---------------------------------------------------------------------------

const IMAGE_SIGNATURES = [
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 },
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff], offset: 0 },
  // WebP: "RIFF" at 0 and "WEBP" at 8
  { name: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, bytes2: [0x57, 0x45, 0x42, 0x50], offset2: 8 }
];

function verifyImageSignature(head) {
  for (const sig of IMAGE_SIGNATURES) {
    const ok1 = sig.bytes.every((b, i) => head[i + sig.offset] === b);
    if (!ok1) continue;
    if (sig.bytes2 && !sig.bytes2.every((b, i) => head[i + sig.offset2] === b)) continue;
    return true;
  }
  return false;
}

router.post('/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (!req.file) return res.status(400).json({ message: 'Please choose an image file to upload.' });

  try {
    // Pull the first 16 bytes back from storage and check the real signature.
    const head = await storage.readBytes(req.file.key, 0, 15);
    if (!verifyImageSignature(head)) {
      storage.deleteObject(req.file.key).catch(() => {});
      return res.status(400).json({ message: 'That file is not a valid image. Upload a PNG, JPEG or WebP picture.' });
    }
  } catch (err) {
    storage.deleteObject(req.file.key).catch(() => {});
    return res.status(502).json({ message: 'Could not verify the uploaded image. Please try again.' });
  }

  // Replace any previous picture (fire-and-forget delete of the old object).
  if (user.avatar_key && user.avatar_key !== req.file.key) {
    storage.deleteObject(user.avatar_key).catch(() => {});
  }

  db.prepare('UPDATE users SET avatar_key = ? WHERE id = ?').run(req.file.key, user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.status(201).json({ user: { ...publicUser(updated), subscriptionStatus: subscriptionStatus(updated) } });
});

router.delete('/avatar', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (user.avatar_key) {
    storage.deleteObject(user.avatar_key).catch(() => {});
  }
  db.prepare('UPDATE users SET avatar_key = NULL WHERE id = ?').run(user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: { ...publicUser(updated), subscriptionStatus: subscriptionStatus(updated) } });
});

// Serves the student's own picture for display (nav, dashboard, profile).
// Authenticated and scoped to the caller's own row - there is no route that
// accepts another user's id.
router.get('/avatar', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.avatar_key) return res.status(404).json({ message: 'No profile picture set.' });
  try {
    const object = await storage.getObject(user.avatar_key);
    res.setHeader('Content-Type', object.contentType || 'image/png');
    res.setHeader('Content-Disposition', 'inline; filename="avatar"');
    res.setHeader('Cache-Control', 'private, no-cache');
    const body = object.body;
    if (body && typeof body.pipe === 'function') {
      body.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
      body.pipe(res);
      return;
    }
    const { Readable } = require('stream');
    if (typeof Readable.fromWeb === 'function' && body && typeof body.getReader === 'function') {
      const nodeStream = Readable.fromWeb(body);
      nodeStream.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
      nodeStream.pipe(res);
      return;
    }
    return res.status(500).json({ message: 'Profile picture is temporarily unavailable.' });
  } catch {
    res.status(404).json({ message: 'Profile picture is temporarily unavailable.' });
  }
});

router.get('/payment-info', requireAuth, (req, res) => {
  res.json({
    payTo: {
      numbers: [
        {
          method: 'MTN MoMo',
          phone: process.env.PAYMENT_PHONE_MTN || 'Not configured yet - ask the admin to set PAYMENT_PHONE_MTN',
          name: process.env.PAYMENT_NAME_MTN || 'StudyCore'
        },
        {
          method: 'Airtel Money',
          phone: process.env.PAYMENT_PHONE_AIRTEL || 'Not configured yet - ask the admin to set PAYMENT_PHONE_AIRTEL',
          name: process.env.PAYMENT_NAME_AIRTEL || 'StudyCore'
        }
      ]
    },
    amount: 50
  });
});

module.exports = router;
