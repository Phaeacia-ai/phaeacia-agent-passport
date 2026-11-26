/* the operator backup: export, the files, and restore (lib/_store-backup.mjs),
   and the command that runs them (tools/_backup-cli.mjs, behind tools/backup-stores.mjs).

   Shared setup (the in-memory blob double, reset(), GOOD, ...) is in ./_helpers.mjs, which also
   installs that double before any lib is exercised. Run just this file with:
   node --test tools/backup.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../lib/_categories.mjs';
import {
  CAT,
  DAY_MS,
  FakeStore,
  GOOD,
  VOTER_A,
  VOTER_B,
  cardOf,
  expireNow,
  expiryKeysFor,
  listedPublish,
  metaOf,
  parsed,
  reset,
  rowOf,
  store,
  stores
} from './_helpers.mjs';
import { applyRefusal, insideRepo, main } from './_backup-cli.mjs';

const OTHER = CATEGORIES.map(c => c.slug).find(s => s !== CAT);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function writesDuring(fn) {
  const proto = FakeStore.prototype;
  const orig = { set: proto.set, setJSON: proto.setJSON, delete: proto.delete };
  let n = 0;
  for (const m of Object.keys(orig)) proto[m] = async function (...a) { n++; return orig[m].apply(this, a); };
  try { await fn(); } finally { Object.assign(proto, orig); }
  return n;
}

/* What a store holds, value and metadata per key, for a before/after compare. */
const contents = name => {
  const s = stores.get(name);
  return s ? [...s.data.keys()].sort().map(k => [k, s.data.get(k), s.meta.get(k) || {}]) : [];
};
const RESTORED = [...store.BACKUP_STORES, 'expiry'];
const everything = () => Object.fromEntries(RESTORED.map(n => [n, contents(n)]));

/* A site with one of everything the backup copies, and some of what it does not. */
async function seed() {
  reset();
  const unlisted = await store.createPassport(undefined, parsed(), GOOD);
  const listed = await listedPublish();
  await store.castVote(undefined, listed.id, VOTER_A, 'up');
  await store.castVote(undefined, listed.id, VOTER_B, 'down');
  assert.ok(await store.listPassport(undefined, listed.id, listed.token, OTHER), 'the category edit must land');
  await store.bumpViews(undefined, listed.id);
  await store.bumpViews(undefined, unlisted.id);
  await store.bumpCopies(undefined, listed.id);
  await store.recordMetrics(undefined, { day: '2026-10-01', capabilities: ['calendar.read'] });
  await store.recordRejection(undefined, { day: '2026-10-01', code: 'E_BAD_VALUE' });
  await store.recordJev(undefined, { day: '2026-10-01', outcome: 'installable', score: 0.9 });
  await store.bumpPromptCopy(undefined, 'f');
  // not copied, on purpose:
  await store.rateLimit(undefined, '203.0.113.9', 'up-h', 5, 3600e3);
  await store.createHold(undefined, { record: parsed(), text: GOOD, gallery: null, jev: { outcome: 'installable', score: 0.95 } });
  return { unlisted, listed };
}

async function backupOf() {
  const { manifest, files } = store.serialiseBackup(await store.exportStores(), { site_id: 'site-a' });
  return { manifest, files, snapshot: await store.parseBackup(manifest, f => files[f]) };
}

test('backup: every store SCOPED_STORE_NAMES lists is copied or excluded with a reason, never both', () => {
  const copied = new Set(store.BACKUP_STORES);
  const excluded = new Set(Object.keys(store.NOT_BACKED_UP));
  for (const n of copied) assert.ok(!excluded.has(n), `${n} is both copied and excluded`);
  for (const n of store.SCOPED_STORE_NAMES) {
    assert.ok(copied.has(n) || excluded.has(n), `store '${n}' has no backup decision in _store-backup.mjs`);
  }
  for (const n of [...copied, ...excluded]) assert.ok(store.SCOPED_STORE_NAMES.includes(n), `${n} is not a store`);
  for (const [n, why] of Object.entries(store.NOT_BACKED_UP)) assert.ok(why.length > 20, `${n} needs its reason`);
});

test('backup: an export reads and never writes, and copies only the stores it names', async () => {
  await seed();
  let snapshot;
  assert.equal(await writesDuring(async () => { snapshot = await store.exportStores(); }), 0);
  assert.equal(snapshot.complete, true);
  assert.deepEqual(Object.keys(snapshot.stores), [...store.BACKUP_STORES]);
  for (const name of store.BACKUP_STORES) {
    assert.equal(snapshot.stores[name].entries.length, stores.get(name).data.size, `${name}: every key copied`);
  }
  const passport = snapshot.stores.passports.entries[0];
  assert.ok(passport.metadata.h, 'the token hash in the metadata must be in the copy');
});

test('backup: export, files and restore into an empty store give back the same stores', async () => {
  const { unlisted, listed } = await seed();
  const before = everything();
  const { manifest, snapshot } = await backupOf();
  assert.equal(manifest.stores.passports.count, 2);
  assert.match(manifest.stores.passports.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.notice.includes('personal data'));

  reset();
  const report = await store.restoreStores(snapshot, { apply: true });
  assert.equal(report.ok, true);
  assert.equal(report.resurrected, 2, 'both rows were absent, and the report must say so');
  assert.deepEqual(everything(), before, 'every copied store, and the derived expiry index, must match');
  assert.equal(stores.get('ratelimit'), undefined, 'the limiter is not copied');
  assert.equal(stores.get('holds'), undefined, 'holds are not copied');

  // and it works as a site, not only as bytes
  assert.equal((await store.readPassport(undefined, listed.id)).gallery.category, OTHER);
  assert.deepEqual(await store.readVotes(undefined, listed.id), { up: 1, down: 1 });
  assert.equal((await store.listGallery(undefined)).cards.length, 1);
  assert.equal(await store.deletePassport(undefined, unlisted.id, unlisted.token), true,
    'the owner\'s delete token must still work after a restore');
});

test('backup: a dry-run restore writes nothing and counts what it would do', async () => {
  await seed();
  const { snapshot } = await backupOf();
  reset();
  let report;
  assert.equal(await writesDuring(async () => { report = await store.restoreStores(snapshot); }), 0);
  assert.equal(report.applied, false);
  assert.equal(report.stores.passports.create, 2);
  assert.equal(report.stores.votes.create, 2);
  assert.equal(report.stores.expiry.create, 1);
  assert.equal(report.resurrected, 2);
  assert.equal(report.resurrectedVotes, 0, 'votes that come back with their passport are counted as the passport');
  for (const name of RESTORED) assert.deepEqual(contents(name), [], `${name} must still be empty`);
});

test('backup: a restore keeps a newer live value unless forced', async () => {
  const { unlisted, listed } = await seed();
  const { snapshot } = await backupOf();
  const copied = rowOf(unlisted.id);
  assert.ok(await store.renewPassport(undefined, unlisted.id, unlisted.token));
  await store.castVote(undefined, listed.id, VOTER_A, 'down');
  const renewed = rowOf(unlisted.id);

  const kept = await store.restoreStores(snapshot, { apply: true });
  assert.equal(kept.stores.passports.keep, 1);
  assert.equal(kept.stores.passports.same, 1);
  assert.equal(kept.stores.votes.keep, 1);
  assert.deepEqual(rowOf(unlisted.id), renewed, 'the renewed row must win');
  assert.equal(stores.get('votes').data.get(`${listed.id}:${rowOf(listed.id).gallery.generation}:${VOTER_A}`), '-1');

  const forced = await store.restoreStores(snapshot, { apply: true, force: true });
  assert.equal(forced.stores.passports.overwrite, 1);
  assert.deepEqual(rowOf(unlisted.id), copied, '--force must put the copy back');
  assert.ok(expiryKeysFor(unlisted.id).includes(`${String(Date.parse(copied.expires_at)).padStart(16, '0')}:${unlisted.id}`),
    'the copy\'s expiry index key must be written with it');
});

test('backup: a passport deleted after the backup counts as resurrected', async () => {
  const { unlisted } = await seed();
  const { snapshot } = await backupOf();
  assert.equal(await store.deletePassport(undefined, unlisted.id, unlisted.token), true);
  const report = await store.restoreStores(snapshot);
  assert.equal(report.resurrected, 1);
  assert.equal(report.stores.passports.create, 1);
  assert.equal(report.stores.passports.same, 1);
});

test('backup: an unlisted passport that has expired since is not restored, nor what hangs off it', async () => {
  const { unlisted, listed } = await seed();
  const { snapshot } = await backupOf();
  reset();
  const report = await store.restoreStores(snapshot, { apply: true, now: Date.now() + 40 * DAY_MS });
  assert.equal(report.expired, 1);
  assert.deepEqual(contents('passports').map(([k]) => k), [listed.id], 'a listed passport never expires');
  assert.deepEqual(contents('views').map(([k]) => k), [listed.id]);
  assert.deepEqual(expiryKeysFor(unlisted.id), []);
});

test('backup: nothing is restored beside a live row that has expired and waits for the sweep', async () => {
  const { unlisted } = await seed();
  const { snapshot } = await backupOf();
  expireNow(unlisted.id);
  stores.get('views').data.delete(unlisted.id);
  const report = await store.restoreStores(snapshot, { apply: true });
  assert.equal(report.stores.passports.keep, 1, 'the expired live row differs from the copy and is not overwritten');
  assert.ok(!stores.get('views').data.has(unlisted.id), 'its counter must not come back beside it');
});

test('backup: a restore puts back a lost gallery or expiry store for rows that are still there', async () => {
  const { unlisted, listed } = await seed();
  const before = everything();
  const { snapshot } = await backupOf();
  stores.delete('gallery');
  stores.delete('expiry');
  const report = await store.restoreStores(snapshot, { apply: true });
  assert.equal(report.stores.passports.same, 2);
  assert.equal(report.stores.gallery.create, 1);
  assert.equal(report.stores.expiry.create, 1);
  assert.deepEqual(contents('gallery'), before.gallery);
  assert.equal(expiryKeysFor(unlisted.id).length, 1);
  assert.equal((await store.listGallery(undefined)).cards[0].id, listed.id);
});

test('backup: a row whose index key cannot be written is not written either', async () => {
  const { unlisted, listed } = await seed();
  const { snapshot } = await backupOf();
  reset();
  stores.set('expiry', Object.assign(new FakeStore('expiry'), { failWrites: true }));
  const report = await store.restoreStores(snapshot, { apply: true });
  assert.equal(report.ok, false);
  assert.equal(report.stores.passports.failed, 1);
  assert.deepEqual(contents('passports').map(([k]) => k), [listed.id],
    'an unlisted row with no index key is the state no sweep can reach');
  assert.deepEqual(contents('views').map(([k]) => k), [listed.id], 'nothing of the unwritten row is put back');
  assert.ok(!contents('passports').some(([k]) => k === unlisted.id));
});

test('backup: a live row that cannot be read is left alone, and so is everything hanging off it', async () => {
  await seed();
  const { snapshot } = await backupOf();
  reset();
  const passports = new FakeStore('passports');
  passports.getWithMetadata = async () => { throw new Error('simulated blob outage'); };
  stores.set('passports', passports);
  const report = await store.restoreStores(snapshot, { apply: true });
  assert.equal(report.ok, false, 'unknown is not absent, and the restore must say it did not finish');
  assert.equal(report.stores.passports.unknown, 2);
  assert.equal(report.stores.votes.unknown, 2);
  for (const name of ['passports', 'expiry', 'gallery', 'gallery-categories', 'votes', 'votes-count', 'views', 'copies']) {
    assert.deepEqual(contents(name), [], `${name} must not be written beside a row that could not be read`);
  }
  assert.equal(contents('metrics').length, 1, 'the corpora hang off no row and are still restored');
});

test('backup: the files are refused when they changed, or are not what the tool wrote', async () => {
  await seed();
  const { manifest, files } = await backupOf();
  const read = f => files[f];
  await assert.rejects(store.parseBackup(manifest, f => (f === 'votes.json' ? files[f].replace('"1"', '"-1"') : files[f])), /sha256/);
  await assert.rejects(store.parseBackup({ ...manifest, version: 2 }, read), /manifest/);
  /* A store it does not restore is refused by name, even when its file name and
     sha256 are in order: a holds.json that reads back as the votes file. */
  await assert.rejects(store.parseBackup({ ...manifest, stores: { ...manifest.stores, holds: { ...manifest.stores.votes, file: 'holds.json' } } },
    f => files[f === 'holds.json' ? 'votes.json' : f]), /does not restore: holds/);
  await assert.rejects(store.parseBackup({ ...manifest, stores: { votes: { ...manifest.stores.votes, file: '../votes.json' } } }, read), /file name/);
  await assert.rejects(store.parseBackup({ ...manifest, stores: { votes: { ...manifest.stores.votes, count: 99 } } }, read), /count/);
});

test('backup-stores.mjs: no backup inside the repository, and no --apply without naming the site', () => {
  assert.equal(insideRepo(ROOT, ROOT), true);
  assert.equal(insideRepo(path.join(ROOT, 'web', 'backup'), ROOT), true);
  assert.equal(insideRepo(path.join(ROOT, 'web', 'backup')), true, 'the default root must be this checkout');
  assert.equal(insideRepo(path.join(ROOT, '..', 'elsewhere'), ROOT), false);
  assert.equal(insideRepo(path.join(ROOT, '..notes'), ROOT), true, 'a name that starts with dots is still inside');
  if (!insideRepo(tmpdir(), ROOT)) assert.equal(insideRepo(path.join(tmpdir(), 'b'), ROOT), false);

  assert.equal(applyRefusal({ apply: false }, 'site-a'), null, 'a dry run needs no confirmation');
  assert.match(applyRefusal({ apply: true }, 'site-a'), /also needs --confirm-site/);
  assert.match(applyRefusal({ apply: true, confirm: 'site-b' }, 'site-a'), /does not match/);
  assert.equal(applyRefusal({ apply: true, confirm: 'site-a' }, 'site-a'), null);
});

test('backup: a live row that differs from the copy only in its metadata is newer, and --force puts the copy back', async () => {
  const { unlisted } = await seed();
  const { snapshot } = await backupOf();
  const copied = metaOf(unlisted.id);
  stores.get('passports').meta.set(unlisted.id, { ...copied, h: 'f'.repeat(64) });
  const kept = await store.restoreStores(snapshot, { apply: true });
  assert.equal(kept.stores.passports.keep, 1, 'the metadata is half the entry: its h is the delete link');
  assert.equal(kept.stores.passports.same, 1);
  assert.equal(metaOf(unlisted.id).h, 'f'.repeat(64));
  const forced = await store.restoreStores(snapshot, { apply: true, force: true });
  assert.equal(forced.stores.passports.overwrite, 1);
  assert.deepEqual(metaOf(unlisted.id), copied);
});

test('backup: votes from an earlier listing generation are in the copy and are not put back', async () => {
  const { listed } = await seed();
  /* what a dropListing that ran out of budget leaves for the recount */
  const orphan = `${listed.id}:00000000-0000-4000-8000-000000000001:${VOTER_B}`;
  stores.get('votes').data.set(orphan, '1');
  const { snapshot } = await backupOf();
  assert.ok(snapshot.stores.votes.entries.some(e => e.key === orphan), 'the export copies what the store holds');
  reset();
  const report = await store.restoreStores(snapshot, { apply: true });
  assert.equal(report.stores.votes.skip, 1);
  assert.equal(report.stores.votes.create, 2);
  assert.ok(!stores.get('votes').data.has(orphan), 'only the current generation\'s votes belong with the row');
});

test('backup: a vote withdrawn after the copy, which a restore would put back, is counted', async () => {
  const { listed } = await seed();
  const { snapshot } = await backupOf();
  await store.castVote(undefined, listed.id, VOTER_A, 'none');
  const report = await store.restoreStores(snapshot);
  assert.equal(report.stores.votes.create, 1);
  assert.equal(report.resurrectedVotes, 1, 'absent beside a live row looks like lost, and the report must say so');
  assert.equal(report.resurrected, 0);
});

test('backup: --force never zeroes a live card from a copy that has none', async () => {
  const { listed } = await seed();
  const { snapshot } = await backupOf();
  snapshot.stores.gallery.entries = [];
  const live = cardOf(listed.id);
  assert.ok(live.up + live.down > 0, 'the live card carries the tally');
  const forced = await store.restoreStores(snapshot, { apply: true, force: true });
  assert.equal(forced.stores.gallery.keep, 1, 'a card made from the row is not in the copy, and --force covers only the copy');
  assert.deepEqual(cardOf(listed.id), live);

  stores.get('gallery').data.delete(listed.id);
  const repaired = await store.restoreStores(snapshot, { apply: true, force: true });
  assert.equal(repaired.stores.gallery.create, 1, 'with no live card, the one made from the row is the repair');
  assert.equal(cardOf(listed.id).generation, rowOf(listed.id).gallery.generation);
});

/* ── the command, tools/_backup-cli.mjs ─────────────────────
   Driven as backup-stores.mjs drives it, with a connect that leaves the double
   in place and counts that it ran, and a console that records. */
const ENV = { NETLIFY_SITE_ID: 'site-a', NETLIFY_AUTH_TOKEN: 'test-only' };
async function cli(argv, env = ENV) {
  const out = [];
  const err = [];
  let connected = 0;
  let code;
  const writes = await writesDuring(async () => {
    code = await main(argv, env, () => { connected++; }, { log: l => out.push(l), error: l => err.push(l) });
  });
  return { code, writes, connected, out: out.join('\n'), err: err.join('\n') };
}
const SCRATCH = insideRepo(tmpdir()) && 'the system temp directory is inside the repository';
const scratch = () => mkdtempSync(path.join(tmpdir(), 'ap-backup-test-'));

test('backup-stores.mjs: export refuses a directory inside the repository, or one that is not empty, before it connects', { skip: SCRATCH }, async () => {
  await seed();
  const inRepo = path.join(ROOT, 'web', `backup-refused-${process.pid}`);
  const full = scratch();
  try {
    const r = await cli(['export', `--out=${inRepo}`]);
    assert.equal(r.code, 2);
    assert.match(r.err, /inside the repository/);
    assert.equal(r.connected, 0, 'refused before any store is opened');
    assert.equal(existsSync(inRepo), false);

    writeFileSync(path.join(full, 'keep.txt'), 'x');
    const r2 = await cli(['export', `--out=${full}`]);
    assert.equal(r2.code, 2);
    assert.match(r2.err, /not empty/);
    assert.equal(r2.connected, 0);
    assert.deepEqual(readdirSync(full), ['keep.txt']);
  } finally {
    /* only ever there if the guard broke, and then not left in the tree */
    rmSync(inRepo, { recursive: true, force: true });
    rmSync(full, { recursive: true, force: true });
  }
});

test('backup-stores.mjs: --out or --from naming a file, or a path through one, is refused before it connects', { skip: SCRATCH }, async () => {
  /* each of these threw ENOTDIR as a stack trace until 2026-10-23, the second
     only after the whole site had been read */
  await seed();
  const base = scratch();
  const file = path.join(base, 'file.txt');
  try {
    writeFileSync(file, 'x');
    for (const out of [file, path.join(file, 'copy')]) {
      const r = await cli(['export', `--out=${out}`]);
      assert.equal(r.code, 2, out);
      assert.match(r.err, /not a directory/i);
      assert.equal(r.connected, 0, 'refused before any store is opened');
    }
    const from = await cli(['restore', `--from=${file}`]);
    assert.equal(from.code, 2);
    assert.match(from.err, /No readable manifest/);
    assert.equal(from.connected, 0);
    assert.deepEqual(readdirSync(base), ['file.txt']);
    assert.equal(readFileSync(file, 'utf8'), 'x');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('backup-stores.mjs: export, then restore: a dry run, no --apply without the right site, then --apply', { skip: SCRATCH }, async () => {
  await seed();
  const before = everything();
  const base = scratch();
  const dir = path.join(base, 'copy');
  try {
    const ex = await cli(['export', `--out=${dir}`]);
    assert.equal(ex.code, 0, ex.err);
    assert.equal(ex.connected, 1);
    assert.equal(ex.writes, 0, 'an export never writes to the site');
    assert.match(ex.err, /PERSONAL DATA/, 'the reminder goes out on every export');
    assert.deepEqual(readdirSync(dir).sort(), ['manifest.json', ...store.BACKUP_STORES.map(n => `${n}.json`)].sort());
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.complete, true);
    for (const [name, m] of Object.entries(manifest.stores)) {
      assert.equal(store.sha256(readFileSync(path.join(dir, m.file), 'utf8')), m.sha256, `${name}: the sha256 is the file's`);
    }

    reset();
    const dry = await cli(['restore', `--from=${dir}`]);
    assert.equal(dry.code, 0, dry.err);
    assert.equal(dry.writes, 0, 'restore without --apply is a dry run');
    assert.match(dry.out, /DRY RUN/);
    assert.match(dry.err, /2 passport\(s\) are absent/);

    for (const [flags, why] of [[['--apply'], /also needs --confirm-site/], [['--apply', '--confirm-site=site-b'], /does not match/]]) {
      const no = await cli(['restore', `--from=${dir}`, ...flags]);
      assert.equal(no.code, 2, flags.join(' '));
      assert.match(no.err, why);
      assert.equal(no.connected, 0, 'refused before any store is opened');
      assert.equal(no.writes, 0);
    }
    for (const name of RESTORED) assert.deepEqual(contents(name), [], `${name} must still be empty`);

    const yes = await cli(['restore', `--from=${dir}`, '--apply', '--confirm-site=site-a']);
    assert.equal(yes.code, 0, yes.err);
    assert.deepEqual(everything(), before, 'the command puts back what it copied');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('backup: a key that cannot be read makes the copy incomplete, and the command exits 1', { skip: SCRATCH }, async () => {
  const { listed } = await seed();
  const views = stores.get('views');
  views.getWithMetadata = async key => {
    if (key === listed.id) throw new Error('simulated blob outage');
    return FakeStore.prototype.getWithMetadata.call(views, key);
  };
  const base = scratch();
  try {
    const snapshot = await store.exportStores();
    assert.equal(snapshot.complete, false, 'unknown is not gone');
    assert.equal(snapshot.stores.views.unreadable, 1);
    assert.equal(snapshot.stores.views.vanished, 0);
    assert.ok(!snapshot.stores.views.entries.some(e => e.key === listed.id));

    const r = await cli(['export', `--out=${path.join(base, 'copy')}`]);
    assert.equal(r.code, 1);
    assert.match(r.err, /INCOMPLETE/);
    const manifest = JSON.parse(readFileSync(path.join(base, 'copy', 'manifest.json'), 'utf8'));
    assert.equal(manifest.complete, false);
    assert.equal(manifest.stores.views.unreadable, 1);
  } finally {
    delete views.getWithMetadata;
    rmSync(base, { recursive: true, force: true });
  }
});

test('backup-stores.mjs: restore exits 1 when a live key cannot be read or a write fails', { skip: SCRATCH }, async () => {
  /* a wrapper reads the exit status, not the UNREADABLE / FAILED in the table */
  await seed();
  const base = scratch();
  const dir = path.join(base, 'copy');
  try {
    assert.equal((await cli(['export', `--out=${dir}`])).code, 0);

    reset();
    const passports = new FakeStore('passports');
    passports.getWithMetadata = async () => { throw new Error('simulated blob outage'); };
    stores.set('passports', passports);
    const dry = await cli(['restore', `--from=${dir}`]);
    assert.equal(dry.code, 1, 'unknown is not absent, even in a dry run');
    assert.match(dry.out, /2 UNREADABLE/);
    assert.match(dry.err, /could not be read or written/);

    reset();
    stores.set('expiry', Object.assign(new FakeStore('expiry'), { failWrites: true }));
    const failed = await cli(['restore', `--from=${dir}`, '--apply', '--confirm-site=site-a']);
    assert.equal(failed.code, 1);
    assert.match(failed.out, /1 FAILED/);
    assert.match(failed.err, /could not be read or written/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('backup-stores.mjs: without credentials or a command nothing is opened', async () => {
  for (const env of [{}, { NETLIFY_SITE_ID: 'site-a' }]) {
    const r = await cli(['export', '--out=unused'], env);
    assert.equal(r.code, 2);
    assert.match(r.err, /Set NETLIFY_SITE_ID/);
    assert.equal(r.connected, 0);
  }
  assert.equal((await cli(['frobnicate'])).code, 2);
  const none = await cli(['restore', `--from=${path.join(tmpdir(), `no-such-backup-${process.pid}`)}`]);
  assert.equal(none.code, 2);
  assert.match(none.err, /No readable manifest/);
  assert.equal(none.connected, 0);
});

test('backup-stores.mjs: restore says when it would bring back a vote withdrawn since the copy', { skip: SCRATCH }, async () => {
  const { listed } = await seed();
  const base = scratch();
  const dir = path.join(base, 'copy');
  try {
    assert.equal((await cli(['export', `--out=${dir}`])).code, 0);
    await store.castVote(undefined, listed.id, VOTER_A, 'none');
    const dry = await cli(['restore', `--from=${dir}`]);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.err, /1 vote\(s\) are absent beside passports that are still live, and would be created/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('backup-stores.mjs and takedown.mjs run when started through a symlink or junction', { skip: SCRATCH }, () => {
  /* backup-stores.mjs used to run only when process.argv[1] resolved to its own
     path, and Node resolves links in the main module's URL and not in argv[1],
     so through a linked checkout it exited 0 having done nothing. Each command
     is started here through a link to this directory with no arguments and no
     credentials, which can only print the credentials message and exit 2. */
  const base = scratch();
  try {
    const link = path.join(base, 'tools');
    symlinkSync(fileURLToPath(new URL('.', import.meta.url)), link, 'junction');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NETLIFY_')));
    for (const script of ['backup-stores.mjs', 'takedown.mjs']) {
      const r = spawnSync(process.execPath, [path.join(link, script)], { env, encoding: 'utf8' });
      assert.equal(r.status, 2, `${script} through a link: ${r.stderr}`);
      assert.match(r.stderr, /Set NETLIFY_SITE_ID/);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
