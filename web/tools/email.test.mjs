/* lib/_email.mjs: address rules, the recipient and sender messages, the hold-release and refusal
   mail, and sendMail itself.

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/email.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureOps } from './_helpers.mjs';

const email = await import('../lib/_email.mjs');

const copyArgs = (extra = {}) => ({
  url: 'https://app.phaeacia.ai/p/abc', title: 'Daily brief', sentTo: 'friend@example.com',
  manageUrl: 'https://app.phaeacia.ai/manage#abc:deadbeef', deleteToken: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', ...extra
});
const releaseArgs = () => ({ url: 'https://app.phaeacia.ai/p/abc', manageUrl: 'https://app.phaeacia.ai/manage#abc:deadbeef' });

/* The feedback form these messages used to link was a third-party page and is gone from the
   open-source tree. What is left to hold is the rule it was the one exception to: every link in
   a message this domain signs points at the canonical site. */
test("senderCopyMessage and holdReleaseMessage link nowhere but the canonical site", () => {
  for (const [name, m] of [
    ['sender copy', email.senderCopyMessage(copyArgs({ expiresAt: '2026-12-31T00:00:00Z' }))],
    ['hold release', email.holdReleaseMessage(releaseArgs())]
  ]) {
    const inHtml = [...m.html.matchAll(/(?:href|src)="([^"]+)"/g)].map(x => x[1]);
    const inText = m.text.match(/https?:\/\/[^\s<>()"']+/g) || [];
    assert.ok(inHtml.length > 0 && inText.length > 0, name);
    for (const link of [...inHtml, ...inText]) {
      assert.ok(link.startsWith('https://app.phaeacia.ai/'), `the ${name} links to ${link}, which is not the canonical site`);
    }
    assert.equal(/feedback form/i.test(m.html + m.text), false, `${name} still mentions the feedback form`);
  }
  assert.equal('FEEDBACK_URL' in email, false);
});

test("holdReleaseMessage's rendered text and html both carry the manage link, not only the public url", () => {
  const msg = email.holdReleaseMessage({
    url: 'https://app.phaeacia.ai/p/abc',
    manageUrl: 'https://app.phaeacia.ai/manage#abc:deadbeef'
  });
  assert.ok(msg.text.includes('https://app.phaeacia.ai/manage#abc:deadbeef'),
    'the plain-text body must carry the manage link, or an owner who cannot open the html has no way to delete their passport');
  assert.ok(msg.html.includes('https://app.phaeacia.ai/manage#abc:deadbeef'));
});
test('sendMail gives up on a provider that never answers, and says so as a failed send', { timeout: 5000 }, async () => {
  const em = await import('../lib/_email.mjs');
  let sawSignal = false;
  const hang = (_u, init) => new Promise((_, rej) => { sawSignal = !!init.signal; init.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
  const t0 = Date.now();
  /* AbortSignal.timeout's timer does not keep the process alive, and `hang` holds nothing open, so on
     Node 20 and on Node 22 before the runner changed the test runner sees an empty event loop while
     this promise is pending and CANCELS every test after it ("Promise resolution is still pending but
     the event loop has already resolved"; Netlify's build ran 107 of 326). A real request holds a
     socket; this holds a ref'd timer for the same span, cleared as soon as the send has given up. */
  const keepAlive = setTimeout(() => {}, 5000);
  let r;
  try {
    r = await em.sendMail({ to: 'a@example.com', subject: 's', html: 'h', text: 't', config: { key: 'k', from: 'f@example.com' }, fetchImpl: hang, timeoutMs: 50 });
  } finally { clearTimeout(keepAlive); }
  assert.equal(sawSignal, true, 'the request carried no abort signal');
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 1500, 'the send did not give up');
});
/* Which 429 it was (audit, 2026-10-22). Resend sends 429 for a per-second rate
   limit and for the daily and monthly quotas, and only the body's `name` tells
   them apart. The name is logged, the message beside it never is: these bodies
   are built to echo the address the way some real ones do. */
const MAIL = { to: 'reader@example.com', subject: 's', html: 'h', text: 't', config: { key: 'k', from: 'f@example.com' } };
const answering = (status, body) => async () => new Response(JSON.stringify(body), { status });

test('sendMail logs the provider error name on a 429 or a 5xx, and never the message or the address', async () => {
  const em = await import('../lib/_email.mjs');
  const quota = await captureOps(() => em.sendMail({ ...MAIL, fetchImpl: answering(429,
    { statusCode: 429, name: 'daily_quota_exceeded', message: 'Daily quota reached sending to reader@example.com' }) }));
  assert.equal(quota.value.ok, false);
  assert.equal(quota.value.status, 429, 'the result a caller settles on is unchanged');
  assert.deepEqual(quota.ops, [{ code: 'MAIL_PROVIDER_429', status: 429, name: 'daily_quota_exceeded' }]);

  const down = await captureOps(() => em.sendMail({ ...MAIL, fetchImpl: answering(503,
    { statusCode: 503, name: 'internal_server_error', message: 'try again' }) }));
  assert.deepEqual(down.ops, [{ code: 'MAIL_PROVIDER_5XX', status: 503, name: 'internal_server_error' }]);

  /* A name that is not a bare identifier is not printed, whatever it holds. */
  const odd = await captureOps(() => em.sendMail({ ...MAIL, fetchImpl: answering(429, { name: 'reader@example.com' }) }));
  assert.deepEqual(odd.ops, [{ code: 'MAIL_PROVIDER_429', status: 429, name: 'unrecognised' }]);

  /* Rule 4 at the top of _email.mjs: the other 4xx bodies are where the address
     comes back, and they are still not read or logged. */
  const refused = await captureOps(() => em.sendMail({ ...MAIL, fetchImpl: answering(422,
    { name: 'validation_error', message: 'Invalid `to` field: reader@example.com' }) }));
  assert.equal(refused.value.status, 422);
  assert.deepEqual(refused.ops, []);

  for (const { raw } of [quota, down, odd, refused]) {
    assert.equal(raw.includes('reader@example.com'), false, 'the address reached the log');
    assert.equal(/quota reached|try again|Invalid/.test(raw), false, 'the provider message reached the log');
  }
});

/* The error body is read under a byte bound, so a provider that answers 500 with
   a huge body cannot hold the send. This stream runs to 100 KB and then ends:
   an unbounded reader fails the count below instead of hanging the suite, which
   a truly endless one did (its reads never yield to the test's own timeout). */
test('sendMail reads only the start of a provider error body', { timeout: 5000 }, async () => {
  const em = await import('../lib/_email.mjs');
  let pulled = 0;
  const endless = new ReadableStream({
    pull(c) { if (++pulled > 200) c.close(); else c.enqueue(new TextEncoder().encode('x'.repeat(512))); }
  });
  const { value, ops } = await captureOps(() => em.sendMail({ ...MAIL,
    fetchImpl: async () => new Response(endless, { status: 500 }) }));
  assert.equal(value.ok, false);
  assert.deepEqual(ops, [{ code: 'MAIL_PROVIDER_5XX', status: 500, name: 'unreadable' }]);
  assert.ok(pulled < 20, `the error body was read far past its bound: ${pulled} chunks`);
});

test('the refusal mail carries the reviewer\'s reason escaped, and the expiry mail carries none', async () => {
  const em = await import('../lib/_email.mjs');
  const r = em.holdRefusedMessage({ reason: 'Contains <b>a key</b> & "more"' });
  assert.match(r.text, /Why: Contains <b>a key<\/b> & "more"/);
  assert.ok(r.html.includes('Contains &lt;b&gt;a key&lt;/b&gt; &amp; &quot;more&quot;') && !r.html.includes('<b>a key'));
  assert.doesNotMatch(em.holdExpiredMessage().text, /Why:/);
});

/* ══ email ════════════════════════════════════════════════ */

test('addresses are accepted or refused conservatively', () => {
  for (const good of ['a@b.co', 'first.last+tag@sub.example.org', 'x_y@example.travel']) {
    assert.equal(email.validAddress(good), good, good + ' should be accepted');
  }
  for (const bad of [
    '', 'nope', 'a@b', 'a@@b.co', 'a b@c.co', 'a@b.co, c@d.co', 'a@b.co;c@d.co',
    '<a@b.co>', 'a@b.co\nbcc: c@d.co', 'a'.repeat(250) + '@b.co', null, undefined, 42
  ]) {
    assert.equal(email.validAddress(bad), null, JSON.stringify(bad) + ' should be refused');
  }
});

test('a sender name cannot smuggle a link or a newline into the subject', () => {
  assert.equal(email.cleanName('Raffael'), 'Raffael');
  assert.equal(email.cleanName('  Raffael   H  '), 'Raffael H');
  assert.equal(email.cleanName('click http://evil.example'), '');
  assert.equal(email.cleanName('www.evil.example'), '');
  assert.equal(email.cleanName('me@evil.example'), '');
  assert.equal(email.cleanName('a\nBcc: victim@example.com'), '');
  assert.ok(email.cleanName('x'.repeat(200)).length <= 60);
  assert.equal(email.cleanName(undefined), '');
});

test('a title that a mail client would linkify does not travel', () => {
  /* Capping and framing a title is not a control when the framed text is a
     working link. A review walked through the "In the sender's words" block
     with "Mailbox full. Restore now: https://evil.test/o365" inside the
     ninety-character cap. */
  for (const lure of [
    'Mailbox full. Restore now: https://evil.test/o365',
    'Verify at evil.example/o365',
    'Go to www.evil.example now',
    'Contact admin@evil.example',
    'See evil.example',
    'EVIL.EXAMPLE',
    'mailto:admin@evil.example',
    'Update at bit.ly/x',
    /* The blind spot the third review found: the character immediately before
       the final dot had to be ASCII, so an IDN label with one accented letter
       walked through a filter that caught the same host spelled plainly. */
    'Verify at sicherheitä.de',
    'Verify at münchen-sicherheit.de',
    'Verify at 例え.jp',
    'Go to _evil.com now'
  ]) {
    assert.equal(email.cleanTitle(lure), email.TITLE_WITHHELD, 'this would linkify: ' + lure);
  }
});

test('the link rule errs towards withholding, and we know what that costs', () => {
  /* These are honest titles and they are withheld anyway, because a filename
     and a hostname are the same shape and only one of them is safe. Written
     down as a chosen cost rather than left as a surprise: the message says the
     name is on the page, and the page has it. */
  for (const honest of [
    'Node.js dependency reviewer',
    'Reads README.md and summarises',
    'Watches @mentions in Slack'
  ]) {
    assert.equal(email.cleanTitle(honest), email.TITLE_WITHHELD);
  }
});

test('an ordinary title is not withheld by mistake', () => {
  /* False positives cost something real: the recipient stops learning what the
     agent is called. The rule has to be narrow enough to leave normal titles
     alone. */
  for (const ordinary of [
    'Daily Brief',
    'v1.2 release notes',
    'Morning brief for the U.S. desk',
    'Reads e.g. three sources',
    'Weekly digest (2026)',
    'Job scanner: NYC and SF',
    'Brief 3.0'
  ]) {
    assert.equal(email.cleanTitle(ordinary), ordinary, 'withheld an ordinary title: ' + ordinary);
  }
  /* Still capped. */
  assert.ok(email.cleanTitle('word '.repeat(60)).length <= 91);
});

test('the recipient message carries no sender text in its subject', () => {
  /* The review that prompted this produced a real message with the subject
     "Microsoft 365 Security Team shared an agent with you: URGENT ACTION
     REQUIRED: your Microsoft 365 mailbox will be suspended in 24 hours".
     Every character of that came out of a file the sender wrote. */
  const m = email.recipientMessage({
    url: 'https://app.phaeacia.ai/p/abc',
    title: 'URGENT: your mailbox will be suspended, re-verify now',
    senderName: 'Microsoft 365 Security Team',
    expiresAt: '2026-09-08T10:00:00.000Z'
  });
  assert.equal(m.subject, 'Someone shared an agent with you · Phaeacia');
  assert.equal(m.subject.includes('URGENT'), false);
  assert.equal(m.subject.includes('Microsoft'), false);
});

test('what a sender did write is capped and framed as theirs', () => {
  const m = email.recipientMessage({
    url: 'https://app.phaeacia.ai/p/abc',
    title: 'x'.repeat(400),
    senderName: 'Raffael'
  });
  /* 90 characters and an ellipsis, not the 200 the title field allows. */
  const shown = m.html.match(/x+…/);
  assert.ok(shown, 'the title is not in the message at all');
  assert.ok(shown[0].length <= 91, 'the title was not capped: ' + shown[0].length);

  for (const framing of ["In the sender's words", 'written by them, not by us']) {
    assert.ok(m.html.includes(framing), 'missing the framing: ' + framing);
  }
  assert.ok(m.text.includes('written by them, not by us'));
});

test('the summary and the capability labels do not travel at all', () => {
  const m = email.recipientMessage({
    url: 'https://x/p/1',
    title: 'T',
    summary: 'SUMMARY-SENTINEL. And more of it.',
    capabilities: ['CAPABILITY-SENTINEL'],
    senderName: 'R'
  });
  assert.equal(m.html.includes('SUMMARY-SENTINEL'), false);
  assert.equal(m.text.includes('SUMMARY-SENTINEL'), false);
  assert.equal(m.html.includes('CAPABILITY-SENTINEL'), false);
  assert.equal(m.text.includes('CAPABILITY-SENTINEL'), false);
});

test('the recipient message escapes, links nowhere else, and names the brand', () => {
  const m = email.recipientMessage({
    url: 'https://app.phaeacia.ai/p/abc',
    title: 'Daily <Brief> & "co"',
    senderName: 'Raffael',
    expiresAt: '2026-09-08T10:00:00.000Z'
  });

  assert.ok(m.html.includes('https://app.phaeacia.ai/p/abc'));
  assert.ok(m.text.includes('https://app.phaeacia.ai/p/abc'));
  assert.equal(m.html.includes('<Brief>'), false, 'the title was not escaped');
  assert.ok(m.html.includes('&lt;Brief&gt;'));

  assert.ok(m.html.includes('8 September 2026'), 'the expiry must be in words');
  assert.ok(m.text.includes('8 September 2026'));

  /* Every message a recipient sees teaches one brand name, which is the whole
     distribution loop the product spec is built around. */
  assert.ok(m.html.includes('Phaeacia'), 'the brand name is not in the message');

  /* Nothing loads from anywhere, and the only links are ours. */
  assert.equal(/<img|<script|url\(/i.test(m.html), false, 'the email pulls a remote asset');
  for (const href of m.html.match(/href="([^"]+)"/g) || []) {
    assert.ok(/phaeacia\.ai/.test(href), 'an outbound link that is not ours: ' + href);
  }
});

test('an anonymous sender is named rather than left blank', () => {
  const m = email.recipientMessage({ url: 'https://x/p/1', title: 'T' });
  assert.ok(m.html.includes('Sent by Someone'));
  assert.ok(m.text.includes('Sent by Someone'));
});

test('sending is off, and fails closed, without a key', async () => {
  assert.equal(email.mailEnabled({}), false);
  assert.equal(email.mailEnabled({ RESEND_API_KEY: 'x' }), true);
  const r = await email.sendMail({ to: 'a@b.co', subject: 's', html: 'h', text: 't', config: { key: '' } });
  assert.equal(r.ok, false);
});

test('a send posts one recipient and the configured sender, and reports failure', async () => {
  let seen = null;
  const ok = await email.sendMail({
    to: 'a@b.co', subject: 's', html: '<p>h</p>', text: 't',
    config: { key: 'k', from: 'Agent Passport <p@example.com>', replyTo: '' },
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => '' };
    }
  });
  assert.equal(ok.ok, true);
  assert.equal(seen.url, 'https://api.resend.com/emails');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.to, ['a@b.co']);
  assert.equal(body.from, 'Agent Passport <p@example.com>');

  const bad = await email.sendMail({
    to: 'a@b.co', subject: 's', html: 'h', text: 't', config: { key: 'k', from: 'f' },
    fetchImpl: async () => ({
      ok: false, status: 422,
      text: async () => 'invalid recipient: victim@example.com'
    })
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.includes('422'));
  /* Resend echoes the offending address in some 4xx bodies, and this site
     promises the address is not stored, only a one-way hash of it. A platform
     log would store it. */
  assert.equal(bad.reason.includes('victim@example.com'), false,
    'the provider response body reached our log: ' + bad.reason);
});
