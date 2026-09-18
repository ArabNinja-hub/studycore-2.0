'use strict';

// StudyCore email templates.
//
// Design notes (these matter for real inboxes, not just for looking nice in
// a browser):
//
//   * Table-based layout with inline styles only. Gmail strips <style>
//     blocks in several contexts and Outlook (Word rendering engine) ignores
//     most modern CSS, so nothing structural depends on a stylesheet.
//   * A single 600px-max content column that collapses to full width on
//     narrow screens via width="100%" + max-width, which behaves correctly
//     in iOS Mail, Gmail app and Outlook mobile.
//   * Buttons are rendered as padded anchors inside a table cell with a
//     background colour, plus an MSO VML fallback so Outlook shows a real
//     filled button instead of a bare link.
//   * Every message has a plain-text alternative (spam filters penalise
//     HTML-only mail, and some corporate clients show text only).
//   * Colours come from the live StudyCore palette in public/css/style.css:
//     navy #0b2033 / #12314e and teal #0e7568 / #0f8c7f.
//
// Brand voice, as specified by the product: the wordmark "StudyCore" and the
// tagline "Stay curious and winning".

const { siteLink, supportPhone, supportWhatsAppUrl } = require('./config');

const BRAND_NAME = 'StudyCore';
const BRAND_TAGLINE = 'Stay curious and winning';

const NAVY_900 = '#0b2033';
const NAVY_800 = '#12314e';
const TEAL_600 = '#0e7568';
const TEAL_500 = '#0f8c7f';
const INK = '#17293d';
const MUTED = '#5b7085';
const BORDER = '#e1e9f0';
const PAGE_BG = '#f4f7fa';
const AMBER_600 = '#d98a1f';

/** Escapes text before it is interpolated into HTML. */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * First name for a friendly greeting, falling back to a neutral word so a
 * message never reads "Hi ,". Trimmed to a sane length so a pathological
 * database value cannot blow out the layout.
 */
function firstName(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  return first ? first.slice(0, 40) : 'there';
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * A call-to-action button that survives Outlook. The VML block is wrapped in
 * MSO conditional comments, so every other client sees only the anchor.
 */
function button(label, href, color = TEAL_600) {
  const safeLabel = escapeHtml(label);
  const safeHref = escapeHtml(href);
  return `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
                <tr>
                  <td align="center" bgcolor="${color}" style="border-radius:10px;">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeHref}" style="height:46px;v-text-anchor:middle;width:260px;" arcsize="22%" stroke="f" fillcolor="${color}">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${safeLabel}</center>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-- -->
                    <a href="${safeHref}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;line-height:20px;padding:14px 32px;border-radius:10px;mso-hide:all;">${safeLabel}</a>
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>`;
}

/**
 * The shared shell: preheader, branded header, body slot, optional CTA,
 * tagline strip and footer. Every StudyCore email uses this so the brand is
 * consistent and only one layout has to be kept inbox-safe.
 */
// NOTE ON ESCAPING: `heading`, `bodyHtml` and `footerNote` are trusted HTML
// assembled by the template functions below, which escape every value that
// came from the database (student names in particular) before interpolating
// it. `preheader` and `title` are plain text and are escaped here. Escaping
// the heading a second time would turn an already-escaped name into visible
// "&amp;#39;" and an intentional "&mdash;" into literal text.
function layout({ preheader, title, heading, bodyHtml, ctaLabel, ctaHref, ctaColor, footerNote }) {
  const link = ctaHref || siteLink('/');
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${escapeHtml(title || preheader)}</title>
  <!--[if mso]>
  <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  <![endif]-->
</head>
<body style="margin:0;padding:0;width:100%;background-color:${PAGE_BG};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <!-- Preheader: the grey preview line next to the subject in most inboxes. -->
  <div style="display:none;font-size:1px;color:${PAGE_BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>
  <div style="display:none;font-size:1px;color:${PAGE_BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG};">
    <tr>
      <td align="center" style="padding:24px 12px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${BORDER};">

          <!-- Header / brand lockup -->
          <tr>
            <td align="center" bgcolor="${NAVY_800}" style="background-color:${NAVY_800};background-image:linear-gradient(135deg,${NAVY_900} 0%,${NAVY_800} 55%,${TEAL_600} 100%);padding:30px 28px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:bold;color:#ffffff;letter-spacing:0.4px;line-height:30px;">${BRAND_NAME}</div>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#a9e6dc;line-height:18px;padding-top:6px;letter-spacing:0.3px;">${BRAND_TAGLINE}</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 32px 8px 32px;font-family:Arial,Helvetica,sans-serif;">
              <h1 style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:28px;font-weight:bold;color:${NAVY_900};">${heading}</h1>
              ${bodyHtml}
            </td>
          </tr>

          ${ctaLabel ? `
          <!-- Call to action -->
          <tr>
            <td align="center" style="padding:14px 32px 8px 32px;">
              ${button(ctaLabel, link, ctaColor || TEAL_600)}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 26px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${MUTED};">
              If the button does not work, copy this link into your browser:<br />
              <a href="${escapeHtml(link)}" style="color:${TEAL_600};text-decoration:underline;word-break:break-all;">${escapeHtml(link)}</a>
            </td>
          </tr>` : '<tr><td style="padding:0 32px 26px 32px;"></td></tr>'}

          <!-- Tagline strip -->
          <tr>
            <td align="center" bgcolor="#eef9f7" style="background-color:#eef9f7;padding:16px 28px;border-top:1px solid ${BORDER};">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:${TEAL_600};line-height:20px;">${BRAND_TAGLINE}</div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" bgcolor="#f8fafb" style="background-color:#f8fafb;padding:20px 28px;border-top:1px solid ${BORDER};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#8b98a5;">
              ${footerNote ? `<div style="padding-bottom:8px;">${footerNote}</div>` : ''}
              <div><strong style="color:${MUTED};">${BRAND_NAME}</strong> &middot; <a href="${escapeHtml(siteLink('/'))}" style="color:${MUTED};text-decoration:underline;">studycore.academy</a></div>
              <div style="padding-top:6px;">This is an automated message &mdash; please do not reply to this address.</div>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Standard body paragraph. */
function p(html) {
  return `<p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:${INK};">${html}</p>`;
}

/** A bulleted feature row that renders identically in Outlook (no <ul>). */
function bullets(items) {
  const rows = items.map((item) => `
                <tr>
                  <td valign="top" style="padding:5px 10px 5px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:${TEAL_600};">&#8226;</td>
                  <td valign="top" style="padding:5px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:${INK};">${item}</td>
                </tr>`).join('');
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px 0;">${rows}
              </table>`;
}

/** Highlighted callout panel (used for the approved/rejected status blocks). */
function panel(html, accent = TEAL_600, background = '#eef9f7') {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px 0;">
                <tr>
                  <td bgcolor="${background}" style="background-color:${background};border-left:4px solid ${accent};border-radius:6px;padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:${INK};">${html}</td>
                </tr>
              </table>`;
}

// ---------------------------------------------------------------------------
// 1. Welcome email - sent once, after a successful student registration.
// ---------------------------------------------------------------------------

function welcome({ name }) {
  const who = escapeHtml(firstName(name));
  const link = siteLink('/dashboard.html');

  const subject = 'Welcome to StudyCore';
  const html = layout({
    preheader: 'Your StudyCore account is ready - your program, your courses, one focused space.',
    heading: `Welcome to StudyCore, ${who}!`,
    ctaLabel: 'Go to my dashboard',
    ctaHref: link,
    bodyHtml: [
      p('Your account has been created and you are all set to start learning.'),
      p('StudyCore is a program-based learning platform. You pick your program once, and StudyCore shows you only the courses and materials that actually belong to it &mdash; video lessons, study notes, tutorial sheets, past papers and quizzes, organised by course and term, in one place.'),
      bullets([
        'Video lessons streamed in the StudyCore player',
        'Study notes, tutorial sheets and past papers for your courses',
        'Quizzes and announcements targeted to your program',
        'Your progress tracked, so you can pick up where you left off'
      ]),
      p('Sign in any time with the email address you registered with.')
    ].join('\n'),
    footerNote: 'You are receiving this email because an account was created with this address on StudyCore.'
  });

  const text = [
    `Welcome to StudyCore, ${firstName(name)}!`,
    '',
    'Your account has been created and you are all set to start learning.',
    '',
    'StudyCore is a program-based learning platform. You pick your program once,',
    'and StudyCore shows you only the courses and materials that belong to it -',
    'video lessons, study notes, tutorial sheets, past papers and quizzes,',
    'organised by course and term, in one place.',
    '',
    '  - Video lessons streamed in the StudyCore player',
    '  - Study notes, tutorial sheets and past papers for your courses',
    '  - Quizzes and announcements targeted to your program',
    '  - Your progress tracked, so you can pick up where you left off',
    '',
    `Go to your dashboard: ${link}`,
    '',
    'Stay curious and winning',
    'The StudyCore Team',
    '',
    'This is an automated message - please do not reply to this address.'
  ].join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// 2. Subscription approved - sent after an admin approves the payment.
// ---------------------------------------------------------------------------

function subscriptionAccepted({ name, subscriptionEnd }) {
  const who = escapeHtml(firstName(name));
  const until = formatDate(subscriptionEnd);
  const link = siteLink('/dashboard.html');

  const subject = 'Your StudyCore subscription is approved';
  const html = layout({
    preheader: until
      ? `Approved - your StudyCore Premium access is active until ${until}.`
      : 'Approved - your StudyCore Premium access is now active.',
    heading: `Good news, ${who} &mdash; your subscription is approved`,
    ctaLabel: 'Start learning',
    ctaHref: link,
    bodyHtml: [
      p('An administrator has reviewed and <strong>approved</strong> your StudyCore subscription.'),
      panel(
        `<strong style="color:${TEAL_600};">Your subscription is active${until ? ` until ${escapeHtml(until)}` : ''}.</strong>`
      ),
      p('You can now access all the resources included with your subscription:'),
      bullets([
        'Every video lesson available for your program',
        'All study notes, tutorial sheets and past papers',
        'New resources as soon as they are published'
      ]),
      p('Just sign in with your StudyCore account and everything is unlocked.')
    ].join('\n'),
    footerNote: 'You are receiving this email because your subscription request on StudyCore was approved.'
  });

  const text = [
    `Good news, ${firstName(name)} - your subscription is approved.`,
    '',
    'An administrator has reviewed and APPROVED your StudyCore subscription.',
    until ? `Your subscription is active until ${until}.` : 'Your subscription is now active.',
    '',
    'You can now access all the resources included with your subscription:',
    '  - Every video lesson available for your program',
    '  - All study notes, tutorial sheets and past papers',
    '  - New resources as soon as they are published',
    '',
    `Start learning: ${link}`,
    '',
    'Stay curious and winning',
    'The StudyCore Team',
    '',
    'This is an automated message - please do not reply to this address.'
  ].join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// 3. Subscription rejected - sent after an admin rejects the payment.
// ---------------------------------------------------------------------------

function subscriptionRejected({ name }) {
  const who = escapeHtml(firstName(name));
  const phone = supportPhone();
  const waUrl = supportWhatsAppUrl();
  const link = siteLink('/dashboard.html#premium');

  const subject = 'Update on your StudyCore subscription request';
  const html = layout({
    preheader: 'Your StudyCore subscription request was not approved - here is what to do next.',
    heading: `Hi ${who}, an update on your subscription request`,
    ctaLabel: 'Review my subscription',
    ctaHref: link,
    ctaColor: NAVY_800,
    bodyHtml: [
      p('We reviewed your StudyCore subscription request.'),
      panel(
        '<strong>Your subscription request was not approved at this time,</strong> so your account has not been upgraded and your current access is unchanged.',
        AMBER_600,
        '#fdeed3'
      ),
      p('This usually happens when the payment could not be matched &mdash; for example when the reference is missing or incorrect, the amount does not match, or the transfer had not arrived when the request was reviewed.'),
      p(`If you believe this is a mistake, or you have already paid, please contact the StudyCore administrator on <a href="${escapeHtml(waUrl)}" style="color:${TEAL_600};text-decoration:underline;">${escapeHtml(phone)}</a> with your payment details and reference. We will check it and sort it out for you.`),
      p('You can also submit a new request from the Premium section of your dashboard at any time.')
    ].join('\n'),
    footerNote: 'You are receiving this email because a subscription request was submitted on your StudyCore account.'
  });

  const text = [
    `Hi ${firstName(name)}, an update on your subscription request.`,
    '',
    'We reviewed your StudyCore subscription request.',
    '',
    'Your subscription request was NOT approved at this time, so your account',
    'has not been upgraded and your current access is unchanged.',
    '',
    'This usually happens when the payment could not be matched - for example',
    'when the reference is missing or incorrect, the amount does not match, or',
    'the transfer had not arrived when the request was reviewed.',
    '',
    `If you believe this is a mistake, or you have already paid, contact the`,
    `StudyCore administrator on ${phone} (${waUrl}) with your payment details`,
    'and reference, and we will sort it out for you.',
    '',
    `You can also submit a new request from the Premium section: ${link}`,
    '',
    'Stay curious and winning',
    'The StudyCore Team',
    '',
    'This is an automated message - please do not reply to this address.'
  ].join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Prepared for future use - NOT wired to any StudyCore flow yet.
//
// These render correctly and are covered by tests, but nothing in the
// application calls them, because StudyCore currently has no login
// notification setting, no email verification step and no password-reset
// flow (password changes go through /api/auth/password, which requires the
// current password while already signed in). Wiring them up later is a
// matter of calling the matching function in lib/email/index.js - no
// template work is needed.
// ---------------------------------------------------------------------------

function loginNotification({ name, when, device }) {
  const who = escapeHtml(firstName(name));
  const at = escapeHtml(formatDate(when) || 'just now');
  const where = escapeHtml(device || 'a new device');
  const link = siteLink('/dashboard.html');

  const subject = 'New sign-in to your StudyCore account';
  const html = layout({
    preheader: 'A new sign-in to your StudyCore account was detected.',
    heading: `Hi ${who}, there was a new sign-in`,
    ctaLabel: 'Open StudyCore',
    ctaHref: link,
    bodyHtml: [
      p(`Your StudyCore account was signed in to from ${where} on ${at}.`),
      p('If this was you, no action is needed. If it was not, change your password from your dashboard profile straight away and contact the StudyCore administrator.')
    ].join('\n')
  });

  const text = [
    `Hi ${firstName(name)},`,
    '',
    `Your StudyCore account was signed in to from ${device || 'a new device'} on ${formatDate(when) || 'just now'}.`,
    'If this was you, no action is needed. If it was not, change your password',
    'straight away and contact the StudyCore administrator.',
    '',
    `Open StudyCore: ${link}`,
    '',
    'Stay curious and winning',
    'The StudyCore Team'
  ].join('\n');

  return { subject, html, text };
}

function emailVerification({ name, verifyUrl, expiresInHours = 24 }) {
  const who = escapeHtml(firstName(name));
  const link = verifyUrl || siteLink('/');

  const subject = 'Verify your StudyCore email address';
  const html = layout({
    preheader: 'Confirm your email address to finish setting up your StudyCore account.',
    heading: `Confirm your email, ${who}`,
    ctaLabel: 'Verify my email',
    ctaHref: link,
    bodyHtml: [
      p('Please confirm this email address so we know we can reach you about your StudyCore account.'),
      p(`This link expires in ${Number(expiresInHours) || 24} hours. If you did not create a StudyCore account, you can safely ignore this message.`)
    ].join('\n')
  });

  const text = [
    `Confirm your email, ${firstName(name)}.`,
    '',
    'Please confirm this email address so we know we can reach you about your',
    'StudyCore account.',
    '',
    `Verify: ${link}`,
    '',
    `This link expires in ${Number(expiresInHours) || 24} hours. If you did not create a`,
    'StudyCore account, you can safely ignore this message.',
    '',
    'Stay curious and winning',
    'The StudyCore Team'
  ].join('\n');

  return { subject, html, text };
}

function passwordReset({ name, resetUrl, expiresInMinutes = 60 }) {
  const who = escapeHtml(firstName(name));
  const link = resetUrl || siteLink('/login.html');

  const subject = 'Reset your StudyCore password';
  const html = layout({
    preheader: 'Use this link to choose a new StudyCore password.',
    heading: `Reset your password, ${who}`,
    ctaLabel: 'Choose a new password',
    ctaHref: link,
    bodyHtml: [
      p('We received a request to reset the password for your StudyCore account.'),
      p(`This link expires in ${Number(expiresInMinutes) || 60} minutes and can be used once. If you did not request a password reset, ignore this email &mdash; your password stays exactly as it is.`)
    ].join('\n')
  });

  const text = [
    `Reset your password, ${firstName(name)}.`,
    '',
    'We received a request to reset the password for your StudyCore account.',
    '',
    `Reset: ${link}`,
    '',
    `This link expires in ${Number(expiresInMinutes) || 60} minutes and can be used once.`,
    'If you did not request a password reset, ignore this email - your password',
    'stays exactly as it is.',
    '',
    'Stay curious and winning',
    'The StudyCore Team'
  ].join('\n');

  return { subject, html, text };
}

function subscriptionExpiring({ name, subscriptionEnd, daysLeft }) {
  const who = escapeHtml(firstName(name));
  const until = formatDate(subscriptionEnd);
  const days = Number(daysLeft) > 0 ? Number(daysLeft) : null;
  const link = siteLink('/dashboard.html#premium');

  const subject = 'Your StudyCore subscription is ending soon';
  const html = layout({
    preheader: until ? `Your StudyCore access ends on ${until}.` : 'Your StudyCore access is ending soon.',
    heading: `Hi ${who}, your subscription ends soon`,
    ctaLabel: 'Renew my subscription',
    ctaHref: link,
    bodyHtml: [
      p(days
        ? `Your StudyCore subscription ends in <strong>${days} day${days === 1 ? '' : 's'}</strong>${until ? ` &mdash; on ${escapeHtml(until)}` : ''}.`
        : `Your StudyCore subscription is ending soon${until ? ` &mdash; on ${escapeHtml(until)}` : ''}.`),
      p('Renew from the Premium section of your dashboard to keep your lessons, notes and past papers without interruption.')
    ].join('\n')
  });

  const text = [
    `Hi ${firstName(name)},`,
    '',
    days
      ? `Your StudyCore subscription ends in ${days} day${days === 1 ? '' : 's'}${until ? ` - on ${until}` : ''}.`
      : `Your StudyCore subscription is ending soon${until ? ` - on ${until}` : ''}.`,
    '',
    `Renew here: ${link}`,
    '',
    'Stay curious and winning',
    'The StudyCore Team'
  ].join('\n');

  return { subject, html, text };
}

function subscriptionExpired({ name, subscriptionEnd }) {
  const who = escapeHtml(firstName(name));
  const ended = formatDate(subscriptionEnd);
  const link = siteLink('/dashboard.html#premium');

  const subject = 'Your StudyCore subscription has ended';
  const html = layout({
    preheader: 'Renew to restore full access to your StudyCore resources.',
    heading: `Hi ${who}, your subscription has ended`,
    ctaLabel: 'Renew my subscription',
    ctaHref: link,
    bodyHtml: [
      p(`Your StudyCore subscription${ended ? ` ended on ${escapeHtml(ended)}` : ' has ended'}. Premium lessons and resources are locked until it is renewed.`),
      p('Your account, progress and bookmarks are all still here &mdash; renew any time and everything comes straight back.')
    ].join('\n')
  });

  const text = [
    `Hi ${firstName(name)},`,
    '',
    `Your StudyCore subscription${ended ? ` ended on ${ended}` : ' has ended'}. Premium lessons and`,
    'resources are locked until it is renewed.',
    '',
    'Your account, progress and bookmarks are all still here - renew any time',
    'and everything comes straight back.',
    '',
    `Renew here: ${link}`,
    '',
    'Stay curious and winning',
    'The StudyCore Team'
  ].join('\n');

  return { subject, html, text };
}

module.exports = {
  BRAND_NAME,
  BRAND_TAGLINE,
  escapeHtml,
  firstName,
  formatDate,
  layout,
  welcome,
  subscriptionAccepted,
  subscriptionRejected,
  loginNotification,
  emailVerification,
  passwordReset,
  subscriptionExpiring,
  subscriptionExpired
};
