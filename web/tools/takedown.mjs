#!/usr/bin/env node
/* Unlist or delete a passport by id, without its delete token: for an abuse
 * report, an erasure request from somebody who is not the owner (privacy.html
 * promises erasure on request), or an owner who lost the token. It replaces "a
 * store operation Raffael runs by hand" (GALLERY-SPEC.md §12), which is how a
 * row goes and its card, votes or expiry entry stay behind.
 *
 *   NETLIFY_SITE_ID=<the app's site id> NETLIFY_AUTH_TOKEN=<token> \
 *     node tools/takedown.mjs unlist <passport id>       what it would do
 *   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node tools/takedown.mjs delete <passport id>
 *   ... and the same with --apply to do it.
 *
 * DO NOT TAKE THE SITE ID FROM web/.netlify/state.json; see tools/metrics.mjs.
 *
 * DRY RUN UNLESS --apply. The dry run prints the passport's title, name and
 * listing, so you can check it is the one the report is about, and what it
 * has in each store. With --apply it does what the owner's own Unlist or
 * Delete does, through the same functions (lib/_store-takedown.mjs says how),
 * then reads the stores again and prints what is left, if anything. No
 * --confirm-site, unlike a restore: a passport id is a random UUID, so the
 * wrong site answers "no passport at that id" and changes nothing.
 *
 * `unlist` takes it off the gallery and puts the link back on a thirty-day
 * clock: the page still answers anybody holding the link, and the owner can
 * list it again from /manage. For something that must not stay up, `delete`.
 * Both are irreversible in the way the owner's own are.
 *
 * A BACKUP TAKEN BEFORE A DELETE STILL HOLDS THE PASSPORT, and restoring it
 * brings the passport back (tools/backup-stores.mjs says so when it would).
 * Re-run the takedown after any such restore.
 *
 * THIS FILE IS THE IO HALF AND NOTHING ELSE, same split as tools/review-holds.mjs.
 * What it prints and when it writes is tools/_takedown-cli.mjs, tested against
 * the in-memory double; this file only hands it real credentials. */

import { getStore } from '@netlify/blobs';
import { __useStoreFactory } from '../lib/_store.mjs';
import { main } from './_takedown-cli.mjs';

/* Real credentials through the test seam, exactly as tools/review-holds.mjs
   does. */
const connect = (siteID, token) =>
  __useStoreFactory(name => getStore({ name, siteID, token, consistency: 'strong' }));

process.exit(await main(process.argv.slice(2), process.env, connect));
