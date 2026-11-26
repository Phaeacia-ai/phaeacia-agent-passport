#!/usr/bin/env node
/* PH-507's hold disposition, the human half. A held upload is neither
 * published nor refused: it sits in lib/_store.mjs's `holds` store until
 * somebody with real store credentials looks at it and decides. This is
 * that somebody's tool. It is not a web endpoint and deliberately not one --
 * see the design proposal's explicit choice not to build a second, public,
 * authenticated admin surface for a feature that does not need one.
 *
 *   NETLIFY_SITE_ID=<the app's site id> NETLIFY_AUTH_TOKEN=<token> \
 *     node tools/review-holds.mjs list
 *   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node tools/review-holds.mjs show <hold_id>
 *   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node tools/review-holds.mjs release <hold_id>
 *   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node tools/review-holds.mjs refuse <hold_id> <reason ...>
 *
 * DO NOT TAKE THE SITE ID FROM web/.netlify/state.json — see tools/metrics.mjs's
 * own note on that file, which is a cache of a link and not a record of one.
 * Get the id from the Netlify dashboard or `netlify sites:list`. The token
 * must belong to the account that owns the site.
 *
 * `list` prints a summary only: hold id, when it was created, when it
 * expires, whether an address was left, the requested listing, and what Jev
 * said. No passport text. `show` is the only command that prints the held
 * text and the record derived from it, because that is the one thing a
 * reviewer actually needs to read to decide, and it is also the one thing
 * this tool should not print by accident while somebody is scrolling
 * through a list.
 *
 * `release` and `refuse` are irreversible in the same sense every other
 * action on this site is: release publishes a real passport (mailing the
 * owner their link first if they left an address, then deleting the hold
 * row and its own address together) and refuse deletes the held text and
 * address with nothing created, after mailing the owner the reason you give
 * if they left an address (so the reason is required then, and is sent as
 * you write it: short, plain, about the passport, never about the person).
 * An address left on a hold that nobody reviews in 5 days gets one message
 * saying so when the hourly sweep deletes it; that needs nothing from you. Neither asks for confirmation here; this
 * tool is run by a person who already decided, not a page a stray click
 * lands on.
 *
 * THIS FILE IS THE IO HALF AND NOTHING ELSE, same split as tools/metrics.mjs
 * for the same reason: every judgement (index-first writes, "text and email
 * deleted together", the fingerprint discipline, the pointer that survives
 * release) lives in lib/_store.mjs, which is tested without a network. This
 * file only wires real credentials to it and prints what comes back. */

import { getStore } from '@netlify/blobs';
import {
  __useStoreFactory, listPendingHolds, readHold, releaseHold, refuseHold
} from '../lib/_store.mjs';

const [, , cmd, arg, ...rest] = process.argv;

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) {
  console.error('Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN. Both belong to the');
  console.error('account that owns the site, which for this one is the business account.');
  process.exit(2);
}

/* The same indirection lib/_store.mjs built for tools/run-tests.mjs's in-memory
   double, used here for its other sanctioned purpose: supplying real
   credentials from outside the Netlify runtime, which is the only context
   where a bare getStore(name) resolves them implicitly. See that file's own
   comment on __useStoreFactory for why this cannot be a module-level
   getStore(...) call instead. */
__useStoreFactory(name => getStore({ name, siteID, token, consistency: 'strong' }));

/* No deploy scoping: this always reads and writes the bare production store,
   which is correct for a script a human runs deliberately against the site
   they just authenticated to, and matches how manage.mjs, delete-passport.mjs
   and every other credentialed path in this app resolve `deploy` when there
   is no request to read a scope from. */
const deploy = undefined;

function printHold(row) {
  console.log(`  created  ${row.created_at}`);
  console.log(`  expires  ${row.expires_at}`);
  console.log(`  listing  ${row.gallery ? row.gallery.category : 'unlisted'}`);
  console.log(`  email    ${row.email || '(none left)'}`);
  console.log(`  jev      ${JSON.stringify(row.jev)}`);
}

if (cmd === 'list') {
  const { listFailed, holds } = await listPendingHolds(deploy);
  if (listFailed) {
    console.error('Could not list the holds store. Try again.');
    process.exit(1);
  }
  if (holds.length === 0) {
    console.log('Nothing pending.');
    process.exit(0);
  }
  for (const h of holds) {
    console.log(h.hold_id);
    console.log(`  created  ${h.created_at}`);
    console.log(`  expires  ${h.expires_at}`);
    console.log(`  listing  ${h.requested_listing || 'unlisted'}`);
    console.log(`  email    ${h.has_email ? 'yes' : 'no'}`);
    console.log(`  jev      ${JSON.stringify(h.jev)}`);
  }
  process.exit(0);
}

if (cmd === 'show') {
  if (!arg) { console.error('Usage: review-holds.mjs show <hold_id>'); process.exit(2); }
  const row = await readHold(deploy, arg);
  if (!row) { console.error('No pending hold at that id.'); process.exit(1); }
  printHold(row);
  console.log('');
  console.log(row.text);
  process.exit(0);
}

if (cmd === 'release') {
  if (!arg) { console.error('Usage: review-holds.mjs release <hold_id>'); process.exit(2); }
  const result = await releaseHold(deploy, arg);
  if (!result.ok) { console.error('Not released:', result.reason); process.exit(1); }
  console.log('Published:', result.id);
  if (result.email) {
    /* Gated on `mailed`, not on the address being present. A gate-code
       critic (critic-ph507-hold-r1) found this used to print "Mailed the
       owner" whenever an address existed, whether or not sendMail actually
       succeeded, because releaseHold discarded the send's own return value.
       Fixed at the source (releaseHold now reads it); this stays honest as
       a second line of defence. */
    console.log(result.mailed
      ? `Mailed the owner at ${result.email} (address now deleted).`
      : `Could NOT mail the owner (address now deleted, and it cannot be recovered). Check the logs for why, and relay this link to them some other way if you have one:`);
    if (!result.mailed) console.log(`  ${result.manage_url}`);
  } else {
    /* No address was ever left, so the manage link this function mints
       exists nowhere else once this process exits -- another critic
       (critic-ph507-hold-r2) found releaseHold used to discard the token
       entirely, making a released hold permanently undeletable by anyone.
       This is now the one place that link is ever shown for such a
       release: shown once, here, exactly like a normal publish's response. */
    console.log('No address was left; nothing was mailed. This is the only place this passport\'s');
    console.log('manage link will ever be shown. Relay it to the owner yourself, or note it down:');
    console.log(`  ${result.manage_url}`);
  }
  process.exit(0);
}

if (cmd === 'refuse') {
  if (!arg) { console.error('Usage: review-holds.mjs refuse <hold_id> <reason ...>'); process.exit(2); }
  const result = await refuseHold(deploy, arg, { reason: rest.join(' ') });
  if (!result.ok && result.reason === 'reason_required') {
    console.error('This hold has an address on file, so the owner is told why. Add the reason:');
    console.error('  review-holds.mjs refuse <hold_id> <reason ...>');
    process.exit(2);
  }
  if (!result.ok) { console.error('Not refused:', result.reason); process.exit(1); }
  console.log('Refused. Text and address deleted; nothing was published.');
  if (result.email) {
    console.log(result.mailed
      ? 'The owner was mailed the reason (address now deleted).'
      : 'The owner could NOT be mailed (address now deleted, and it cannot be recovered). Check the logs for why.');
  }
  process.exit(0);
}

console.error('Usage: review-holds.mjs list | show <hold_id> | release <hold_id> | refuse <hold_id> <reason ...>');
process.exit(2);
