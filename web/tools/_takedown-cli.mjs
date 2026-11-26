/* The body of tools/takedown.mjs, which is the command to run; its header says
 * how. Kept apart for the reason tools/_backup-cli.mjs gives: so
 * tools/takedown.test.mjs drives the command itself, the dry run included,
 * against the in-memory double, and nothing a test imports can reach a real
 * site. `connect` is passed in by takedown.mjs and is a no-op in the tests. */

import { operatorDelete, operatorUnlist } from '../lib/_store.mjs';

const stores = ({ present, unknown }) => {
  const have = Object.entries(present).map(([name, n]) => `${name} ${n}`).join(', ') || 'none';
  return unknown.length ? `${have}; could not read: ${unknown.join(', ')}` : have;
};

/* An unlisted passport keeps its row, its index key and its counters; only
   the listing's own stores should be empty after an unlist. After a delete,
   anything at all is worth a sentence. */
const LISTING = ['gallery', 'votes', 'votes-count', 'gallery-categories'];

/* `argv` is what follows the script name, `io` is console unless a test
   records it. Returns the exit status. */
export async function main(argv, env, connect, io = console) {
  const apply = argv.includes('--apply');
  const [cmd, id] = argv.filter(a => !a.startsWith('--'));

  const siteID = env.NETLIFY_SITE_ID;
  const token = env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) {
    io.error('Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN. Both belong to the');
    io.error('account that owns the site, which for this one is the business account.');
    return 2;
  }
  if (!['unlist', 'delete'].includes(cmd) || !id) {
    io.error('Usage: takedown.mjs unlist <passport id> [--apply] | delete <passport id> [--apply]');
    return 2;
  }

  /* The bare production stores, for the reason tools/review-holds.mjs gives. */
  connect(siteID, token);
  const deploy = undefined;
  const result = await (cmd === 'delete' ? operatorDelete : operatorUnlist)(deploy, id, { apply });

  if (!result.ok && !result.row) {
    if (result.reason === 'not_a_uuid') io.error('That is not a passport id.');
    else if (result.reason === 'read_failed') io.error('Could not read the passports store. Nothing was changed. Try again.');
    else {
      io.error('No passport at that id on this site. Nothing was changed.');
      if (result.before && Object.keys(result.before.present).length) {
        io.error(`The stores still hold, under that id: ${stores(result.before)}.`);
        io.error('Those are orphans with no row; the gallery page, the recount and the sweep reclaim them.');
      }
    }
    return 1;
  }

  const r = result.row;
  io.log(`passport ${id}`);
  io.log(`  title    ${r.title}`);
  io.log(`  name     ${r.name}`);
  io.log(`  created  ${r.created_at}`);
  io.log(`  expires  ${r.listed ? 'never (listed)' : `${r.expires_at}${r.expired ? ' (already expired; the sweep has not reached it yet)' : ''}`}`);
  io.log(`  listing  ${r.listed ? `${r.category}, since ${r.listed_at}` : 'unlisted'}`);
  io.log(`  held     ${r.held ? 'yes, came out of review' : 'no'}`);
  io.log(`  stores   ${stores(result.before)}`);

  if (result.unchanged) {
    io.log('Not listed, so there is nothing to unlist. To remove it, use delete.');
    return 0;
  }
  if (!result.applied && result.ok) {
    io.log(`DRY RUN: nothing was changed. Re-run with --apply to ${cmd} it.`);
    return 0;
  }
  if (!result.ok) {
    io.error(`The ${cmd} did not complete (${result.reason}). What is there now: ${stores(result.after)}.`);
    io.error('Run it again.');
    return 1;
  }

  io.log(cmd === 'delete' ? 'Deleted.' : `Unlisted. The link now expires ${result.expires_at}.`);
  io.log(`  left     ${stores(result.after)}`);
  const left = Object.keys(result.after.present).filter(n => cmd === 'delete' || LISTING.includes(n));
  if (left.length || result.after.unknown.length) {
    io.log('  Anything left above is what the owner\'s own delete or unlist leaves too: the recount');
    io.log('  and the sweep reclaim it. Run this again later to confirm it is gone.');
  }
  if (r.listed) io.log('A gallery page cached in the last minute can still show the card (max-age=60).');
  if (cmd === 'delete') {
    io.log('A backup taken before now still holds this passport; restoring one brings it back.');
    io.log('Re-run this takedown after any restore.');
  }
  return 0;
}
