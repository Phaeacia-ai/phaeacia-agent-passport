/* Run the credential sets against a checkout's upload validator and print what it
   catches. Takes a PATH so the same sets run against main and a branch in one
   session, which is what makes a before-and-after honest: measuring only the new
   side shows 20/20 and proves nothing about what changed.

   Usage:
     node tools/measure-gates.mjs                       # this checkout
     node tools/measure-gates.mjs ~/path/to/other       # another checkout

   Written under the rule that a measurement quoted in a commit message must have
   its set in the tree. The numbers this branch reported were true and could not be
   checked, which is a different failure from being wrong and is the one that
   reached a person who had no way to test it. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || resolve(here, '..'));
const sets = JSON.parse(await readFile(resolve(here, 'fixtures/credential_sets.json'), 'utf8'));
const { validate } = await import(resolve(root, 'web/lib/_validate.mjs'));
const base = await readFile(resolve(root, 'tools/fixtures/passports/valid_minimal.md'), 'utf8');

const refused = s => validate(base + '\n' + s + '\n').errors.some(e => e.code === 'E_SECRET_FOUND');
const run = (group, want) => {
  const rows = Object.entries(sets[group]).filter(([k]) => k !== '_note');
  const wrong = rows.filter(([, s]) => refused(s) !== want);
  return { n: rows.length, ok: rows.length - wrong.length, wrong: wrong.map(([k]) => k) };
};

console.log(`gate: ${root}`);
const real = run('real_credentials', true);
const mark = run('redaction_markers', false);
const clean = run('not_credentials', false);
console.log(`  real credentials refused    ${real.ok}/${real.n}`);
real.wrong.forEach(k => console.log(`      PUBLISHES: ${k}`));
console.log(`  redaction markers allowed   ${mark.ok}/${mark.n}`);
mark.wrong.forEach(k => console.log(`      refused: ${k}`));
console.log(`  ordinary content allowed    ${clean.ok}/${clean.n}`);
clean.wrong.forEach(k => console.log(`      refused: ${k}`));
process.exit(real.wrong.length ? 1 : 0);
