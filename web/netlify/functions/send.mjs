/* POST /api/send — { id, token, to, from_name?, copy_to? }
   GET  /api/send — { ok, enabled }, so the page can hide a box that cannot work.

   The WeTransfer move: the sharer types one address and the link goes out.

   What this endpoint is not, and the constraints that keep it that way:

   - It is not an open relay. It needs the delete token, so only the person who
     published the passport can send it. Anyone else holding the link can copy
     and paste it from their own mail client, which is the same outcome without
     our domain's reputation attached.
   - It is not a mailing list. One address, one message. The address is in
     memory for the length of this request and is written to no store here.
     What is written down is a hash of it, in the limiter, so that one mailbox
     cannot be sent more than a few messages a day however many senders try;
     that entry stops counting when its UTC day ends and the scheduled sweep
     deletes it after that. Section 3 of the product spec calls keeping
     no address a legal requirement rather than a preference, and it is: GDPR
     and the Swiss nFADP both make "we kept it in case" the expensive answer.
     What the site tells people about this lives in other files and has to
     move with it: privacy.html (the rate-limiting, sending-the-link,
     legal-basis and your-rights paragraphs), about.html, upload.html and
     manage.html beside the send box, the recipient message's own footer in
     lib/_email.mjs, and WEBSITE-SPEC.md section 3. All of them were reworded
     to say so on 2026-09-30, from a sentence Raffael approved that day.
   - It is not a way to spend the mail allowance. The provider account is shared
     with other products and capped per day, so this endpoint has a ceiling of
     its own for the whole site, well under that cap.
   - It is not required. Every failure here leaves the passport published and
     the link working, and every message says so, because a sharer who reads
     "failed" about their publish when only the mail failed will republish. */

import { err } from '../../lib/_validate.mjs';
import { crossSite } from '../../lib/_origin.mjs';
import { CANONICAL } from '../../lib/_site.mjs';
import { archiveMode, archivedResponse } from '../../lib/_archive.mjs';
import { clientIp, rateLimit, refundLimit, authorise, readPassport, mailboxKey } from '../../lib/_store.mjs';
import {
  mailConfig, mailEnabled, validAddress, cleanName,
  recipientMessage, senderCopyMessage, sendMail
} from '../../lib/_email.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

/* The two ceilings that protect people other than the sender. Both are product
   parameters, Raffael's to move, and both windows are the limiter's fixed UTC
   day, so a ceiling spent before midnight UTC is fresh after it. He set 5 and
   50 on 2026-09-30, up from the 3 and 40 first proposed.

   Per recipient: how many messages one mailbox can be sent from this site in a
   day, counted across every sender and every network, so nobody's inbox can be
   filled from here by somebody holding many addresses. "Mailbox" means the
   address as typed, lower-cased; see mailboxKey for what that does not merge.

   For the whole site: how many messages this endpoint may put on the wire in a
   day. The mail account is shared with other products and has a daily cap (100
   on the free plan it was on in September 2026) that also carries the sign-in
   mail those products cannot work without, so this stays well under it. Like
   every ceiling here it is best effort under a simultaneous burst; see the
   limiter's comment in lib/_store.mjs. */
export const SEND_PER_RECIPIENT_PER_DAY = 5;
export const SEND_SITE_PER_DAY = 50;
const DAY_MS = 86400e3;
const SITE = 'site';

/* Charge one message to both ceilings, recipient first. The recipient ceiling
   is the one somebody hammering a single inbox hits, and checking it first
   means that traffic never touches the site-wide count at all.

   Returns the two tickets, or null when either ceiling is full, in which case
   anything it charged has already been given back. Giving back here is a
   server-chosen path with a charge that stays elsewhere, the network ceiling
   charged at the top of the handler, which is the rule refundLimit sets. */
async function chargeMessage(deploy, address) {
  const recipient = await rateLimit(deploy, mailboxKey(address), 'send-r', SEND_PER_RECIPIENT_PER_DAY, DAY_MS);
  if (!recipient) return null;
  const site = await rateLimit(deploy, SITE, 'send-g', SEND_SITE_PER_DAY, DAY_MS);
  if (!site) {
    await refundLimit(deploy, recipient);
    return null;
  }
  return [recipient, site];
}

/* A message counts against the ceilings once it has been handed to the
   provider. It is charged BEFORE the call, so a request running alongside this
   one sees it, and given back only when the provider answered with a 4xx: it
   refused the message, so nothing went out. A 5xx, a network failure or a
   timeout keeps the charge, because in each the provider may have taken the
   message before the answer went wrong (a 504 is a timeout by another name,
   and a stub that accepts and then answers 503 got a fourth message into one
   mailbox when 5xx was given back). For a ceiling that protects a shared
   allowance and somebody else's inbox, counting one too many is the safe
   mistake; the cost is that an honest sender loses a count while the provider
   is down. */
const refused = (sent) => !sent.ok && Number.isInteger(sent.status) && sent.status >= 400 && sent.status < 500;

async function settle(deploy, tickets, sent) {
  if (refused(sent)) {
    await Promise.all(tickets.map(t => refundLimit(deploy, t)));
  }
}

export default async (req, context) => {
  /* Archive mode sends nothing. The GET says disabled so no page draws the
     box; a POST anyway is 410 before the limiter (lib/_archive.mjs). */
  if (req.method === 'GET') return json(200, { ok: true, enabled: !archiveMode() && mailEnabled() });
  if (req.method !== 'POST') return json(405, { ok: false, ...err('E_METHOD') });
  if (archiveMode()) return archivedResponse();
  if (crossSite(req)) return json(403, { ok: false, ...err('E_CROSS_SITE') });

  if (!mailEnabled()) return json(503, { ok: false, ...err('E_SEND_DISABLED') });

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section. */
  const deploy = context && context.deploy;

  const ip = clientIp(req);
  if (!(await rateLimit(deploy, ip, 'send-h', 10, 3600e3))) {
    return json(429, { ok: false, ...err('E_SEND_LIMIT') });
  }

  let payload;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload || typeof payload.id !== 'string' || typeof payload.token !== 'string') {
    return json(404, { ok: false, ...err('E_MANAGE_FAILED') });
  }

  /* authorise checks the token against the blob's metadata and never touches
     the body. readPassport was here, and it made this endpoint the oracle the
     manage endpoint had stopped being: a live uuid with a wrong token took
     measurably longer than one that does not exist, and /api/send needs no
     credential to reach that line. */
  if (!(await authorise(deploy, payload.id, payload.token))) {
    return json(404, { ok: false, ...err('E_MANAGE_FAILED') });
  }

  /* Both addresses are parsed before anything is charged. They used to be
     parsed on either side of the per-passport ceiling, so five typos in the
     copy field burned a passport's entire daily send budget without a single
     message going out, and told the owner they had sent too many emails. */
  const to = validAddress(payload.to);
  if (!to) return json(422, { ok: false, ...err('E_SEND_ADDRESS') });

  const wantsCopy = payload.copy_to !== undefined && payload.copy_to !== null && payload.copy_to !== '';
  const copyTo = wantsCopy ? validAddress(payload.copy_to) : null;
  if (wantsCopy && !copyTo) return json(422, { ok: false, ...err('E_SEND_ADDRESS') });

  /* A second ceiling, on the passport rather than the network, so one link
     cannot be turned into a small mail campaign from a handful of addresses. */
  const passportTicket = await rateLimit(deploy, payload.id, 'send-p', 5, 86400e3);
  if (!passportTicket) {
    return json(429, { ok: false, ...err('E_SEND_PASSPORT_LIMIT') });
  }

  /* A request that asks for a copy puts two messages on the wire, so it costs
     two. The limit is stated as ten emails an hour and it has to mean ten
     emails, not ten requests that could each be two. */
  if (copyTo && !(await rateLimit(deploy, ip, 'send-h', 10, 3600e3))) {
    await refundLimit(deploy, passportTicket);   // nothing went out, so nothing is spent
    return json(429, { ok: false, ...err('E_SEND_LIMIT') });
  }

  const row = await readPassport(deploy, payload.id);
  if (!row) return json(404, { ok: false, ...err('E_MANAGE_FAILED') });

  /* CANONICAL, NOT THE REQUEST. This is the sharpest instance of ROW-63: the
     link below goes into an email this domain signs with DKIM and SPF passing,
     and the manage link further down carries the delete token. Built from
     `new URL(req.url).origin` — the Host header — those links named whatever
     hostname served the request.

     The edge refuses an unknown hostname on static paths, measured 3 of 3, so
     this was almost certainly never attacker-controlled. Almost, and not
     certainly, because the probe aimed at a FUNCTION path could not tell a
     refused Host from a missing passport: both answer 404. See lib/_site.mjs
     for exactly what was and was not established.

     What it was, with or without that, is every hostname the account DOES own:
     the app's *.netlify.app name, and its deploy-preview and branch-deploy
     hostnames, which reach this function by design and several of which stop
     existing when a deploy is cleaned up. A delete token mailed to a hostname
     that will 404 next week is a passport its owner cannot revoke.

     None of that is load-bearing for the line below. A constant is right
     whatever the edge does, and the reason to prefer it is that nobody has to
     establish what the edge does in order to trust the link.

     Nothing about the sender's current hostname is relevant to a stranger
     reading this mail next week. See lib/_site.mjs. */
  const url = `${CANONICAL}/p/${payload.id}`;
  /* Named mailCfg, not config: `config` is the module's route export and
     shadowing it inside the handler is a trap for the next reader. */
  const mailCfg = mailConfig();

  /* Two sender-written strings, both capped, both framed as theirs inside the
     message. The summary and the capability labels used to travel too, which is
     roughly a thousand characters of a stranger's prose inside mail this domain
     signs; see the note at the top of lib/_email.mjs. Never row.body. */
  const message = recipientMessage({
    url,
    title: row.title,
    senderName: cleanName(payload.from_name),
    expiresAt: row.expires_at
  });

  /* The recipient and site-wide ceilings come last, after everything that can
     refuse the request for the sender's own reasons, so a typo or a wrong token
     never spends a count that belongs to somebody else. One answer for both
     ceilings, and it does not say which: whether one mailbox has had its share
     today is a fact about a third person. */
  const tickets = await chargeMessage(deploy, to);
  if (!tickets) {
    await refundLimit(deploy, passportTicket);   // nothing went out, so nothing is spent
    return json(429, { ok: false, ...err('E_SEND_DAILY_LIMIT') });
  }

  const sent = await sendMail({ to, ...message, config: mailCfg });
  await settle(deploy, tickets, sent);
  if (!sent.ok) {
    /* The address is not logged. What is logged is the passport it was about
       and what the provider said, which is what a failure needs to be chased. */
    console.error('send failed', { id: payload.id, reason: sent.reason });
    await refundLimit(deploy, passportTicket);   // no mail went out; see refundLimit
    return json(502, { ok: false, ...err('E_SEND_FAILED') });
  }

  /* The sender's copy is best-effort by design. The recipient already has the
     link; failing the whole call now would tell the sharer nothing went out
     when something did, and they would send it twice. */
  let copy = 'none';
  if (copyTo) {
    /* The copy is a second message to a second mailbox, so it pays both
       ceilings again. Charged here and not up front because it is best-effort:
       a full ceiling fails the copy the way any other copy failure does, and
       the page then tells the sharer to keep the token from the screen. */
    const copyTickets = await chargeMessage(deploy, copyTo);
    if (!copyTickets) {
      copy = 'failed';
      console.error('sender copy failed', { id: payload.id, reason: 'daily ceiling' });
    } else {
      const copyMessage = senderCopyMessage({
        url,
        title: row.title,
        sentTo: to,
        manageUrl: `${CANONICAL}/manage#${payload.id}:${payload.token}`,
        deleteToken: payload.token,
        expiresAt: row.expires_at
      });
      const copySent = await sendMail({ to: copyTo, ...copyMessage, config: mailCfg });
      await settle(deploy, copyTickets, copySent);
      copy = copySent.ok ? 'sent' : 'failed';
      if (!copySent.ok) console.error('sender copy failed', { id: payload.id, reason: copySent.reason });
    }
  }

  return json(200, { ok: true, copy });
};

export const config = { path: '/api/send' };
