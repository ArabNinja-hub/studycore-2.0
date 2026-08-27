// Transactional email for StudyCore.
//
// Currently used for one thing: telling a student their mobile-money payment
// was approved and their Premium access is active (see the approve endpoint
// in routes/admin.routes.js).
//
// Sending works over plain SMTP with nodemailer, so it works with any
// provider - Gmail app password, Brevo, Mailgun, SendGrid, Resend's SMTP
// relay, or a self-hosted relay. Everything is configured through .env:
//
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
//   EMAIL_FROM            - e.g. "StudyCore <no-reply@studycore.com>"
//   APP_URL               - public base URL used for buttons in emails
//
// When SMTP is not configured (local development, tests, first boot), emails
// are NOT sent - the rendered email is logged to the server console instead,
// so approving a payment never fails just because mail isn't set up. This
// mirrors the storage.js fallback (R2 when configured, local disk when not).

const nodemailer = require('nodemailer');

function looksConfigured(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return !/^your-|^changeme|^replace-this|^xxx+$/i.test(v);
}

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

function isMailConfigured() {
  return SMTP_KEYS.every((key) => looksConfigured(process.env[key]));
}

function fromAddress() {
  const raw = looksConfigured(process.env.EMAIL_FROM)
    ? process.env.EMAIL_FROM
    : 'StudyCore <no-reply@studycore.com>';
  // Allow either a plain address or a "Name <address>" pair.
  return raw.includes('<') ? raw : `StudyCore <${raw}>`;
}

function appUrl() {
  return (looksConfigured(process.env.APP_URL) ? process.env.APP_URL : 'https://studycore.vercel.app').replace(/\/+$/, '');
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // Port 465 is implicit TLS; every other port starts plain/STARTTLS.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Approving a payment should never hang for a minute because a mail
      // server is slow - fail fast, the admin still sees a clear message.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000
    });
  }
  return transporter;
}

// ---------------------------------------------------------------------------
// Access-granted email (payment approved)
// ---------------------------------------------------------------------------

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'there';
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'your account page';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function paymentMethodLabel(method) {
  const m = String(method || '').toLowerCase();
  if (m.includes('mtn')) return 'MTN MoMo';
  if (m.includes('airtel')) return 'Airtel Money';
  return 'mobile money';
}

// Plain-text alternative for clients that don't render HTML.
function renderAccessGrantedText({ name, subscriptionEnd, method, amount }) {
  return [
    `Hi ${firstName(name)},`,
    '',
    `Good news - your ${paymentMethodLabel(method)} payment of K${amount || 50} was confirmed, and your StudyCore Premium access is now active until ${formatDate(subscriptionEnd)}.`,
    '',
    'Premium unlocks:',
    '  - Every video lesson, in the in-app player',
    '  - All study notes, tutorial sheets and past papers',
    '  - New resources as soon as they are uploaded',
    '',
    `Start learning: ${appUrl()}/pages/videos.html`,
    '',
    'Welcome to Premium!',
    'The StudyCore Team'
  ].join('\n');
}

// Inline-styled HTML (email clients don't load <style> blocks reliably).
// Colours follow the site palette: navy #0b2033 / #12314e, teal #0f8c7f.
function renderAccessGrantedHtml({ name, subscriptionEnd, method, amount }) {
  const who = escapeHtml(firstName(name));
  const until = escapeHtml(formatDate(subscriptionEnd));
  const paidWith = escapeHtml(paymentMethodLabel(method));
  const price = escapeHtml(String(amount || 50));
  const link = `${appUrl()}/pages/videos.html`;

  const row = (icon, text) => `
      <tr>
        <td style="padding:6px 0 6px 0;font-size:15px;line-height:1.5;color:#12314e;">
          <span style="margin-right:10px;">${icon}</span>${text}
        </td>
      </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#f2f5f8;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">Your StudyCore Premium access is active until ${until}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f8;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#12314e 0%,#0e7568 100%);background-color:#12314e;padding:28px 32px;text-align:center;">
              <div style="font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:0.5px;">StudyCore</div>
              <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px;">Learn. Master. Excel.</div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 32px 8px 32px;">
              <div style="font-size:20px;font-weight:bold;color:#0b2033;margin-bottom:14px;">Access granted &mdash; you&apos;re Premium! &#127881;</div>
              <p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#2b3a49;">
                Hi ${who}, your ${paidWith} payment of <strong>K${price}</strong> has been confirmed.
                Your <strong style="color:#0e7568;">StudyCore Premium</strong> access is now active until
                <strong>${until}</strong>.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 6px 0;">
                ${row('&#127909;', 'Every video lesson, streamed in the StudyCore player')}
                ${row('&#128218;', 'All study notes, tutorial sheets and past papers')}
                ${row('&#9889;', 'New resources the moment they are uploaded')}
              </table>
            </td>
          </tr>
          <!-- CTA -->
          <tr>
            <td align="center" style="padding:18px 32px 30px 32px;">
              <a href="${link}" style="display:inline-block;background:#0e7568;color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold;padding:14px 34px;border-radius:10px;">Start watching</a>
              <p style="margin:18px 0 0 0;font-size:13px;line-height:1.5;color:#6b7a89;">
                Just sign in with your StudyCore account. If the button doesn&apos;t work, open
                <a href="${link}" style="color:#0e7568;">${link}</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8fafb;padding:18px 32px;border-top:1px solid #e6ecf1;font-size:12px;line-height:1.6;color:#8b98a5;text-align:center;">
              This is an automated message from StudyCore confirming an approved subscription payment.
              You receive it because a Premium payment on your account was approved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Sends the "access granted" email after a payment is approved.
 *
 * Returns { sent, simulated?, error? } - it never throws, so a mail problem
 * can never block or fail a payment approval.
 */
async function sendAccessGrantedEmail({ to, name, subscriptionEnd, method, amount }) {
  const recipient = String(to || '').trim();
  if (!recipient) return { sent: false, error: 'No recipient address' };

  const template = { name, subscriptionEnd, method, amount };
  const subject = 'Access granted - your StudyCore Premium is active';
  const html = renderAccessGrantedHtml(template);
  const text = renderAccessGrantedText(template);

  if (!isMailConfigured()) {
    // Dev/test fallback: show the email on the console instead of failing.
    console.log(
      `\n[mailer] SMTP not configured - access-granted email NOT sent.\n` +
      `[mailer] To: ${recipient}\n[mailer] Subject: ${subject}\n[mailer] Body:\n${text}\n`
    );
    return { sent: false, simulated: true, reason: 'smtp-not-configured' };
  }

  try {
    await getTransporter().sendMail({
      from: fromAddress(),
      to: recipient,
      subject,
      text,
      html
    });
    console.log(`[mailer] Access-granted email sent to ${recipient}`);
    return { sent: true };
  } catch (err) {
    console.error(`[mailer] Failed to send access-granted email to ${recipient}:`, err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  isMailConfigured,
  sendAccessGrantedEmail,
  renderAccessGrantedHtml,
  renderAccessGrantedText,
  paymentMethodLabel
};
