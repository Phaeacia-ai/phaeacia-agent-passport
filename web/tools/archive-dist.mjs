#!/usr/bin/env node
/* Archive mode for the static pages: rewrites dist/ when ARCHIVE_MODE is on.

     node tools/archive-dist.mjs dist        what netlify.toml's build command runs
     ARCHIVE_MODE=1 node tools/archive-dist.mjs dist    to preview it after build-dist.py

   With the flag off it changes nothing and says so. With it on, every page in
   dist/ gets the notice and `data-archived` (archivePage in lib/_archive.mjs),
   and the create and upload pages get CLOSED_MAIN in place of their forms.
   The functions mark the pages they render themselves; this is the half that
   exists as files.

   RUNS AFTER build-dist.py and BEFORE strip-served-comments.py and
   check-served-clean.py, so the gate reads what this wrote. It works on dist/
   only and never on the tracked pages, for the reason substitute.py gives
   about rewriting tracked source on a developer's machine.

   FAILS THE BUILD when a page it must close has no single <main> to replace,
   rather than ship an upload form on a site that refuses uploads. */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveMode, archivePage, closePage } from '../lib/_archive.mjs';

/* The pages whose purpose is publishing. index.html and create.html are the
   create page's twins; upload.html is the share page. */
export const CLOSED_PAGES = Object.freeze(['index.html', 'create.html', 'upload.html']);

export async function archiveDist(dir, { env = process.env } = {}) {
  if (!archiveMode(env)) return { archived: false, pages: [], closed: [] };
  const info = await stat(dir).catch(() => null);
  if (!info || !info.isDirectory()) throw new Error(`${dir} is not a directory; run build-dist.py first`);
  const pages = (await readdir(dir)).filter(f => f.endsWith('.html')).sort();
  const closed = [];
  for (const name of pages) {
    const file = path.join(dir, name);
    let html = await readFile(file, 'utf8');
    if (CLOSED_PAGES.includes(name)) {
      const shut = closePage(html);
      if (shut === null) throw new Error(`${name} does not have exactly one <main>, so its form cannot be replaced`);
      html = shut;
      closed.push(name);
    }
    await writeFile(file, archivePage(html));
  }
  const missing = CLOSED_PAGES.filter(p => !closed.includes(p));
  if (missing.length) throw new Error(`no ${missing.join(', ')} in ${dir}, so archive mode cannot close it`);
  return { archived: true, pages, closed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node tools/archive-dist.mjs <dist dir>');
    process.exit(2);
  }
  try {
    const out = await archiveDist(dir);
    if (!out.archived) console.log('archive mode off: ' + dir + ' unchanged');
    else console.log(`archive mode on: notice on ${out.pages.length} page(s), forms replaced on ${out.closed.join(', ')}`);
  } catch (e) {
    console.error('archive-dist failed: ' + e.message);
    process.exit(1);
  }
}
