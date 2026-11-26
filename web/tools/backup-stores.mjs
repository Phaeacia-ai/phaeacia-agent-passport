#!/usr/bin/env node
/* A copy of the production stores that hold durable state, and the way back.
 * Netlify Blobs has no backup, no versions and no point-in-time restore, and
 * this site runs destructive jobs every hour (the sweep, the recount, the hold
 * sweep). Take a copy before anything that deletes in bulk goes live, and then
 * as often as the owner decides.
 *
 *   NETLIFY_SITE_ID=<the app's site id> NETLIFY_AUTH_TOKEN=<token> \
 *     node tools/backup-stores.mjs export --out=<new directory outside the repository>
 *   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node tools/backup-stores.mjs restore --from=<dir>
 *   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node tools/backup-stores.mjs restore --from=<dir> \
 *     --apply --confirm-site=<the same site id> [--force]
 *
 * DO NOT TAKE THE SITE ID FROM web/.netlify/state.json; see tools/metrics.mjs's
 * note on that file. The token must belong to the account that owns the site.
 *
 * `export` reads and never writes to the site. It writes one JSON file per store
 * and a manifest.json with each file's count and sha256 into a NEW directory,
 * and refuses one inside this repository: the copy holds personal data, and a
 * directory in the tree is one `git add -A` away from being published.
 * manifest.json is written last, so a directory without one is an export that
 * did not finish, and `restore` refuses it.
 *
 * `restore` is a DRY RUN unless given --apply, and --apply also needs
 * --confirm-site naming the site the credentials point at, so the site a copy
 * goes into is typed on the command line rather than inherited from whatever
 * the shell had exported. It never overwrites a live value that differs from
 * the copy unless --force, and it prints what it would do, store by store,
 * before anything is written. The rules, and why each one, are in
 * lib/_store-backup.mjs. Neither command prints a passport id: an id is the
 * only secret an unlisted passport has.
 *
 * THIS FILE IS THE IO HALF AND NOTHING ELSE, same split as tools/metrics.mjs and
 * tools/review-holds.mjs: what is copied, in what order, and what a restore may
 * write is decided in lib/_store-backup.mjs and tested without a network
 * (tools/backup.test.mjs). The command itself, its guards and what it prints,
 * is tools/_backup-cli.mjs, tested against the same double; this file is the
 * one line that hands it real credentials. */

import { getStore } from '@netlify/blobs';
import { __useStoreFactory } from '../lib/_store.mjs';
import { main } from './_backup-cli.mjs';

/* The seam lib/_store-core.mjs built for the test double, used for its other
   sanctioned purpose, as tools/review-holds.mjs does: real credentials from
   outside the Netlify runtime. Bare store names only; lib/_store-backup.mjs
   takes no deploy. */
const connect = (siteID, token) =>
  __useStoreFactory(name => getStore({ name, siteID, token, consistency: 'strong' }));

process.exit(await main(process.argv.slice(2), process.env, connect));
