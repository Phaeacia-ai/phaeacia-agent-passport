/* Composing and sending this site's email.

   Everything here is deliberately small. Until PH-507's hold disposition this
   composed one message (recipientMessage, below): it goes to one address, it
   is sent because a person clicked send, and the address is used for that and
   then forgotten, apart from a hash the limiter keeps until its day is over
   (netlify/functions/send.mjs).
   The hold disposition added two more, and a count of exactly
   how many is not repeated here because a number in a comment is a claim that
   goes stale the moment a fourth is added; grep `^export function` in this
   file for the real count. holdReleaseMessage goes to an address someone left
   on a held upload, sent once a reviewer releases it, and that address is
   then deleted (lib/_store.mjs's releaseHold does the deleting) -- used for
   exactly that one message. holdAlertMessage goes to an operator address
   (HOLD_ALERT_TO), not a stranger's, once per hold, and carries no passport
   text. None of these keep a list, use a template engine, or carry a tracking
   pixel or an open-rate. The privacy page says all of that in prose and this
   file is what has to keep it true.

   Four decisions that look like restrictions and are load bearing:

   1. Sending needs the delete token. Without it, /api/send is an open relay
      wearing our domain: anyone holding any passport link could mail anyone.
      With it, only the person who published the passport can send it, which is
      also the only flow the product actually has.

   2. NOTHING sender-controlled is in the subject line, and only one short
      sender-controlled string is in the body.

      An earlier version of this file claimed there was "no free-text message
      field" and believed that settled it. It did not. The title, the first
      sentence of the summary, and up to six capability labels all came out of a
      file the sender wrote, and together they were about a thousand characters
      of arbitrary prose in mail this domain had signed. A review demonstrated
      the obvious use of that, with a subject line reading "URGENT ACTION
      REQUIRED: your Microsoft 365 mailbox will be suspended in 24 hours" and a
      sender name of "Microsoft 365 Security Team", both of which passed every
      check this file had.

      Requiring the delete token stops an open relay. It does not stop that,
      because the attacker mints their own token with one upload. Without
      accounts there is nobody to hold responsible, so the only control left is
      to carry less of their text. So: the subject is fixed, the summary and the
      capability labels are gone, and what remains is the sender's name and the
      agent's title, both capped, both inside a block that says on its face that
      somebody else wrote them.

      This is a deliberate deviation from WEBSITE-SPEC §3, which asks for the
      sender's name in the subject and one sentence of what the agent does. The
      page the link opens says all of it, under our framing rather than theirs.

   3. Nothing is rendered from the passport body. Only the derived title, which
      was validated and is escaped again here. The body is Markdown a stranger
      wrote and it does not belong in an outbound message.

   4. Nothing from the provider's response is logged. Resend echoes the failing
      address in some 4xx bodies, and the privacy page promises the address is
      not stored: the limiter keeps a one-way hash of it and nothing else holds
      it. Failures log a status code. The one exception, since 2026-10-22, is
      the error NAME on a 429 or a 5xx (see sendMail): an identifier from a
      fixed list such as daily_quota_exceeded, filtered to [a-z_] before it is
      logged, never the message beside it. */

import { opsLog } from './_ops.mjs';

const API = 'https://api.resend.com/emails';

/* The From address has to be on a domain verified in Resend, so it is
   configuration rather than a constant. Everything degrades to "off" rather
   than to a broken send if it is missing.

   MAIL_API_BASE exists so the send endpoint can be exercised end to end against
   a local mock, which is the only way to test the wiring between the endpoint
   and this module without mailing somebody. It defaults to Resend and should
   never be set in production. It is not a secret and it is not a switch: an
   attacker who can set environment variables on the deployment already has the
   API key sitting next to it. */
export const mailConfig = (env = process.env) => ({
  key: env.RESEND_API_KEY || '',
  from: env.MAIL_FROM || 'Agent Passport <passport@phaeacia.ai>',
  replyTo: env.MAIL_REPLY_TO || '',
  api: env.MAIL_API_BASE || API
});

export const mailEnabled = (env = process.env) => Boolean(mailConfig(env).key);

/* Conservative on purpose. This refuses addresses that are technically legal,
   and that is the right trade for a field whose failure mode is mail nobody
   asked for: one address, no comma, no semicolon, no angle brackets, no
   whitespace, a dot in the domain. Somebody with an exotic address can copy the
   link, which is one click away and always works. */
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function validAddress(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s.length < 6 || s.length > 254) return null;
  if (/[\s,;<>"\\]/.test(s)) return null;
  if (!ADDRESS.test(s)) return null;
  return s;
}

/* Anything link-shaped. Mail clients linkify bare URLs and bare domains, so the
   test has to catch more than an anchor tag would: a scheme, a www, an address,
   or a bare host with a path after it. */
/* The bare-host branch used to be `[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}`,
   which requires the character immediately before the final dot to be ASCII
   alphanumeric. So `münchen-sicherheit.de` was caught and `sicherheitä.de` was
   not, and `paypal-sicherheıt.com` is the same shape with the non-ASCII
   character moved one position. If a mail client linkifies the first it will
   linkify the second. The label is now "anything that is not a space, a dot, an
   at-sign or a slash", which is what a client's own linkifier is closer to. */
const LABEL = '[^\\s.@/\\\\]';
const LINKISH = new RegExp(
  'https?://' +
  '|\\bwww\\.' +
  '|@' +
  '|\\bmailto:' +
  `|${LABEL}+\\.[a-z]{2,}\\b`,
  'i'
);

/* A display name, not a message. One line, no link-shaped text, no control
   characters, and short enough that it reads as a name in a subject line. */
export function cleanName(value) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (LINKISH.test(s)) return '';
  return s.slice(0, 60).trim();
}

/* A passport title, on its way into an email.

   The title was capped and escaped and put inside a block headed "In the
   sender's words", and a review walked straight through that framing with
   "Mailbox full. Restore now: https://evil.test/o365" inside the cap. Framing
   is not a control when the framed text is a working link in every mail client
   that renders it. cleanName had the right rule and it was applied to the wrong
   one of the two fields.

   A title that contains anything link-shaped does not travel. It is not
   stripped down to something misleading either: the message says the title was
   withheld and the page has it. */
/* Deliberately not "(title removed)". The recipient did not do anything wrong
   and neither, usually, did the sender: the rule errs towards withholding, so
   an honest title with a filename or a framework name in it lands here too.
   Over-withholding costs a recipient the agent's name for one screen.
   Under-withholding costs somebody a phishing click on our domain. */
export const TITLE_WITHHELD = 'An agent, named on the page';

export function cleanTitle(value) {
  const s = String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return TITLE_WITHHELD;
  if (LINKISH.test(s)) return TITLE_WITHHELD;
  return clip(s, 90);
}

const esc = s => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/* ADJACENT TO ROW-63 AND NOT AN INSTANCE OF IT. Nothing here was ever built
   from the request, so no message this file produced named a preview host.
   What it had was four more copies of the one address: this bare hostname, used
   in the "why you got this" line, and three hardcoded /privacy links.

   They are derived now because this is the file ROW-63 is about, and a constant
   that agrees today by coincidence is the next divergence. `CANON` is the same
   host without the scheme, which is what the prose wants: "somebody typed your
   address into a send box on app.phaeacia.ai" reads as an address and
   "https://app.phaeacia.ai" reads as a link nobody should click. */
import { CANONICAL } from './_site.mjs';

const CANON = CANONICAL.replace(/^https?:\/\//, '');

/* Hard cap on anything a stranger wrote, cut at a word boundary. */
export function clip(value, n) {
  const t = String(value || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const at = cut.lastIndexOf(' ');
  return (at > n * 0.6 ? cut.slice(0, at) : cut) + '…';
}

const PALETTE = {
  ink: '#12212A', mute: '#5C6B73', line: '#DED5C7',
  paper: '#F7F3EC', card: '#FFFFFF', accent: '#0F3A46'
};

/* Deliberately old-fashioned HTML. Tables, inline styles, no external assets,
   no web fonts, no media queries doing anything important. Mail clients are not
   browsers and this has to survive Outlook rendering it with Word. */
function shell(inner) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:${PALETTE.paper};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PALETTE.paper};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${PALETTE.card};border:1px solid ${PALETTE.line};border-radius:14px;">
${inner}
</table>
</td></tr></table></body></html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:${PALETTE.accent};border-radius:9px;">
<a href="${esc(href)}" style="display:inline-block;padding:13px 22px;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#FFFFFF;text-decoration:none;">${esc(label)}</a>
</td></tr></table>`;
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/* ── the message a recipient gets ───────────────────────────
   Written for somebody who has never heard of any of this and did not ask for
   it. It says who sent it, what the thing is, what happens if they open it, and
   what happens if they do nothing. It does not say "exciting". */
export function recipientMessage({ url, title, senderName, expiresAt }) {
  const who = senderName || 'Someone';
  const name = cleanTitle(title);

  /* Fixed. Not "${who} shared ${title}": a subject line is the highest-value
     line in a phishing message and none of it is the sender's to write. */
  const subject = 'Someone shared an agent with you · Phaeacia';

  const expiry = expiresAt
    ? `<p style="margin:0;font:400 12px/1.6 ${SANS};color:${PALETTE.mute};">This link stops working on ${esc(dateWords(expiresAt))}, unless whoever sent it renews it.</p>`
    : '';

  const html = shell(`
<tr><td style="padding:30px 30px 0;">
  <p style="margin:0 0 4px;font:600 12px/1 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${PALETTE.mute};">Phaeacia &middot; Agent Passport</p>
  <p style="margin:0 0 20px;font:400 15px/1.6 ${SANS};color:${PALETTE.ink};">Somebody used Phaeacia to share an agent with you. Everything in the box below was written by them, not by us.</p>
</td></tr>
<tr><td style="padding:0 30px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${PALETTE.line};border-radius:11px;">
    <tr><td style="padding:20px 20px 18px;">
      <p style="margin:0 0 10px;font:600 11px/1 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${PALETTE.mute};">In the sender's words</p>
      <p style="margin:0 0 4px;font:700 19px/1.3 ${SANS};color:${PALETTE.ink};">${esc(name)}</p>
      <p style="margin:0;font:400 14px/1.6 ${SANS};color:${PALETTE.mute};">Sent by ${esc(who)}</p>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 30px 0;">${button(url, 'Open the passport')}</td></tr>
<tr><td style="padding:22px 30px 0;">
  <p style="margin:0 0 6px;font:400 14px/1.6 ${SANS};color:${PALETTE.mute};">The page lists what the agent does and everything it will want access to, before anything is installed. Installing happens in your own assistant, on your own accounts. Nothing is installed by opening the link, and nothing on that page asks you for a password.</p>
</td></tr>
<tr><td style="padding:22px 30px 28px;border-top:1px solid ${PALETTE.line};">
  ${expiry}
  <p style="margin:8px 0 0;font:400 12px/1.6 ${SANS};color:${PALETTE.mute};">You were sent this because somebody typed your address into a send box on ${esc(CANON)}. Your address was used to send you this message, and named in the sender's own copy if they asked for one. It is not stored. A one-way hash of it counts that day's messages, so that nobody can flood one inbox through us; it stops counting at midnight UTC and a later cleanup deletes it. There is no list to leave. Phaeacia &middot; <a href="${CANONICAL}/privacy" style="color:${PALETTE.mute};">privacy</a></p>
</td></tr>`);

  const text = [
    'Somebody used Phaeacia to share an agent with you.',
    'The next two lines were written by them, not by us.',
    '',
    `  ${name}`,
    `  Sent by ${who}`,
    '',
    `Open the passport: ${url}`,
    '',
    'The page lists what the agent does and everything it will want access to,',
    'before anything is installed. Installing happens in your own assistant, on',
    'your own accounts. Nothing is installed by opening the link, and nothing on',
    'that page asks you for a password.',
    '',
    expiresAt ? `This link stops working on ${dateWords(expiresAt)}, unless whoever sent it renews it.` : '',
    '',
    `You were sent this because somebody typed your address into a send box on ${CANON}.`,
    'Your address was used to send you this message, and named in the sender\'s own',
    'copy if they asked for one. It is not stored. A one-way hash of it counts that',
    'day\'s messages, so that nobody can flood one inbox through us; it stops',
    'counting at midnight UTC and a later cleanup deletes it. There is no list to',
    'leave.',
    `Phaeacia · ${CANONICAL}/privacy`
  ].join('\n');

  return { subject, html, text };
}

/* ── the sender's own copy ──────────────────────────────────
   Opt-in, and until PH-507's hold disposition this was the only place the
   delete token was ever put in an email (holdReleaseMessage, above, is the
   second, and unlike this one it is not opt-in -- a held owner never sees
   a success screen with a box to tick, so the release mail is the only
   surface that could ever hand the token back to them at all). The success
   screen says so before the box is ticked, because a token that turns up
   in a mailbox the sender did not expect is a broken promise even when the
   mailbox is theirs. */
export function senderCopyMessage({ url, title, sentTo, manageUrl, deleteToken, expiresAt }) {
  const name = cleanTitle(title);

  /* Fixed, for the same reason the recipient's is. copy_to is an address the
     caller types and nothing checks it against the sender, so this message goes
     wherever they say. A review sent one to a chosen victim with the subject
     "Your copy: URGENT: your Microsoft 365 mailbox is suspended. Act now" —
     ninety characters of the caller's prose, from this domain, with none of the
     framing the recipient message carries. */
  const subject = 'Your copy of an Agent Passport send · Phaeacia';
  const html = shell(`
<tr><td style="padding:30px 30px 0;">
  <p style="margin:0 0 4px;font:600 12px/1 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${PALETTE.mute};">Phaeacia &middot; Agent Passport</p>
  <p style="margin:0 0 18px;font:400 15px/1.6 ${SANS};color:${PALETTE.ink};">You sent <strong>${esc(name)}</strong> to ${esc(sentTo)}.</p>
</td></tr>
<tr><td style="padding:0 30px 4px;">
  <p style="margin:0 0 6px;font:600 13px/1.4 ${SANS};color:${PALETTE.ink};">The link</p>
  <p style="margin:0 0 20px;font:400 13px/1.6 ${MONO};word-break:break-all;"><a href="${esc(url)}" style="color:${PALETTE.accent};">${esc(url)}</a></p>
  <p style="margin:0 0 6px;font:600 13px/1.4 ${SANS};color:${PALETTE.ink};">The delete token</p>
  <p style="margin:0 0 6px;font:400 13px/1.6 ${MONO};word-break:break-all;color:${PALETTE.ink};">${esc(deleteToken)}</p>
  <p style="margin:0 0 20px;font:400 13px/1.6 ${SANS};color:${PALETTE.mute};">This is the only copy of it that exists outside your screen, because you asked for one. It cannot be reissued. Anyone who reads this message can take the passport down.</p>
</td></tr>
<tr><td style="padding:0 30px 26px;">${button(manageUrl, 'Manage this passport')}</td></tr>
<tr><td style="padding:0 30px 28px;border-top:1px solid ${PALETTE.line};">
  ${expiresAt ? `<p style="margin:14px 0 6px;font:400 12px/1.6 ${SANS};color:${PALETTE.mute};">The passport comes down by itself on ${esc(dateWords(expiresAt))} unless you renew it.</p>` : ''}
  <p style="margin:${expiresAt ? '0' : '14px 0 0'};font:400 12px/1.6 ${SANS};color:${PALETTE.mute};">Phaeacia · <a href="${CANONICAL}/privacy" style="color:${PALETTE.mute};">privacy</a></p>
</td></tr>`);

  const text = [
    `You sent "${name}" to ${sentTo}.`,
    '',
    `The link: ${url}`,
    `The delete token: ${deleteToken}`,
    '',
    'This is the only copy of the token outside your screen, because you asked',
    'for one. It cannot be reissued. Anyone who reads this message can take the',
    'passport down.',
    '',
    `Manage this passport: ${manageUrl}`,
    expiresAt ? `` : '',
    expiresAt ? `The passport comes down by itself on ${dateWords(expiresAt)} unless you renew it.` : ''
  ].join('\n');

  return { subject, html, text };
}

/* PH-507. The second message this file sends, and the header comment above
   ("there is one message") is stale the moment this function exists -- said
   here rather than silently, since a claim in a comment that stops being
   true is exactly the failure this codebase keeps finding in itself.

   Sent by releaseHold (lib/_store.mjs) to the address someone left on a held
   upload, once a reviewer has released it. No sender-controlled text at all,
   unlike recipientMessage: this message is not relaying anything a stranger
   wrote, so none of that function's reasons for a locked-down subject and a
   boxed "in their words" section apply here. There is exactly one variable
   in the whole message: the published URL. */
/* `manageUrl` embeds the delete token the same way upload.mjs's own success
   response does (`${CANONICAL}/manage#${id}:${token}`). Not optional: a
   gate-code critic (critic-ph507-hold-r2) found that releaseHold minted a
   token from createPassport and then discarded it entirely, so a released
   hold used to become a passport nobody -- not the owner, not us -- could
   ever delete or renew, false against privacy.html's promise that the
   token is "shown to you once" and lets its owner remove it themselves.
   This message IS that one showing, for whoever left an address; the
   reviewer's own terminal (tools/review-holds.mjs) is the one showing for
   whoever did not. Second place this file puts a delete token in an email,
   after senderCopyMessage's own opt-in copy -- that function's header
   comment calling itself "the only place" is now stale and is fixed
   alongside this. */
export function holdReleaseMessage({ url, manageUrl }) {
  const subject = 'Your Agent Passport has been published · Phaeacia';

  const html = shell(`
<tr><td style="padding:30px 30px 0;">
  <p style="margin:0 0 4px;font:600 12px/1 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${PALETTE.mute};">Phaeacia &middot; Agent Passport</p>
  <p style="margin:0 0 20px;font:400 15px/1.6 ${SANS};color:${PALETTE.ink};">The passport you uploaded was held for review. It has now been published.</p>
</td></tr>
<tr><td style="padding:0 30px 0;">${button(url, 'Open your passport')}</td></tr>
<tr><td style="padding:22px 30px 0;">
  <p style="margin:0 0 6px;font:400 14px/1.6 ${SANS};color:${PALETTE.mute};">This link lets you delete it or renew it. It is shown to you once, here, and nowhere else -- nobody, ourselves included, can send it to you again.</p>
  <p style="margin:0;font:400 14px/1.6 ${SANS};word-break:break-all;"><a href="${manageUrl}" style="color:${PALETTE.ink};">${manageUrl}</a></p>
</td></tr>
<tr><td style="padding:22px 30px 28px;border-top:1px solid ${PALETTE.line};">
  <p style="margin:0;font:400 12px/1.6 ${SANS};color:${PALETTE.mute};">You are receiving this because you left an address on a held upload. That address has now been deleted; this is the only message it was kept for. Phaeacia &middot; <a href="${CANONICAL}/privacy" style="color:${PALETTE.mute};">privacy</a></p>
</td></tr>`);

  const text = [
    'The passport you uploaded was held for review. It has now been published.',
    '',
    `Open your passport: ${url}`,
    '',
    'This link lets you delete it or renew it. It is shown to you once, here,',
    'and nowhere else -- nobody, ourselves included, can send it to you again.',
    `Manage this passport: ${manageUrl}`,
    '',
    'You are receiving this because you left an address on a held upload.',
    'That address has now been deleted; this is the only message it was kept for.',
    `Phaeacia · ${CANONICAL}/privacy`
  ].join('\n');

  return { subject, html, text };
}

/* PH-518: the two messages a held upload's address is also kept for. Same recipient,
   same single-use promise as holdReleaseMessage: the address exists to tell the owner
   what became of the upload, once, and is deleted right after the attempt. Neither
   carries a link that grants anything and neither repeats any of the passport's text;
   `reason` in the refusal is a sentence the reviewer typed, cut to a bounded length by
   refuseHold and escaped here. */
const heldFooter = `You are receiving this because you left an address on a held upload. That address has now been deleted; this is the only message it was kept for.`;
function heldMail({ subject, lead, reasonLine, closing }) {
  const html = shell(`
<tr><td style="padding:30px 30px 0;">
  <p style="margin:0 0 4px;font:600 12px/1 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${PALETTE.mute};">Phaeacia &middot; Agent Passport</p>
  <p style="margin:0 0 16px;font:400 15px/1.6 ${SANS};color:${PALETTE.ink};">${esc(lead)}</p>
${reasonLine ? `  <p style="margin:0 0 16px;font:400 15px/1.6 ${SANS};color:${PALETTE.ink};"><strong>Why:</strong> ${esc(reasonLine)}</p>\n` : ''}  <p style="margin:0 0 26px;font:400 15px/1.6 ${SANS};color:${PALETTE.ink};">${esc(closing)}</p>
</td></tr>
<tr><td style="padding:0 30px 28px;border-top:1px solid ${PALETTE.line};">
  <p style="margin:14px 0 0;font:400 12px/1.6 ${SANS};color:${PALETTE.mute};">${esc(heldFooter)} Phaeacia &middot; <a href="${CANONICAL}/privacy" style="color:${PALETTE.mute};">privacy</a></p>
</td></tr>`);
  const text = [lead, '', ...(reasonLine ? [`Why: ${reasonLine}`, ''] : []), closing, '', heldFooter, `Phaeacia · ${CANONICAL}/privacy`].join('\n');
  return { subject, html, text };
}

export function holdRefusedMessage({ reason }) {
  return heldMail({
    subject: 'Your Agent Passport was not published · Phaeacia',
    lead: 'The passport you uploaded was held for review. A person read it and did not publish it.',
    reasonLine: reason,
    closing: 'The text has been deleted. If you fix that and upload it again, it will be looked at again.'
  });
}

export function holdExpiredMessage() {
  return heldMail({
    subject: 'Your Agent Passport was not published · Phaeacia',
    lead: 'The passport you uploaded was held for review. Nobody reviewed it within 5 days, so it was not published.',
    reasonLine: '',
    closing: 'The text has been deleted. If you still want it published, upload it again.'
  });
}

/* PH-507's third message. Sent by upload.mjs, once, at hold-creation time,
   to HOLD_ALERT_TO -- an operator address, not a stranger's, so none of the
   sender-controlled-text restrictions on recipientMessage apply here
   either, for a different reason than holdReleaseMessage's: this message
   is not sent to the person who wrote the held text, it is sent to whoever
   reviews it, and naming what to go look at is the whole job.

   NO PASSPORT TEXT, NO TITLE, NO SUMMARY, deliberately. The point of
   holding an upload for review is that a human looks at it before it
   either publishes or does not, and looking happens by going to the review
   script with real store credentials, not by reading a copy of the text
   that has now been mailed to a second address this product does not
   otherwise touch. Only the hold id (so the reviewer can find the row),
   when it was created, and the requested listing survive the trip. */
export function holdAlertMessage({ hold_id, created_at, category }) {
  const subject = 'A passport is waiting for review · Phaeacia';
  const when = created_at ? dateWords(created_at) : '';
  const listing = category ? category : 'unlisted';

  const html = shell(`
<tr><td style="padding:30px 30px 0;">
  <p style="margin:0 0 4px;font:600 12px/1 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${PALETTE.mute};">Phaeacia &middot; Agent Passport</p>
  <p style="margin:0 0 20px;font:400 15px/1.6 ${SANS};color:${PALETTE.ink};">An upload was held for review${when ? ' on ' + esc(when) : ''}.</p>
</td></tr>
<tr><td style="padding:0 30px 28px;">
  <p style="margin:0 0 6px;font:400 14px/1.6 ${SANS};color:${PALETTE.mute};">Hold id: ${esc(hold_id)}</p>
  <p style="margin:0;font:400 14px/1.6 ${SANS};color:${PALETTE.mute};">Requested listing: ${esc(listing)}</p>
</td></tr>`);

  const text = [
    `An upload was held for review${when ? ' on ' + when : ''}.`,
    '',
    `Hold id: ${hold_id}`,
    `Requested listing: ${listing}`
  ].join('\n');

  return { subject, html, text };
}

export function dateWords(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/* The one network call. Resend's REST endpoint takes JSON, so an address or a
   name cannot inject a header the way it could over raw SMTP; the cleaning
   above is belt and braces rather than the only thing standing there.

   Returns { ok } or { ok:false, reason }. The reason is for our log, never for
   the response body: an upstream provider's error text is not something to
   repeat to whoever typed an address. */
export async function sendMail({ to, subject, html, text, config, fetchImpl = fetch, timeoutMs = 10000 }) {
  const cfg = config || mailConfig();
  if (!cfg.key) return { ok: false, reason: 'no api key' };

  const payload = { from: cfg.from, to: [to], subject, html, text };
  if (cfg.replyTo) payload.reply_to = cfg.replyTo;

  let res;
  try {
    res = await fetchImpl(cfg.api || API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      // a mail that never answers must not hold up a scheduled sweep that sends one per expired hold
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    return { ok: false, reason: `network: ${e && e.message}` };
  }

  if (!res.ok) {
    /* The status, and on a 429 or a 5xx the error name (providerErrorName,
       below), nothing else. Resend echoes the offending address in some
       4xx bodies, and this site promises that address is not stored, only a
       one-way hash of it; a platform log would store it. The status is what a failure is chased with.

       `status` is there as a number too, so a caller can tell a refusal from
       everything else. A 4xx is the provider refusing the message, so it did
       not go out. A 5xx, and a failure without a status (a network error or a
       timeout), may come after the provider took the message; no key means
       nothing was attempted. send.mjs gives a ceiling back only for a 4xx. */
    if (res.status === 429 || res.status >= 500) {
      opsLog(res.status === 429 ? 'MAIL_PROVIDER_429' : 'MAIL_PROVIDER_5XX',
        { status: res.status, name: await providerErrorName(res) });
    }
    return { ok: false, reason: `http ${res.status}`, status: res.status };
  }
  return { ok: true };
}

/* WHICH 429 IT WAS, and the reason this reads a body at all (audit,
   2026-10-22). Resend answers 429 for three different things,
   rate_limit_exceeded (per second), daily_quota_exceeded and
   monthly_quota_exceeded, and "have we hit the quota" cannot be answered
   from a status code. BACKEND-PLAN.md asked for the distinction in August.

   Only on a 429 or a 5xx, never on the 4xx bodies rule 4 is about, and only
   the `name` field, kept only if it is a bare [a-z_] identifier, which no
   address can be. The read is bounded, and still under sendMail's abort
   signal, so a provider that stalls the body cannot hold the request past
   the timeout. Any failure here is `unreadable`, never a throw. */
const ERROR_BODY_MAX = 2048;
async function providerErrorName(res) {
  try {
    if (!res.body || typeof res.body.getReader !== 'function') return 'unreadable';
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < ERROR_BODY_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    reader.cancel().catch(() => {});
    const name = JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8')).name;
    return typeof name === 'string' && /^[a-z_]{1,64}$/.test(name) ? name : 'unrecognised';
  } catch {
    return 'unreadable';
  }
}
