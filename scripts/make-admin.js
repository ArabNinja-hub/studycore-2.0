// Promote an existing student account to ADMIN, or create a new admin account.
// Usage: npm run make-admin -- someone@example.com "Optional Full Name"
const bcrypt = require('bcryptjs');
const db = require('../db');

const email = (process.argv[2] || '').trim().toLowerCase();
const name = process.argv[3] || 'Admin';

if (!email) {
  console.log('Usage: npm run make-admin -- someone@example.com "Full Name"');
  process.exit(1);
}

const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

if (existing) {
  db.prepare(`UPDATE users SET role = 'ADMIN' WHERE id = ?`).run(existing.id);
  console.log(`"${email}" has been promoted to ADMIN.`);
} else {
  const password = Math.random().toString(36).slice(-10);
  const hashed = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, subscription, subscription_start, subscription_end, created_at)
    VALUES (?, ?, ?, ?, 'ADMIN', 'premium', ?, ?, ?)
  `).run(`admin-${Date.now()}`, name, email, hashed, now, new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString(), now);
  console.log(`Created new admin account: ${email}`);
  console.log(`Temporary password: ${password}`);
  console.log('Log in and change this password immediately.');
}
