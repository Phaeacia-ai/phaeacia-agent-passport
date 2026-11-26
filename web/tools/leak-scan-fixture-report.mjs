#!/usr/bin/env node
/* Runs assets/leak-scan.js against the real Path W fixtures HAL named, and
 * prints what it finds. A report, not a pass/fail gate: it reads paths
 * outside this repo (other worktrees of this same repo, on the
 * path-w-read-first branch), so it is not part of `node --test` and not
 * wired into any CI-shaped runner. Run it by hand:
 *
 *   node tools/leak-scan-fixture-report.mjs
 *
 * What it checks, per HAL's brief on ROW-262/PH-477:
 *   - the known leak (s4-b-flash-ew1) must show a "Declan" hit and a
 *     "340,000" hit;
 *   - the false-positive count on the "clean" pro-model passports in the
 *     same series, and on every style cell in the sibling folder, printed
 *     as rows (line + category), not as a bare number — so the rows can be
 *     read and judged, not trusted blind.
 */
import { readFile, readdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const RUNS_ROOT = `${HOME}/Phaeacia/worktrees/path-w-read-first/verification/runs`;
const SERIES_DIR = `${RUNS_ROOT}/2026-09-15-unscored-series`;
const STYLES_DIR = `${RUNS_ROOT}/2026-09-15-unscored-styles`;
const LEAK_FIXTURE = `${SERIES_DIR}/s4-b-flash-ew1/passport.md`;
/* The five pro-model runs in the series folder: the "clean" comparison set.
 * (s5a/s5b are byte-identical to s1 per the finding's identity table, and
 * are read as separate files anyway, since HAL asked for the folder's
 * fixtures, not a de-duplicated set.) */
const CLEAN_PRO_SERIES = ['s1-b-pro-ew1', 's2a-a-pro-ew1', 's2b-a-pro-ew1', 's5a-b-pro-ew1', 's5b-b-pro-ew1'];

async function loadScanner() {
  const script = await readFile(new URL('../assets/leak-scan.js', import.meta.url), 'utf8');
  const sandbox = {};
  sandbox.window = sandbox;
  runInNewContext(script, sandbox);
  return sandbox.PhaeaciaLeakScan;
}

function printHits(label, hits) {
  console.log(`  ${label}: ${hits.length} hit line(s)`);
  for (const h of hits) {
    console.log(`    :${h.lineNo} [${h.categories.join(',')}] ${h.line.trim().slice(0, 140)}`);
  }
}

async function main() {
  const scanner = await loadScanner();

  console.log('== Known leak fixture ==');
  console.log(LEAK_FIXTURE);
  if (!existsSync(LEAK_FIXTURE)) {
    console.log('  MISSING — cannot check. Path W fixtures may not be in this worktree.');
  } else {
    const text = await readFile(LEAK_FIXTURE, 'utf8');
    const r = scanner.scan(text);
    if (!r.active) {
      console.log(`  active=false (capture_path=${r.capturePath}) — UNEXPECTED, expected browser`);
    } else {
      const declan = r.hits.some(h => h.line.indexOf('Declan') !== -1 && h.categories.includes('name'));
      const money = r.hits.some(h => h.line.indexOf('340,000') !== -1 && h.categories.includes('money'));
      console.log(`  Declan flagged: ${declan}`);
      console.log(`  £340,000 flagged: ${money}`);
      printHits('all hits', r.hits);
    }
  }

  console.log('\n== False-positive count: clean pro passports, unscored-series ==');
  let seriesTotal = 0;
  for (const name of CLEAN_PRO_SERIES) {
    const p = `${SERIES_DIR}/${name}/passport.md`;
    if (!existsSync(p)) { console.log(`  ${name}: MISSING`); continue; }
    const text = await readFile(p, 'utf8');
    const r = scanner.scan(text);
    seriesTotal += r.hits.length;
    printHits(name, r.hits);
  }
  console.log(`  TOTAL hit lines across ${CLEAN_PRO_SERIES.length} clean pro series fixtures: ${seriesTotal}`);

  console.log('\n== False-positive count: unscored-styles (all pro, per the finding) ==');
  let stylesTotal = 0;
  let styleDirs = [];
  if (existsSync(STYLES_DIR)) {
    styleDirs = (await readdir(STYLES_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory() && d.name.startsWith('st-'))
      .map(d => d.name)
      .sort();
  }
  for (const name of styleDirs) {
    const p = `${STYLES_DIR}/${name}/passport.md`;
    if (!existsSync(p)) { console.log(`  ${name}: MISSING`); continue; }
    const text = await readFile(p, 'utf8');
    const r = scanner.scan(text);
    stylesTotal += r.hits.length;
    printHits(name, r.hits);
  }
  console.log(`  TOTAL hit lines across ${styleDirs.length} style fixtures: ${stylesTotal}`);
}

main();
