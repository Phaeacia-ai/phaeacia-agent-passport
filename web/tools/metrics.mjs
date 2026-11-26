#!/usr/bin/env node
/* What people are actually capturing, and what they are bouncing off.
 *
 * Reads BOTH corpora, because either one alone is a misleading half.
 *
 *   `metrics`   one row per successful publish, describing the SHAPE of what
 *               was published and nothing about who published it.
 *   `attempts`  one row per refusal: a day and an error code, nothing else.
 *
 * This tool read only `metrics` until 2026-08-30, which meant the only question
 * it could not answer was the one worth asking before a launch: how many people
 * try and fail. A refusal corpus existed for ten days before anything could read
 * it on demand. Neither store is ever swept, so both answer about all of time.
 *
 * The rules the rows are written to are in lib/_metrics.mjs and lib/_store.mjs;
 * the promise made about them to the person publishing is in privacy.html, and
 * tools/run-endpoint-tests.mjs asserts the two agree.
 *
 *   NETLIFY_SITE_ID=<the app's site id> NETLIFY_AUTH_TOKEN=<token> node tools/metrics.mjs
 *
 * DO NOT TAKE THE SITE ID FROM web/.netlify/state.json. It is stale and it is
 * wrong. Both repos carry one and neither resolves to a site. It is a cache of
 * a link, not a record of one, and nothing updates it when the link changes.
 * Get the id from the Netlify dashboard or `netlify sites:list`.
 *
 * This note previously said the opposite, twice over, and the way it was wrong
 * is worth the lines. The example here used to be a real eight-hex-digit UUID
 * prefix with an ellipsis. I replaced it with angle brackets because it read as
 * a redacted value rather than a blank, and had been pasted twice — and I wrote
 * that it "matched neither of our two sites", on the authority of the two
 * state.json files.
 *
 * It matched the app exactly. It had been pasted twice because it was correct.
 * The two ids I checked it against were the wrong ones.
 *
 * The angle brackets stay, because a blank should look like a blank whatever
 * the value behind it. The claim about the old value is gone, because it was
 * false, and the pointer to state.json is now a warning rather than an
 * instruction, because it is what made it false.
 *   … --since=2026-08-01     only rows from that day onwards, both corpora
 *   … --json                 the rows themselves, for a spreadsheet
 *
 * --json NOW EMITS AN OBJECT, `{metrics, attempts}`, WHERE IT USED TO EMIT A
 * BARE ARRAY OF PUBLISH ROWS. That is a breaking change to anyone piping it, and
 * it is deliberate rather than incidental: two corpora cannot be expressed as
 * one array without inventing a discriminator field that exists in neither
 * store, and inventing a field is worse than changing a shape.
 *
 * The token must belong to the account that owns the site. Get one from
 * Netlify under User settings, Applications, Personal access tokens.
 *
 * This reads and never writes. There is no path in this file that can delete a
 * row or change one, deliberately: the store it reads is the one thing on the
 * site that outlives the passport it describes, so the tool that reads it
 * should not be one keystroke away from editing history.
 */

import { getStore } from '@netlify/blobs';
import { metricsReport } from '../lib/_metrics-report.mjs';

const args = process.argv.slice(2);
const flag = n => args.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const has = n => args.includes(`--${n}`);

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) {
  console.error('Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN. Both belong to the');
  console.error('account that owns the site, which for this one is the business account.');
  process.exit(2);
}

const since = flag('since') || '';

/* THIS FILE IS THE IO HALF AND NOTHING ELSE. Every judgement about what the
   numbers mean lives in lib/_metrics-report.mjs, which opens no store and can
   therefore be tested. The split is _digest.mjs's and exists for the reason that
   file states about itself: a report that can only be exercised by pointing it
   at production with a real token is a report nobody has checked.

   A FAILED LISTING IS CARRIED, NOT THROWN. lib/_store.mjs's readCorpusDay goes
   to deliberate trouble to distinguish "the store is empty" from "the store did
   not answer", and the reason is sharper here than there, because this tool
   reads two stores: if `attempts` fails and `metrics` does not, throwing loses a
   healthy publish report and swallowing prints "0 refused", which is a specific
   false claim rather than a gap. So each corpus reports whether it was read and
   the report decides what may be said. */
const fetchAll = async (name) => {
  const store = getStore({ name, siteID, token, consistency: 'strong' });
  let blobs;
  try {
    ({ blobs } = await store.list());
  } catch (e) {
    return { rows: [], listed: false, reason: e && e.message };
  }

  /* Both stores key `YYYY-MM-DD:uuid`, so `--since` is a string comparison on
     the key and neither corpus needs a filter of its own. */
  const keys = blobs.map(b => b.key).filter(k => !since || k >= since).sort();

  /* Fetched in batches. Listing is cheap and bodies are not, and a corpus of a
     few thousand 578-byte rows fetched one at a time inside a for-await is the
     same mistake the sweeper made and had measured at 620 sequential round trips. */
  const rows = [];
  let unreadable = 0;
  for (let i = 0; i < keys.length; i += 25) {
    const batch = await Promise.all(
      keys.slice(i, i + 25).map(k => store.get(k, { type: 'json' }).catch(() => null))
    );
    for (const r of batch) { if (r) rows.push(r); else unreadable++; }
  }
  return { rows, listed: true, unreadable };
};

const [pub, ref] = await Promise.all([fetchAll('metrics'), fetchAll('attempts')]);

if (has('json')) {
  console.log(JSON.stringify({ metrics: pub.rows, attempts: ref.rows }, null, 2));
  process.exit(pub.listed && ref.listed ? 0 : 1);
}

const { lines, code } = metricsReport({ pub, ref, since });
/* Failure text to stderr and the report to stdout, so `metrics.mjs > file`
   captures the report and still shows the operator that half of it is missing. */
for (const l of lines) (code === 1 ? console.error : console.log)(l);
process.exit(code);
