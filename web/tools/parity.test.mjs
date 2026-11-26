/* places where this code has to stay in step with something outside lib/: the endpoint spec table, the
   Python probe tables and extractor, the SVG mark, the HTML pages.

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/parity.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { MESSAGES, finder, render } from './_helpers.mjs';

test('every emitted error code has a row in the endpoint spec table', async () => {
  /* WHY THIS EXISTS. Nothing enforced parity between the MESSAGES catalogue and
     the status/code table in site/spec/upload-validation.md, and they drifted:
     four codes were emitted with no row, found by hand in ROW-42. Adding the
     rows fixes the instance. This fixes the class, which is the only reason the
     instance stays fixed — the drift is invisible and unbounded, and the next
     four would go unrecorded exactly the same way.

     The table is descriptive of endpoint behaviour, not normative over it. The
     normative passport spec is spec/passport-0.1.md and nothing here touches
     it. */
  const root = new URL('../../', import.meta.url);
  const spec = await readFile(new URL('site/spec/upload-validation.md', root), 'utf8');

  /* Table ROWS only. Codes are also named in the prose around the table, and
     counting those instead is how an earlier pass reported a phantom row that
     was not there. A row starts with a pipe; prose does not. */
  const rows = new Set(
    spec.split('\n')
        .filter(line => line.startsWith('|'))
        .flatMap(line => line.match(/E_[A-Z0-9_]+/g) || [])
  );

  /* Read every module that could emit one, so the allowlist below cannot be
     used to hide a code somebody has since wired up. */
  let source = '';
  for (const dir of ['web/lib/', 'web/netlify/functions/']) {
    const d = new URL(dir, root);
    for (const name of await readdir(d)) {
      if (name.endsWith('.mjs')) source += await readFile(new URL(name, d), 'utf8');
    }
  }
  const emitted = new Set(
    (source.match(/err\(\s*'E_[A-Z0-9_]+'/g) || []).map(m => m.match(/E_[A-Z0-9_]+/)[0])
  );

  /* Defined, and emitted by nothing. send.mjs answers an unfindable passport
     with E_MANAGE_FAILED, so the state this message describes is one no
     endpoint produces. It must NOT get a spec row: the table says what the
     endpoints do, and a row for an unreachable code documents behaviour that
     cannot happen. Both assertions below fire if that ever changes. */
  const NOT_EMITTED = new Set(['E_SEND_UNPUBLISHED']);

  /* Emitted, with a row that exists but is not IN THIS WORKTREE'S copy of the
     file: it is on a branch of the agent-passport repo, not merged here yet.
     Twin of the SITE_ONLY escape hatch in tools/run_tests.sh (same reason,
     same removal condition), added 2026-09-08 because this JS-side check has
     no escape hatch of its own and the Python one's did not cover it —
     E_WRITE_UNCONFIRMED already failed this exact assertion at a96edad,
     silently, since nothing runs this file as part of `tools/run_tests.sh`
     (that script only parses parts of its source as text; a critic on
     16ee46a found the gap by actually executing `node tools/run-tests.mjs`,
     which nothing in this repo's stated verification loop does on its own). */
  const NOT_YET_ROWED = {
  };

  for (const code of Object.keys(MESSAGES)) {
    if (NOT_EMITTED.has(code)) {
      assert.ok(!emitted.has(code),
        code + ' is emitted now. Give it a row in site/spec/upload-validation.md ' +
        'and take it out of NOT_EMITTED.');
      assert.ok(!rows.has(code),
        code + ' has a spec row, but nothing emits it. Remove the row, or wire ' +
        'up the code and take it out of NOT_EMITTED.');
      continue;
    }
    if (code in NOT_YET_ROWED) {
      assert.ok(!rows.has(code),
        code + ' now has a spec row in this worktree. Drop it from NOT_YET_ROWED; ' +
        'the branch must have merged.');
      continue;
    }
    assert.ok(rows.has(code),
      code + ' is in the MESSAGES catalogue with no row in ' +
      'site/spec/upload-validation.md. Add the row.');
  }

  for (const code of rows) {
    assert.ok(code in MESSAGES,
      code + ' has a row in site/spec/upload-validation.md but is not in the ' +
      'MESSAGES catalogue. Remove the row, or add the message.');
  }

  /* WHAT THE PARITY ABOVE CANNOT SEE, stated here rather than left as a silent
     limit. `err()` is NOT the app's only emission shape. Some codes inline their
     own `code:` at the json(...) call, bypass the catalogue entirely, and
     therefore appear on neither side of the diff above — so the two assertions
     above could pass forever while the app answers with codes no document
     describes. Recorded in
     record/findings/a-catalogued-error-code-with-no-caller-is-not-a-documentation-gap.md,
     which found them from the harder side: enumerating what the app EMITS is a
     different instruction from enumerating the catalogue, and only the second
     one is easy to run.

     THE COUNT LIVES IN THE LIST BELOW AND NOWHERE IN THIS PROSE, which is not
     fussiness. This paragraph said "five" and the one below it said "a sixth
     would fail here". ROW-60 then added E_NOT_PRODUCTION, making it six and
     seven, and both sentences went false — in the test whose entire job is
     stopping a comment from going false, inside the same session that wrote it,
     found by a critic rather than by the test. A number written in prose beside
     a list it describes has no mechanism keeping the two equal. The list does
     not need the prose to restate it.

     Whether these should get catalogue entries and rows is a routing decision
     and not this test's to make. What this test does refuse is the set growing
     by one more in silence: a new bypass code fails here and forces the decision
     to be taken deliberately. */
  const BYPASS_CATALOGUE = new Set([
    'E_NO_CONSENT',        // subscribe.mjs, 400
    'E_BAD_ADDRESS',       // subscribe.mjs, 422
    'E_SUBSCRIBE_FAILED',  // subscribe.mjs, 502
    'E_NOT_SCHEDULED',     // sweep.mjs, 403
    'E_SWEEP_FAILED',      // sweep.mjs, 200
    'E_NOT_PRODUCTION',    // sweep.mjs, 403
    /* recount.mjs follows sweep.mjs's convention to the letter: the same two
       guards, the same two inlined refusal codes above (which it shares by
       name rather than by a third copy), and one failure code of its own
       emitted at 200 for the same reason E_SWEEP_FAILED is. ROW-42's open
       routing question covers it with the rest. */
    'E_RECOUNT_FAILED',    // recount.mjs, 200

    /* PH-507: upload.mjs, 422, the Jev gate's 'refuse' disposition. Inlined
       rather than routed through err()/MESSAGES deliberately: MESSAGES is a
       normative catalogue and this message's wording has not been approved
       by anyone with standing to approve it (Raffael has ruled on the
       cut-off and the disposition switch, not on owner-facing copy — see
       record/proposals/jev-gate-disposition-options-2026-09-17.md). Routing
       it through err() now would lock in provisional wording in a table
       other code treats as settled. `JEV_DISPOSITION` defaults to 'off', so
       nothing emits this code until Raffael also picks a disposition other
       than 'off' and the wording is settled at the same time — the two
       decisions belong together, not one made to satisfy this test. */
    'E_JEV_REFUSED',       // upload.mjs, 422

    /* PH-507: check-hold.mjs and hold-email.mjs, the hold disposition's own
       owner-facing endpoints. Same reasoning as E_JEV_REFUSED immediately
       above and the same author of that reasoning: this wording is mine,
       has not been reviewed by anyone with standing over owner-facing copy,
       and JEV_DISPOSITION defaults to 'off' with HOLD_ALERT_TO unset, so
       none of these four is reachable in production today. Route through
       err()/MESSAGES once the hold disposition itself is reviewed and
       switched on, not before, for the identical reason E_JEV_REFUSED is
       not routed yet: locking provisional wording into a catalogue other
       code treats as settled is worse than a deliberate, documented bypass. */
    'E_HOLD_CHECK_FAILED', // check-hold.mjs, 400
    'E_HOLD_CHECK_LIMIT',  // check-hold.mjs, 429
    'E_HOLD_EMAIL_FAILED', // hold-email.mjs, 400
    'E_HOLD_EMAIL_LIMIT',  // hold-email.mjs, 429
    'E_HELD',              // upload.mjs, 202: the hold response, ok:false; assets/share.js draws the hold screen for it (PH-518) and falls back to a plain refusal with the server's own message when the page has no #held section
  ]);

  /* E_NOT_PRODUCTION was added by ROW-60, and this assertion is why it is here
     rather than in MESSAGES. The test above caught it within a minute of it
     being written, named the two options, and made choosing one deliberate.
     It follows the convention of the file that emits it: sweep.mjs already
     inlines its other two codes, and the spec table tracks the err() catalogue,
     which sweep does not use. Whether all four sweep and subscribe codes should
     be catalogued is ROW-42's open routing question, not something to settle by
     making this one an exception. */

  const inlined = new Set(
    (source.match(/code:\s*'E_[A-Z0-9_]+'/g) || []).map(m => m.match(/E_[A-Z0-9_]+/)[0])
  );
  for (const code of inlined) {
    assert.ok(BYPASS_CATALOGUE.has(code) || code in MESSAGES,
      code + ' is emitted with an inline `code:` that bypasses the MESSAGES ' +
      'catalogue, so no parity check can see it. Route it through err() and ' +
      'give it a spec row, or add it to BYPASS_CATALOGUE deliberately.');
  }
  for (const code of BYPASS_CATALOGUE) {
    assert.ok(inlined.has(code),
      code + ' is listed in BYPASS_CATALOGUE but nothing inlines it any more. ' +
      'Remove it from the list so the list keeps meaning something.');
  }
});

test('the browser has exactly one copy of the canonical host, and it matches', async () => {
  /* The browser cannot import lib/_site.mjs: these are classic scripts and a
     bundler for one string is not a trade worth making. So there are two copies
     of this host in the app, server and browser, and this asserts they match.

     TWO IS THE FLOOR AND THREE WAS THE RISK. card.js declared its own literal
     and manage.js built the same /p/ link from window.location.origin, so the
     naive fix would have made three. Both now read the one declaration in
     site.js, which every page loading either of them loads first, including
     tools/card-demo.html. Checked here because a reader adding a third would
     have no other signal. */
  const read = async (f) => readFile(new URL('../assets/' + f, import.meta.url), 'utf8');

  const site = await read('site.js');
  const m = site.match(/window\.PHAEACIA_CANONICAL = '([^']+)'/);
  assert.ok(m, 'site.js no longer declares PHAEACIA_CANONICAL where this test looks');
  assert.equal(m[1], render.CANONICAL,
    'the browser and lib/_site.mjs disagree about the canonical host');

  for (const f of ['card.js', 'manage.js', 'share.js', 'send.js', 'delete.js']) {
    const js = await read(f).catch(() => '');
    /* NO HOST LITERAL AT ALL, not merely no copy of the canonical one. A critic
       replaced card.js's use site with a third host — neither the canonical
       string nor the address bar — and every suite stayed green, because this
       asserted re-declaration and absence and never use. Checking for "not the
       canonical literal" is the same shape of mistake as checking the text
       body for "netlify.app": it guards the example you thought of.

       These five scripts contain zero http(s) literals today, so the honest
       assertion is that they contain none. Any URL they need comes from the
       one declaration in site.js. */
    const hosts = js.match(/https?:\/\/[^\s"'`)]+/g) || [];
    assert.deepEqual(hosts, [],
      f + ' names a host directly (' + hosts.join(', ') + '); read window.PHAEACIA_CANONICAL instead');
    assert.equal(/location\.origin\s*\+\s*'\/p\//.test(js), false,
      f + " builds a /p/ link from the address bar; that is the ROW-63 defect, use window.PHAEACIA_CANONICAL");
  }

  /* site.js must be loaded BEFORE any script that reads the global, or the
     global is undefined at the moment they run. Asserted rather than assumed,
     because script order leaves no trace until a link renders as
     "undefined/p/x" on one page nobody opened.

     THE PAGES ARE DISCOVERED, NOT LISTED. A first version named the three that
     load these scripts today. That list was correct and is the wrong shape: a
     fourth page added next month would not be checked, and its failure is
     invisible until someone renders that particular link. Listing what exists
     today is how the spec table drifted in ROW-42 and how three comments in
     this repo went stale in one evening. */
  const pages = [];
  for (const dir of ['', 'tools/']) {
    const d = new URL('../' + dir, import.meta.url);
    for (const name of await readdir(d)) {
      if (name.endsWith('.html')) pages.push(dir + name);
    }
  }
  assert.ok(pages.length >= 3, 'found almost no pages, so this loop is checking nothing');

  let checked = 0;
  for (const page of pages) {
    const html = await readFile(new URL('../' + page, import.meta.url), 'utf8');
    const deps = ['/assets/card.js', '/assets/manage.js']
      .map(dep => [dep, html.indexOf(dep)]).filter(([, at]) => at >= 0);
    if (!deps.length) continue;
    checked++;

    const at = html.indexOf('/assets/site.js');
    assert.ok(at >= 0,
      page + ' loads a script that reads window.PHAEACIA_CANONICAL but never loads site.js');
    for (const [dep, d] of deps) {
      assert.ok(at < d, page + ' loads ' + dep + ' before site.js, so the global is undefined');
    }
  }
  assert.ok(checked > 0, 'no page loads card.js or manage.js, so this assertion found nothing');
});

/* ── the mark's viewBox, in two spellings ─────────────────────────────────
   assets/card.js restates the tight viewBox as NUMBERS, `{ x, y, w, h }`,
   because it draws the mark on a canvas rather than in an SVG element. Every
   other file in the tree spells it as the string in assets/mark/. That is a
   drift waiting to happen, and it has now happened on two consecutive mark
   revisions: the brand migration substitutes the string form, cannot see the
   numbers, and leaves the new wider blade inside the old frame, which crops it.
   Both times it was caught by a person looking, which is not a mechanism.

   The alternative was to have card.js read the SVG at runtime and derive the
   box. That trades a silent drift for a network request and a new failure mode
   on the success screen, which currently fetches nothing to draw the mark. A
   test costs neither and turns the drift into a red build, so this is the
   mechanism instead. If it fails, the fix is to copy the four numbers out of
   the SVG; it is never to change this test. */
test('card.js and the canonical SVG agree about the mark viewBox', async () => {
  const js = await readFile(new URL('../assets/card.js', import.meta.url), 'utf8');
  const svg = await readFile(new URL('../assets/mark/phaeacia-mark-tight.svg', import.meta.url), 'utf8');

  const nums = js.match(/MARK_VB\s*=\s*\{\s*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+),\s*w:\s*(-?[\d.]+),\s*h:\s*(-?[\d.]+)\s*\}/);
  assert.ok(nums, 'card.js no longer declares MARK_VB in the shape this test reads');
  const box = svg.match(/viewBox="([^"]+)"/);
  assert.ok(box, 'the canonical mark SVG has no viewBox');

  const fromSvg = box[1].trim().split(/\s+/).map(Number);
  const fromJs = nums.slice(1, 5).map(Number);
  assert.deepEqual(fromJs, fromSvg,
    `card.js says [${fromJs}] and assets/mark/phaeacia-mark-tight.svg says [${fromSvg}]. ` +
    'The mark changed and the numeric copy was left behind, so the card draws it in the wrong frame. ' +
    'Copy the four numbers out of the SVG.');

  /* And the path constants, for the same reason: the migration substitutes
     these by string match, so a spelling change here goes unnoticed too.

     All three keys of MARK_D, not two. `join` was left out when this was
     written and every one of them is drawn: marks() builds a Path2D from each
     of shaft, blade and join. It has not bitten because the v1 -> v2 revision
     leaves `join` byte-identical, which is luck and not coverage, and it is the
     same shape as the fill-opacity change riding along on the path comparison
     in build-samples.mjs. If a later revision moves the join and nothing else,
     two of three paths still match and the canvas draws a mark that is wrong
     only where the blade meets the shaft. */
  for (const [name, re] of [['blade', /blade:\s*'([^']+)'/],
                            ['shaft', /shaft:\s*'([^']+)'/],
                            ['join',  /join:\s*'([^']+)'/]]) {
    const inJs = js.match(re);
    assert.ok(inJs, `card.js has no ${name} path in the expected shape`);
    assert.ok(svg.includes(inJs[1]),
      `card.js's ${name} path is not in the canonical SVG. The mark changed under it.`);
  }
});

test('consentTokenIsWriteId agrees with the Python probe table', async () => {
  const { consentTokenIsWriteId, isFilenameToken } = await import('../lib/_validate.mjs');
  const none = new Set();
  for (const [tok, refs, want] of [
    ['email.send', none, true], ['money.transfer', none, true], ['money.send', none, true],
    ['money.transfer', new Set(['money.transfer']), true],
    ['money.csv', none, false], ['money.csv', new Set(['money.csv']), true],
    ['money.ods', none, false], ['money.transfer.csv', none, true], ['money.ledger.csv', none, true],
    ['money.', none, true],
    ['files.read', none, false], ['files.read', new Set(['files.read']), false],
    ['MONEY.transfer', none, true], ['Email.Send', none, true], ['money.OFX', none, false],
  ]) {
    assert.equal(consentTokenIsWriteId(tok, refs), want, `${tok} with refs ${[...refs]}`);
  }
  assert.equal(isFilenameToken('money.csv'), true);
  assert.equal(isFilenameToken('money.transfer'), false);
});

test('gallery: the <option> lists on upload.html and manage.html match _categories.mjs', async () => {
  const { CATEGORIES } = await import('../lib/_categories.mjs');
  for (const page of ['upload.html', 'manage.html']) {
    const html = await readFile(new URL('../' + page, import.meta.url), 'utf8');
    const options = [...html.matchAll(/<option value="([a-z-]+)">([^<]+)<\/option>/g)]
      .map(m => ({ slug: m[1], label: m[2].trim() }));
    assert.deepEqual(options, CATEGORIES.map(c => ({ slug: c.slug, label: c.label })),
      page + ' carries an option list that differs from _categories.mjs (slug, label, order)');
  }
});
const finderFixture = JSON.parse(await readFile(new URL('../../tools/fixtures/secret_candidates.json', import.meta.url), 'utf8'));

test('secret finder: the JavaScript port returns the Python extractor\'s own candidates on all ' + finderFixture.length + ' fixture documents', () => {
  /* The fixture is the measured extractor's (run.frozen.py) output. A change to a pattern, the cap, the
     window, the priority order or the unicode fold that is not a change there fails here. */
  assert.ok(finderFixture.length >= 150);
  const bad = [];
  finderFixture.forEach((f, i) => {
    const got = finder.excerpts(f.text).map(e => ({ line: e.line, excerpt: e.excerpt }));
    if (JSON.stringify(got) !== JSON.stringify(f.candidates)) bad.push(i);
  });
  assert.deepEqual(bad, [], 'documents whose candidates differ from the Python extractor: ' + bad.join(','));
  assert.ok(finderFixture.some(f => f.candidates.length === finder.CAP), 'the fixture no longer exercises the cap');
  assert.ok(finderFixture.some(f => f.candidates.length === 0), 'the fixture no longer has a document with no candidates');
  assert.ok(finderFixture.some(f => /[\u017F\u0131]/.test(f.text)), 'the fixture no longer exercises the unicode lookalikes');
});

test('parity.mjs reads a preflight.py crash as a crash, not as the empty answer', async () => {
  /* parity.mjs compares preflight.py's codes with the site's, and [] is
     the right answer for every clean probe, so reading a traceback's empty
     stdout as [] agreed with a preflight.py that could not start. Each case is
     the status and output Python gives, made by node so this suite still needs
     no Python; execFile's real resolve and reject shapes are what is read. */
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readCodes } = await import('./_preflight-codes.mjs');
  const as = src => promisify(execFile)(process.execPath, ['-e', src]).then(readCodes, readCodes);
  const tb = "process.stderr.write('Traceback (most recent call last):\\n  File \"preflight.py\"\\n" +
             "RuntimeError: boom\\n'); process.exit(1)";

  assert.deepEqual(await as(''), { codes: [] }, 'exit 0, nothing on stdout: accepted');
  assert.deepEqual(await as("process.stdout.write('E_HTML\\r\\nE_UNFILLED\\r\\n'); process.exit(1)"),
                   { codes: ['E_HTML', 'E_UNFILLED'] }, 'exit 1 and codes: refused, CRLF or not');
  assert.match((await as(tb)).crash || '', /exit 1, no code, RuntimeError: boom$/,
               'an uncaught exception is exit 1 with nothing on stdout, and is not []');
  assert.ok((await as("process.stdout.write('E_HTML\\n'); " + tb)).crash,
            'a code on stdout does not excuse a traceback after it');
  assert.ok((await as("process.stderr.write('Usage: preflight.py [--codes] PASSPORT.md\\n'); process.exit(2)")).crash,
            'exit 2 is the usage line, not an answer');
  assert.ok((await as("process.stdout.write('E_HTML\\n')")).crash, 'exit 0 with a code is neither answer');
  assert.ok((await as('process.kill(process.pid)')).crash,
            'killed: a signal on POSIX, and exit 1 with no code on Windows');
  assert.match((await promisify(execFile)('no-such-python3-here', []).then(readCodes, readCodes)).crash || '',
               /ENOENT/, 'an interpreter that is not there');
});
