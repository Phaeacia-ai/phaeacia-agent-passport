/* tools/store-call-sites.mjs, the scan behind check-store-split.mjs check 4 and the ROW-226 test,
   against a planted lib/ rather than the real one. Against the real one it proves too little: every
   store lib/ opens today is ALSO opened by a literal strong(deploy, '...') somewhere, so a scanner
   narrowed back to strong() alone (the blind spot that let drop(deploy, 'x') through, 2026-10-22)
   still passes both callers. Here each shape the scanner claims to read opens a store of its own.
   Run just this file with: node --test tools/store-call-sites.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { storeCallSites, isStoreModule } from './store-call-sites.mjs';

const FIXTURE = {
  '_store-x.mjs': `
/* Prose quoting a call is not a call: strong(deploy, 'in-comment'), drop(deploy, 'in-comment-2'),
   fetchAll('in-comment-3'), for (const name of ['in-comment-4']) */
export const DRYRUN = 'from-const';
const lower = 'not-a-module-const';
export async function f(deploy, d, x, name) {
  strong(deploy, 'single');
  drop(d, "double");
  scan(deploy, DRYRUN);
  strong(
    deploy,
    'multi-line'
  );
  await fetchAll('fetched');
  await reclaim('reclaimed', 5);
  for (const name of ['loop-a', "loop-b"]) await drop(deploy, name);
  strong(deploy, \`tpl-\${x}\`);
  strong(deploy, 'pre' + x);
  strong(deploy, lower);
  x.drop(deploy, 'method-call');
  dropListing(deploy, 'other-function');
}
`,
  /* No re-export written out here: check 5 reads this file's text, and would take one for an import. */
  '_store.mjs': `export const barrel = true;\n`,
  '_store-hold-mail.mjs': `strong(deploy, 'hyphenated-suffix');\n`,
  '_store-v2.mjs': `strong(deploy, 'digit-suffix');\n`,
  '_storefront.mjs': `strong(deploy, 'not-in-family');\n`,
  '_digest.mjs': `strong(deploy, 'not-in-family-2');\n`
};

test('storeCallSites: reads every shape it claims to, flags what it cannot resolve, and nothing else', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'store-call-sites-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [f, src] of Object.entries(FIXTURE)) writeFileSync(path.join(dir, f), src);

  const { files, found, unresolved } = storeCallSites(dir);
  assert.deepEqual(files, ['_store-hold-mail.mjs', '_store-v2.mjs', '_store-x.mjs', '_store.mjs']);
  assert.deepEqual(Object.fromEntries([...found].map(([n, where]) => [n, [...where]])), {
    'single': ['_store-x.mjs'],
    'double': ['_store-x.mjs'],
    'from-const': ['_store-x.mjs'],
    'multi-line': ['_store-x.mjs'],
    'fetched': ['_store-x.mjs'],
    'reclaimed': ['_store-x.mjs'],
    'loop-a': ['_store-x.mjs'],
    'loop-b': ['_store-x.mjs'],
    'hyphenated-suffix': ['_store-hold-mail.mjs'],
    'digit-suffix': ['_store-v2.mjs']
  });
  /* The bare `name` in the loop's drop() is the known exception, read as a parameter, not a store. */
  assert.deepEqual(unresolved, [
    '_store-x.mjs: strong(..., `tpl-${x}`)',
    "_store-x.mjs: strong(..., 'pre' + x)",
    '_store-x.mjs: strong(..., lower)'
  ]);
});

test('isStoreModule: the barrel and any _store-<suffix>.mjs, and no other file', () => {
  for (const f of ['_store.mjs', '_store-core.mjs', '_store-hold-mail.mjs', '_store-v2.mjs']) assert.ok(isStoreModule(f), f);
  for (const f of ['_storefront.mjs', '_store-.mjs', 'store.mjs', '_store-core.js', '_digest.mjs']) assert.ok(!isStoreModule(f), f);
});
