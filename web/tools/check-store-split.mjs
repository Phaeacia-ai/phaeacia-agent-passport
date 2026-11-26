#!/usr/bin/env node
/* check-store-split.mjs: guards the _store-*.mjs family. No dependencies. Run from anywhere:
     node web/tools/check-store-split.mjs [path/to/web/lib]
   Five checks, each of which exists because the split made it necessary:
     1. PUBLIC SURFACE   _store.mjs exports exactly the names importers could reach before the split.
     2. LAYERING         modules import only from modules EARLIER in LAYERS; so no cycles. Every
                         _store-*.mjs is in LAYERS, or 2 and 3 would never read it.
     3. ISOLATION        each module imports cleanly on its own, in a fresh process (no load-order luck).
     4. STORE NAMES      every store ANY _store*.mjs file opens is in SCOPED_STORE_NAMES, read by
                         store-call-sites.mjs, the scanner the ROW-226 test also uses.
     5. BARREL ONLY      nothing outside the family (netlify/functions/, tools/, the rest of lib/)
                         imports a _store-*.mjs module. The split made strong() and factory
                         importable, where strong() had been private to one file: a function that
                         opened a store itself would be invisible to check 4 and to a preview
                         scope's teardown.
   Run by web/build.sh before the web tests since 2026-10-22; written with the split (596c1c7) and
   run by nothing until then. */
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { storeCallSites, isStoreModule } from './store-call-sites.mjs';

const lib = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib'));
const LAYERS = ['core', 'listing', 'ratelimit', 'metrics', 'counters', 'expiry', 'votes', 'passport', 'gallery', 'holds', 'scopes', 'takedown', 'backup'];
/* Update deliberately when the public API changes; that is the point of the list. */
const PUBLIC = [
  'EXPIRY_SHARE', 'HOLD_MAIL_TIMEOUT_MS', 'HOLD_SWEEP_BUDGET_MS', 'HOLD_TTL_DAYS',
  'IPV6_BLOCK_BITS', 'PROMPT_COPY_PATHS', 'REFUSAL_REASON_MAX', 'RENEW_DAYS',
  'SCOPED_STORE_NAMES', 'SCOPE_ABANDON_MS', 'SCOPE_SWEEP_BUDGET_MS', 'SWEEP_BUDGET_MS',
  'TTL_DAYS', 'UNREACHED_NAMES_CAP', 'UUID', 'VIEWS_SLICES', '__forgetRegistrations',
  '__useStoreFactory', 'attachHoldEmail', 'authorise', 'bumpCopies', 'bumpPromptCopy',
  'bumpViews', 'burnAck', 'castVote', 'checkHold', 'claimDigestDay', 'claimFingerprint',
  'clientIp', 'createHold', 'createPassport', 'deletePassport', 'deployScope', 'dryRunCursor',
  'dryRunFingerprint', 'dryRunReport', 'dryRunSetChanged', 'expiryFrom', 'getDay', 'hashMatches',
  'ipKey', 'isExpired', 'limitPrefix', 'listGallery', 'listPassport', 'listPendingHolds',
  'listedMeta', 'mailboxKey', 'mintAck', 'mintDeleteToken', 'networkOf', 'parseSeenKey',
  'rateLimit', 'readAck', 'readCopies', 'readCorpusDay', 'readHold', 'readPassport',
  'readPromptCopies', 'readViews', 'readVotes', 'recordJev', 'recordMetrics', 'recordRejection',
  'recount', 'refundLimit', 'refuseHold', 'releaseHold', 'renewPassport', 'saveDryRunCursor',
  'scopeKey', 'seenKey', 'seenRecently', 'sha256', 'statusOf', 'sweep', 'sweepHolds',
  'sweepScopes', 'tokenMatches', 'unlistPassport',
  // the operator tools, 2026-10-22: _store-takedown and _store-backup
  'operatorDelete', 'operatorUnlist',
  'BACKUP_NOTICE', 'BACKUP_STORES', 'NOT_BACKED_UP', 'exportStores', 'parseBackup', 'restoreStores',
  'serialiseBackup'
];

let failed = 0;
const bad = m => { failed++; console.log('  FAIL ' + m); };
const file = n => path.join(lib, n === 'barrel' ? '_store.mjs' : `_store-${n}.mjs`);

console.log('1. public surface');
const ns = await import(pathToFileURL(file('barrel')).href);
const have = Object.keys(ns).sort(), want = [...PUBLIC].sort();
for (const n of want) if (!have.includes(n)) bad(`missing export: ${n}`);
for (const n of have) if (!want.includes(n)) bad(`unexpected export (internal leak?): ${n}`);
console.log(`   ${have.length} exports`);

console.log('2. layering');
/* Checks 2 and 3 walk LAYERS, so a module missing from it was layered and isolated by nobody. */
for (const f of readdirSync(lib).filter(isStoreModule)) {
  const m = f.slice('_store-'.length, -'.mjs'.length);
  if (f !== '_store.mjs' && !LAYERS.includes(m)) bad(`lib/${f} is in the _store-*.mjs family but not in LAYERS; add it at its layer`);
}
for (const m of LAYERS) {
  const src = readFileSync(file(m), 'utf8');
  for (const [, , dep] of src.matchAll(/from\s+(['"])\.\/_store-([\w-]+)\.mjs\1/g)) {
    if (!LAYERS.includes(dep)) bad(`${m} imports unknown module ${dep}`);
    else if (LAYERS.indexOf(dep) >= LAYERS.indexOf(m)) bad(`${m} imports ${dep}, which is not below it (cycle risk)`);
  }
}

console.log('3. isolation');
for (const m of LAYERS) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file(m)).href)})`], { encoding: 'utf8' });
  if (r.status !== 0) bad(`${m} does not import on its own: ${(r.stderr || '').split('\n').find(l => /Error/.test(l)) || r.stderr.slice(0, 200)}`);
}

console.log('4. store names');
const { files, found, unresolved } = storeCallSites(lib);
const listed = new Set(ns.SCOPED_STORE_NAMES);
for (const [n, where] of found) if (!listed.has(n)) bad(`store '${n}' is opened (${[...where].join(', ')}) but not in SCOPED_STORE_NAMES (a preview scope would leak it)`);
for (const u of unresolved) bad(`cannot resolve store name statically: ${u}`);
/* Not vacuous: reading the wrong files finds nothing and reports agreement, which is how the
   ROW-226 test passed for three weeks on the barrel alone. */
if (!found.size) bad(`no store opened in ${files.length} file(s) under ${lib}; the scan is reading the wrong files`);
console.log(`   ${found.size} stores opened in ${files.length} files, ${listed.size} listed`);

console.log('5. barrel only');
const web = path.dirname(lib);
const outside = [
  ...['netlify/functions', 'tools'].flatMap(d => readdirSync(path.join(web, d)).filter(f => f.endsWith('.mjs')).map(f => path.join(d, f))),
  ...readdirSync(lib).filter(f => f.endsWith('.mjs') && !isStoreModule(f)).map(f => path.join(path.basename(lib), f))
];
for (const rel of outside) {
  const src = readFileSync(path.join(web, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"`])([^'"`\n]+)\1/gm)) {
    if (/_store-/.test(m[2])) bad(`${rel.split(path.sep).join('/')} imports ${m[2]}; import the barrel, lib/_store.mjs, instead`);
  }
}
console.log(`   ${outside.length} files outside the family`);

console.log(failed ? `\n${failed} problem(s)` : '\nOK');
process.exit(failed ? 1 : 0);
