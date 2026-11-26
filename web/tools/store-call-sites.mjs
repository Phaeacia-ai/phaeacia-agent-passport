/* store-call-sites.mjs: which Blobs stores the lib/_store*.mjs family opens, read from the source.
   One scanner with two callers, check-store-split.mjs (check 4, run by build.sh) and the ROW-226 test in
   run-endpoint-tests.mjs. Each used to hold its own, and they had drifted apart: the test still read
   only lib/_store.mjs, a barrel with no call sites since the split (596c1c7, 2026-10-01), so it found
   0 stores and passed; the checker read every module but only `strong(deploy, ...)`, so a store opened
   with `drop(deploy, 'x')` passed it. No dependencies.

   A store's name reaches strong() several ways, and a first version of the test read the shapes
   present on 2026-09-08 as exhaustive, which is the false-completeness mistake ROW-226's own finding
   is about. A critic then built three counterexamples it passed (all reverted, none shipped): the
   existing `reclaim` closure called with a new literal; a new store held in a local that happened
   to be called `name`; and a literal array feeding a `for` loop into drop()/scan(). The first and
   third are read now. Read here: a literal or a module-level const as the second argument of
   strong(), drop() or scan() (drop and scan take a name and call strong() themselves);
   `fetchAll('metrics')` and `reclaim('votes', ...)`, local closures called with a literal; and a
   literal array feeding `for (const name of [...])`. A second argument in any other shape (a
   template literal, a concatenation, a variable) is not skipped: it is returned as unresolved, and
   both callers fail on it. The one exception is a bare `name`, the parameter of drop(), scan(),
   strong() itself and the closures above, which is the second counterexample and still passes, as
   does a new closure that takes `name` and is called with a literal: a known limit of a scan that
   reads text instead of the call graph, stated rather than hidden. store-call-sites.test.mjs pins
   each shape against a fixture, because today every store is ALSO opened by a literal strong()
   somewhere, so a scanner that lost the other shapes would still pass both callers. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The family: _store.mjs and any _store-<suffix>.mjs, digits and hyphens included. A first version
   took only [a-z]+, so a _store-hold-mail.mjs was read by neither caller's scan. Shared with
   check-store-split.mjs, which also uses it to decide what counts as outside the family. */
export const isStoreModule = f => /^_store(-[\w-]+)?\.mjs$/.test(f);

export function storeCallSites(lib) {
  const dir = lib instanceof URL ? fileURLToPath(lib) : lib;
  const files = readdirSync(dir).filter(isStoreModule).sort();
  const found = new Map();        // store name -> files that open it
  const unresolved = [];
  const add = (name, file) => { if (!found.has(name)) found.set(name, new Set()); found.get(name).add(file); };
  for (const f of files) {
    /* Block comments out first: these files quote `strong(deploy, ...)` and `strong(deploy, name)`
       in prose, and a scan that read those as call sites would fail on its own words. */
    const text = readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const consts = new Map([...text.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/gm)].map(m => [m[1], m[2]]));
    /* Any first argument, not only `deploy`, so a call written strong(d, 'x') is still read. Not
       after a `.` or a word character, so x.drop( and dropListing( are not taken for drop(. */
    for (const m of text.matchAll(/(?<![\w$.])(strong|drop|scan)\(\s*[A-Za-z_$][\w$.]*\s*,\s*([^,)]+)/g)) {
      const arg = m[2].trim();
      if (arg === 'name') continue;
      const lit = arg.match(/^(['"])([^'"]+)\1$/);
      if (lit) add(lit[2], f);
      else if (consts.has(arg)) add(consts.get(arg), f);
      else unresolved.push(`${f}: ${m[1]}(..., ${arg})`);
    }
    for (const m of text.matchAll(/(?<![\w$.])(?:fetchAll|reclaim)\(\s*(['"])([^'"]+)\1/g)) add(m[2], f);
    for (const m of text.matchAll(/\bfor\s*\(\s*(?:const|let)\s+name\s+of\s+\[([^\]]*)\]\s*\)/g)) {
      for (const lit of m[1].matchAll(/(['"])([^'"]+)\1/g)) add(lit[2], f);
    }
  }
  return { files, found, unresolved };
}
