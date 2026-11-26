/* The body of tools/backup-stores.mjs, which is the command to run; its header
 * says how. Kept apart so tools/backup.test.mjs drives the command itself, the
 * guards, the dry run and the exit codes, against the in-memory double, and
 * so nothing a test imports can reach a real site: `connect`, the one call
 * that turns credentials into stores, is passed in by backup-stores.mjs and is
 * a no-op in the tests.
 *
 * Until the review of audit/ops-tools (2026-10-22) all of this was in
 * backup-stores.mjs, which ran main() only when process.argv[1] resolved to
 * its own path. Node resolves symlinks and junctions in the main module's URL
 * and not in argv[1], so through a symlinked checkout the command did nothing
 * and exited 0, which a wrapper reads as a backup taken. Now it always runs. */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_NOTICE, BACKUP_STORES, exportStores, parseBackup, restoreStores, serialiseBackup
} from '../lib/_store.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* Inside means the repository root itself or anything under it; on Windows
   path.relative compares without case, and a directory on another drive comes
   back absolute, which is outside. */
export function insideRepo(dir, repo = REPO) {
  const rel = path.relative(repo, path.resolve(dir));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/* Why an --apply may not go ahead, or null when it may. */
export function applyRefusal({ apply, confirm }, siteID) {
  if (!apply) return null;
  if (!confirm) return '--apply also needs --confirm-site=<site id>, naming the site this writes into.';
  if (confirm !== siteID) return '--confirm-site does not match NETLIFY_SITE_ID. Nothing was written.';
  return null;
}

/* The reminder, on stderr so it shows when stdout goes to a file, and every
   time, because the person reading it may not be the one who read it last. */
export function noticeLines() {
  const words = BACKUP_NOTICE.split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > 72) { out.push(line); line = w; } else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  const bar = '='.repeat(76);
  return [bar, '  PERSONAL DATA', ...out.map(l => '  ' + l),
    '  How long a backup may be kept is not decided yet: web/README.md, "Operator tools".', bar];
}

const pad = (s, n) => String(s).padEnd(n);

async function exportTo(out, siteID, connect, io) {
  if (!out) { io.error('Usage: backup-stores.mjs export --out=<new directory outside the repository>'); return 2; }
  const dir = path.resolve(out);
  if (insideRepo(dir)) {
    io.error(`Refusing to write a backup inside the repository (${REPO}): it holds personal data.`);
    io.error('Choose a directory outside it.');
    return 2;
  }
  /* Until 2026-10-23 an --out naming a file threw ENOTDIR from readdirSync, and
     one through a file threw it from mkdirSync after the whole site had been
     read: a stack trace and exit 1 either way. Both are usage errors, so the
     directory is made here, before connect(). */
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    io.error(`Refusing to write into ${dir}: it is a file, not a directory.`);
    return 2;
  }
  if (existsSync(dir) && readdirSync(dir).length) {
    io.error(`Refusing to write into a directory that is not empty: ${dir}`);
    return 2;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    io.error(`Cannot make the directory ${dir}: ${e.message}`);
    return 2;
  }
  connect();
  const snapshot = await exportStores();
  const { manifest, files } = serialiseBackup(snapshot, { site_id: siteID });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content, { mode: 0o600 });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

  io.log(`Backup of site ${siteID}, ${manifest.created_at}, in ${dir}`);
  for (const [name, s] of Object.entries(manifest.stores)) {
    const flags = [!s.listed && 'COULD NOT LIST', s.unreadable && `${s.unreadable} UNREADABLE`, s.vanished && `${s.vanished} deleted while reading`]
      .filter(Boolean).join(', ');
    io.log(`  ${pad(name, 20)}${pad(s.count, 8)}${pad(s.bytes + ' B', 14)}${s.sha256.slice(0, 16)}  ${flags}`);
  }
  for (const l of noticeLines()) io.error(l);
  if (!manifest.complete) {
    io.error('INCOMPLETE: a store could not be listed or a key could not be read (marked above).');
    io.error('The files are written and say so in manifest.json. Take another backup.');
    return 1;
  }
  return 0;
}

async function restoreFrom(from, { apply, force, confirm }, siteID, connect, io) {
  if (!from) { io.error('Usage: backup-stores.mjs restore --from=<dir> [--apply --confirm-site=<site id>] [--force]'); return 2; }
  const refusal = applyRefusal({ apply, confirm }, siteID);
  if (refusal) { io.error(refusal); return 2; }
  const dir = path.resolve(from);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    io.error(`No readable manifest.json in ${dir}: not a backup, or one that did not finish.`);
    return 2;
  }
  let snapshot;
  try {
    snapshot = await parseBackup(manifest, f => readFile(path.join(dir, f), 'utf8'));
  } catch (e) {
    io.error(`Refusing this backup: ${e.message}`);
    return 2;
  }

  io.log(`Backup taken ${snapshot.created_at} from site ${snapshot.site_id}.`);
  io.log(`Restoring into site ${siteID}${apply ? '' : ' (DRY RUN: nothing will be written)'}${force ? ', --force: the copy wins over newer live values' : ''}.`);
  if (snapshot.site_id !== siteID) io.error(`NOTE: this backup is of a different site (${snapshot.site_id}).`);
  if (!snapshot.complete) io.error('NOTE: this backup is marked incomplete; whatever it missed is not restored.');

  connect();
  const report = await restoreStores(snapshot, { apply, force });

  const verb = apply ? '' : 'would ';
  const order = ['passports', 'expiry', ...BACKUP_STORES.filter(n => n !== 'passports')];
  for (const name of order.filter(n => report.stores[n])) {
    const t = report.stores[name];
    const parts = [
      t.create && `${verb}create ${t.create}`, t.overwrite && `${verb}overwrite ${t.overwrite}`,
      t.keep && `keep ${t.keep} newer live`, t.same && `${t.same} already equal`, t.skip && `skip ${t.skip}`,
      t.unknown && `${t.unknown} UNREADABLE`, t.failed && `${t.failed} FAILED`
    ].filter(Boolean).join(', ');
    io.log(`  ${pad(name, 20)}${parts}${name === 'expiry' ? '  (index keys derived from the rows)' : ''}`);
  }
  if (report.expired) io.log(`  ${report.expired} unlisted passport(s) in the copy have expired since, and are not restored.`);
  if (report.resurrected) {
    io.error(`${report.resurrected} passport(s) are absent from the live stores and ${apply ? 'were' : 'would be'} created.`);
    io.error('A passport deleted by its owner, taken down or erased on request after this backup');
    io.error('was taken is absent too, and comes back. Re-apply every takedown and erasure made since');
    io.error(`${snapshot.created_at} (tools/takedown.mjs) after applying.`);
  }
  if (report.resurrectedVotes) {
    io.error(`${report.resurrectedVotes} vote(s) are absent beside passports that are still live, and ${apply ? 'were' : 'would be'} created.`);
    io.error('That is right for a votes store that was lost. A vote withdrawn after the backup was');
    io.error('taken is absent too, and comes back: the next recount counts it again.');
  }
  if (!apply) io.log('DRY RUN: nothing was written. To apply: --apply --confirm-site=<site id>');
  if (!report.ok) io.error('Some keys could not be read or written (UNREADABLE / FAILED above). Run it again.');
  return report.ok ? 0 : 1;
}

/* `argv` is what follows the script name; `connect()` installs the real stores
   (backup-stores.mjs) and runs only once a command has passed its guards;
   `io` is console unless a test records it. Returns the exit status. */
export async function main(argv, env, connect, io = console) {
  const [cmd, ...args] = argv;
  const flag = n => args.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
  const has = n => args.includes(`--${n}`);

  const siteID = env.NETLIFY_SITE_ID;
  const token = env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) {
    io.error('Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN. Both belong to the');
    io.error('account that owns the site, which for this one is the business account.');
    return 2;
  }
  const open = () => connect(siteID, token);
  if (cmd === 'export') return exportTo(flag('out'), siteID, open, io);
  if (cmd === 'restore') {
    return restoreFrom(flag('from'), { apply: has('apply'), force: has('force'), confirm: flag('confirm-site') }, siteID, open, io);
  }
  io.error('Usage: backup-stores.mjs export --out=<dir> | restore --from=<dir> [--apply --confirm-site=<site id>] [--force]');
  return 2;
}
