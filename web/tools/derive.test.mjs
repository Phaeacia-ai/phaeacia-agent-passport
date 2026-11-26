/* lib/_derive.mjs: the money guard and the envelope floor, and the check-16 refusal family
   (what is refused, what is accepted, and that no refusal echoes a stranger).

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/derive.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { derive, validate } from './_helpers.mjs';

/* The envelope floor's JavaScript half, probed on its own merits.

   Until 2026-09-04 parts 2 and 3 of the floor in _derive.mjs had no probe in
   this suite: the only thing that saw them was web/tools/parity.mjs, which
   detects a DISAGREEMENT with tools/validate.py. Delete the guard from both
   languages at once and every suite stayed green. These tests fail when the
   JavaScript guard alone is missing, whatever Python does, which is the
   property a cross-language check cannot have.

   Each probe substitutes one token into one installable consent row of an
   otherwise honest passport and calls the real derive(), so it asserts a
   verdict rather than a branch. The Python twin is tools/run_tests.sh test 15,
   which calls consent_token_is_write_id() directly; the JS unit probe below
   does the same through consentTokenIsWriteId(). */
/* Built from the honest fixture on disk rather than a skeleton written here:
   the first draft of this probe was hand-written, lacked sections 5 and 6, and
   its own control caught it returning E_SECTIONS, which is a refusal for the
   wrong reason. The fixture's `money.csv` row is the cell that gets replaced,
   so the control is the unmodified fixture. */
const FLOOR_FIXTURE = await readFile(
  new URL('../../tools/fixtures/passports/valid_money_filename.md', import.meta.url), 'utf8');
const FLOOR_CELL = 'Read the ledger file (`money.csv`)';
assert.ok(FLOOR_FIXTURE.includes(FLOOR_CELL), 'the probe base fixture moved under this test');
const FLOOR_PROBE = (cell, sec3extra = '') => FLOOR_FIXTURE
  .replace(FLOOR_CELL, cell)
  .replace('    status: declared_only\n', '    status: declared_only\n' + sec3extra);

const floorVerdict = text => {
  const v = validate(text);
  if (v.errors.length) return 'REFUSE:' + v.errors.map(e => e.code).join(',');
  const d = derive(v.front, v.lines);
  return d.error ? 'REFUSE:' + d.error.code : 'ACCEPT';
};

test('the money guard in _derive.mjs refuses an undeclared write id and accepts a filename, on its own', () => {
  /* The control first: the probe body must be accepted with an innocent
     token, or every refusal below is measuring a precondition and not the
     guard. A red result for the wrong reason feels like proof; it is not. */
  assert.equal(floorVerdict(FLOOR_FIXTURE), 'ACCEPT',
    'the probe base fixture itself must derive, or nothing below tests the guard');

  const CASES = [
    ['Move the payout (`money.transfer`)', 'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'an undeclared money id, the ROW-158 hole'],
    ['Pay the invoice (`money.pay`)',      'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'an undeclared money id with another verb'],
    ['Move it (`money.transfer_v2`)',      'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'a money id whose suffix is not an extension'],
    ['Send the digest (`email.send`)',     'REFUSE:E_DERIVE_ENVELOPE_FIXED', 'a fixed write id'],
    ['Read `files.read` then `email.send`', 'REFUSE:E_DERIVE_ENVELOPE_FIXED', 'a write id as the second token'],
    ['Read the ledger (`money.csv`)',      'ACCEPT', 'a backticked filename under the money prefix'],
    ['Read the ledger (`money.ods`)',      'ACCEPT', 'a filename with an extension from the list'],
    ['Read the ledger (`money.CSV`)',      'ACCEPT', 'an upper-case extension'],
    ['Move it (`money.transfer.csv`)',     'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'an id with an extension appended: whole suffix, not last segment'],
    ['Send it (`email.send `)',            'REFUSE:E_DERIVE_ENVELOPE_FIXED', 'a write id with a trailing space inside the backticks: the token is read trimmed'],
    ['Send it (`EMAIL.send`)',             'REFUSE:E_DERIVE_ENVELOPE_FIXED', 'a fixed write id in capitals: ASCII case is folded'],
    ['Move it (`Money.transfer`)',         'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'a money id behind one capital letter'],
    ['Read the ledger (`money.ofx`)',      'ACCEPT', 'a financial interchange format'],
    ['Move it (`m\u043eney.transfer`)',    'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'a Cyrillic o: the prefix test used to compare raw bytes'],
    ['Move it (`mo\u200bney.transfer`)',   'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'a zero-width space inside the word'],
    ['Move it (`money\u2024transfer`)',    'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'a one-dot leader for the dot'],
    ['Read it (`money.csv\ufeff`)',        'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'a BOM after a filename: trim() would have eaten it, strip() would not'],
    ['Read it (`money.csv\u001c`)',        'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'U+001C: strip() would have eaten it, trim() would not'],
    ['Read it (`B\u00fccher.csv`)',        'ACCEPT', 'ROW-167: an honest umlaut in an installable row. This was the documented cost of the old rule and is the point of the new one'],
    ['Read it (`m\u043eney.transfer`)',    'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'and the lookalike in the same position is still refused, which is what stops the line above from being a deletion of the rule'],
    ['Read it ( `money.csv`\t)',           'ACCEPT', 'ASCII blanks around the backticks are outside the token'],
    ['Charge the card`s `email.send`',     'REFUSE:E_DERIVE_ENVELOPE_FIXED', 'a write id behind a stray third backtick: pairing shifted, splitting does not'],
    ['Move the fee (`` `money.transfer` ``)', 'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'a money id inside a double-backtick span'],
    ['Move the fee `` and `money.transfer`', 'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'an empty span shifting the pairing'],
    ['``m\u043eney.transfer``',            'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'a lookalike inside a double-backtick span'],
    ['email.send',                        'REFUSE:E_DERIVE_ENVELOPE_FIXED', 'the bare id as the whole cell, no backticks'],
    ['Read `a.csv` f\u00fcr `b.csv`',      'ACCEPT', 'ROW-167: German prose between two code spans. The one-word carve-out existed only for this case and is gone with the rule that needed it'],
    ['Read `a.csv` f\u00fcr `m\u043eney.transfer`', 'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'and a lookalike in the second span is still refused, WITH German prose beside it, which the carve-out used to exempt'],
    ['Read the ledger (`money.csv`) f\u00fcr Marco', 'ACCEPT', 'non-ASCII prose outside every code span is not read'],
    ['Read `a.csv` und dann `b.csv`',      'ACCEPT', 'multi-word prose between two spans is prose, not a token'],
    ['Read `files.read` and also `email.send`', 'REFUSE:E_DERIVE_ENVELOPE_FIXED', 'the existing second-token fixture shape still refuses on the id, not as opaque'],
  ];
  for (const [cell, want, why] of CASES) {
    assert.equal(floorVerdict(FLOOR_PROBE(cell)), want, `${why}: ${cell}`);
  }

  /* Declared wins over shape: a passport that itself declares money.csv as a
     capability_ref has said it is an id, and the row offering it is a lie. */
  assert.equal(
    floorVerdict(FLOOR_PROBE('Read the ledger (`money.csv`)',
      '  - capability_ref: money.csv\n    status: declared_only\n')),
    'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'a declared money token is an id whatever its shape');

  /* The money message never carries the suffix, which is a stranger's text:
     vocabulary.md says record money.* and not the id it arrived as. */
  const v = validate(FLOOR_PROBE('Move it (`money.transfer_acct_99`)'));
  const d = derive(v.front, v.lines);
  assert.equal(d.error.code, 'E_DERIVE_ENVELOPE_TOKEN');
  assert.ok(d.error.message.includes('`money.*`'), d.error.message);
  assert.ok(!d.error.message.includes('transfer_acct_99'), 'the suffix reached the message');
  assert.ok(d.error.message.includes('says "yes"'), 'the column as written is echoed');

  /* The opaque message never carries the lookalike: every backticked span
     in the echoed row is collapsed, since a money regex cannot match a
     Cyrillic o. And a capitalised money token collapses too. */
  const o = derive(...(x => [x.front, x.lines])(validate(FLOOR_PROBE('Move it (`m\u043eney.transfer`) now'))));
  assert.equal(o.error.code, 'E_DERIVE_ENVELOPE_OPAQUE');
  assert.ok(!o.error.message.includes('\u043e'), 'the lookalike reached the message');
  assert.ok(o.error.message.includes('Move it (`...`) now'), o.error.message);
  const o2 = derive(...(x => [x.front, x.lines])(validate(FLOOR_PROBE('Move it ``m\u043eney.transfer`` now'))));
  assert.equal(o2.error.code, 'E_DERIVE_ENVELOPE_OPAQUE');
  assert.ok(!o2.error.message.includes('\u043e'), 'the lookalike reached the message through a double-backtick span');
  const u = derive(...(x => [x.front, x.lines])(validate(FLOOR_PROBE('Move it (`MONEY.transfer_acct_99`)'))));
  assert.equal(u.error.code, 'E_DERIVE_ENVELOPE_TOKEN');
  assert.ok(!u.error.message.includes('transfer_acct_99'), 'the suffix reached the message behind a capital');
});

/* ROW-168: the write-id scan reads all five cells of an installable row, and
   reads each WORD of a multi-word span inside them.

   Two defects, one build. The guard read the Capability cell only, while the
   fifth cell travels verbatim as `installable_label` into inline(), which
   renders backticks as <code>: `yes (via `money.transfer`)` put the id in
   front of the reader in monospace beside a Granted stamp, on a row both
   gates called clean. And the opaque rule's one-word carve-out exempts a
   multi-word inner segment while the fixed-id test compared the WHOLE
   segment, so `email.send now` was read by neither rule.

   The Python twin is tools/run_tests.sh test 15's CELL_PROBES. These call the
   real derive(), so a mutation that reverts the JavaScript alone goes red
   here by name, which is the property parity.mjs cannot have. */
const FLOOR_ROW = '| Read the ledger file (`money.csv`) | there is nothing to summarise otherwise | required | the agent has no input | yes |';
assert.ok(FLOOR_FIXTURE.includes(FLOOR_ROW), 'the probe base row moved under this test');
const FLOOR_CELLS = ['Read the ledger file (`money.csv`)', 'there is nothing to summarise otherwise',
  'required', 'the agent has no input', 'yes'];
/* One cell replaced, the other four left honest, so a refusal names the cell
   and not the passport. */
const FLOOR_ONE_CELL = (idx, text, tail) => {
  const c = [...FLOOR_CELLS];
  /* `tail` overrides the Installable cell, so a probe can combine an
     offending token in one cell with a hostile ECHO in another. Added for the
     echo invariant; every existing caller passes two arguments and is
     unaffected. */
  if (tail !== undefined && idx !== 4) c[4] = tail;
  c[idx] = text;
  return FLOOR_FIXTURE.replace(FLOOR_ROW, '| ' + c.join(' | ') + ' |');
};

test('the envelope floor reads all five cells of an installable row, not the Capability cell alone', () => {
  assert.equal(floorVerdict(FLOOR_FIXTURE), 'ACCEPT',
    'the probe base fixture itself must derive, or nothing below tests the guard');
  /* The control that matters most: replacing a cell with honest text of the
     same shape must still ACCEPT, or the five refusals below are measuring
     the substitution rather than the guard. */
  for (let i = 0; i < 5; i++) {
    assert.equal(floorVerdict(FLOOR_ONE_CELL(i, FLOOR_CELLS[i])), 'ACCEPT',
      `substituting cell ${i} with its own text must change nothing`);
  }

  const CELLS = [
    [0, 'Mail it (`email.send`)',        'REFUSE:E_DERIVE_ENVELOPE_FIXED',       'the Capability cell, which was the only one read'],
    [1, 'the original used `email.send`', 'REFUSE:E_DERIVE_ENVELOPE_FIXED',      'the Why cell'],
    [2, 'required (`email.send`)',       'REFUSE:E_DERIVE_ENVELOPE_FIXED',       'the Required cell'],
    [3, 'nothing calls `email.send`',    'REFUSE:E_DERIVE_ENVELOPE_FIXED',       'the If-you-skip cell'],
    [4, 'yes (via `email.send`)',        'REFUSE:E_DERIVE_ENVELOPE_FIXED',       'the Installable cell, which renders as <code> beside Granted'],
    [4, 'yes (via `money.transfer`)',    'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'a money id in the Installable cell'],
    [1, 'it used `money.transfer`',      'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'a money id in the Why cell'],
  ];
  for (const [idx, text, want, why] of CELLS) {
    assert.equal(floorVerdict(FLOOR_ONE_CELL(idx, text)), want, `${why}: cell ${idx} = ${text}`);
  }

  /* The word scan, inside backticks, in every cell. `money.transfer daily`
     was refused all along because the money test is a prefix; the three
     fixed ids were compared by equality and walked past. That asymmetry is
     what hid this for a day. */
  const WORDS = [
    [0, 'Mail it (`email.send now`)',      'REFUSE:E_DERIVE_ENVELOPE_FIXED',       'a fixed id with a word after it in one span'],
    [0, 'Do it (`use ext.write here`)',    'REFUSE:E_DERIVE_ENVELOPE_FIXED',       'a fixed id with a word on each side'],
    [0, 'Do it (`run msg.send now`)',      'REFUSE:E_DERIVE_ENVELOPE_FIXED',       'msg.send, the class the ticket never named'],
    [0, 'Move it (`run money.transfer now`)', 'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'a money id with a word on each side'],
    [0, 'Move it (`money.transfer daily`)', 'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'the prefix case, refused before this build too'],
    [4, 'yes (via `run money.transfer now`)', 'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'both defects at once'],
    [0, 'Mail it (`use email.send, here`)', 'REFUSE:E_DERIVE_ENVELOPE_FIXED',      'sentence punctuation trimmed off the word'],
    [0, 'Mail it (`(email.send)`)',        'REFUSE:E_DERIVE_ENVELOPE_FIXED',       'brackets around the whole segment'],
    [0, 'Mail it (`email.send.`)',         'REFUSE:E_DERIVE_ENVELOPE_FIXED',       'a full stop after the id: the dot is an id character, so the trim is anchored on alphanumerics'],
  ];
  for (const [idx, text, want, why] of WORDS) {
    assert.equal(floorVerdict(FLOOR_ONE_CELL(idx, text)), want, `${why}: cell ${idx} = ${text}`);
  }

  /* What must NOT be read, or the guard refuses honest passports. */
  const OPEN = [
    [1, 'the original used email.send and this one does not', 'ACCEPT', 'BARE PROSE naming an id is the prose-to-id gap (ROW-165), open by design'],
    [0, 'Read the ledger (`money.csv`) und dann weiter',      'ACCEPT', 'non-ASCII prose outside every span'],
    [0, 'Kontoführung: `files.read` genügt',             'ACCEPT', 'PINS the inner flag: ONE-WORD non-ASCII prose on both sides of a code span. Dropping `inner` opacity-tests it and refuses the row for its language. Prose containing a space would not see the mutant, because the opaque rule carves that out anyway'],
    [0, '`files.read` Übersicht',                        'ACCEPT', 'the same pin with the prose on one side only'],
    [0, 'Read it (`Bücher.csv`)',                        'ACCEPT', 'ROW-167: the honest German filename passes now'],
    [0, 'Read it (`mоney.transfer`)',                    'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'the control for the line above: a LOOKALIKE is still refused, so that pass is not the opaque rule having been deleted'],
    [1, 'it used `mоney.transfer`',                      'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'ROW-167 runs the narrow rule in the Why cell too, which ROW-168 left open by design'],
    [4, 'yes (via `mоney.transfer`)',                    'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'and in the Installable cell: the named first act of this build'],
    [0, 'Move it (`run mоney.transfer now`)',            'REFUSE:E_DERIVE_ENVELOPE_OPAQUE', 'and with a word beside it inside one span, which no carve-out exempts any more'],
    [1, 'Buchhaltungsübersicht, mit Zahlen',             'ACCEPT', 'the Why cell is free prose and is NOT opacity-tested'],
    [3, 'die Übersicht fehlt',                           'ACCEPT', 'the If-you-skip cell is free prose'],
    [4, 'yes (siehe `Zahlungsübersicht.csv`)',           'ACCEPT', 'an honest non-ASCII filename outside the Capability cell'],
    [0, 'Read `a.csv` und dann `b.csv`',                      'ACCEPT', 'multi-word prose between two spans'],
    [0, 'Read the ledger (`money.csv,`)',                     'REFUSE:E_DERIVE_ENVELOPE_TOKEN', 'the stated cost: a comma INSIDE the backticks keeps the raw reading, in which csv, is not a listed extension'],
  ];
  for (const [idx, text, want, why] of OPEN) {
    assert.equal(floorVerdict(FLOOR_ONE_CELL(idx, text)), want, `${why}: cell ${idx} = ${text}`);
  }

  /* A row marked no is never read, in any of its five cells. */
  const NO_ROW = '| Mail the digest to the subscriber list (`email.send`) | that is what the digest is for | declared only | it goes to you and to nobody else | no, declared only |';
  assert.ok(FLOOR_FIXTURE.includes(NO_ROW), 'the declared-only row moved under this test');
  assert.equal(
    floorVerdict(FLOOR_FIXTURE.replace(NO_ROW,
      '| Move it (`money.transfer`) | it used `email.send` | declared only | nothing calls `ext.write` | no, declared only (`mоney.transfer`) |')),
    'ACCEPT', 'a row marked no is never read, lookalikes and every cell included');
});

test('the echo invariant: no check-16 refusal echoes a stranger, whatever its code', async () => {
  /* The MECHANISM, not a fourth probe. Five of the seven mutants the ROW-168
     critic left alive, and one of my own that survived run 4, reduce to a
     single sentence: nothing in either suite read a refusal message. Probes
     close those instances; the next message written with a leaky fill goes
     unnoticed the same way, and a probe per message is not a mechanism.

     Three properties over every check-16 refusal, whatever code it carries:

       1. NO NON-ASCII. In this family the offending token is by definition a
          lookalike or an invisible, so a non-ASCII character in the message
          could not have arrived any other way than by echo. That premise is
          what makes the property assertable and it is also a rule for every
          message written here afterwards: see the paragraph above err() in
          lib/_validate.mjs. Delete the character, not this assertion.
       2. NO UNBOUNDED RUN. A passport may be 262144 bytes, most of it in one
          cell.
       3. NO PREFIX ID WITH ITS SUFFIX, driven off DECLARED_ONLY_PREFIX rather
          than off the string, so it says what the code says.

     Property 3 is deliberately NOT generalised to the four fixed ids: a fixed
     id has no suffix, it is the whole id, and echoing it is correct, which is
     why safeRefLabel passes it through. What must never travel is the
     unbounded stranger-authored text after a PREFIX. The type assertion below
     fails when the prefix constant stops being one string, which forces this
     test to grow when a second prefix arrives instead of going quietly
     incomplete. Same move as ALLOWED_RULE_DIVERGENCE in tools/parity.mjs,
     where an allowance entry that stops being true fails the build: a guard
     that invalidates itself when its own premise changes. Twin:
     tools/run_tests.sh. */
  const { DECLARED_ONLY_PREFIX, foldAscii } = await import('../lib/_validate.mjs');
  assert.equal(typeof DECLARED_ONLY_PREFIX, 'string',
    'DECLARED_ONLY_PREFIX is no longer one string: extend the echo invariant to every prefix');

  const PAYLOADS = [
    ['Move it (`mоney.transfer`)',                        'о'],
    ['Move it (`mоney.transfer_acct_99_IBAN_CH93`)',      'acct_99'],
    ['Move it (mоney.transfer)',                          'о'],
    ['Mail it (`email.se​nd`)',                           '​'],
    ['Mail it (`email.send`) ' + 'A'.repeat(400),              'A'.repeat(300)],
    ['Move it (`money.transfer_acct_99_IBAN_CH93_0076`)',      'acct_99'],
    ['Move it (money.transfer_acct_99_IBAN_CH93_0076)',        'acct_99'],
    /* No forbidden literal: in cells 0 and 4 this text is echoed on purpose
       and property 1 is what decides. In cells 1 to 3 property 1 refuses it. */
    ['Mail it (`email.send`) Привет', null],
    ['Move it (``mоney.transfer`` now)',                  'о'],
    /* THE SECOND PAYLOAD FOR EACH THIN PROPERTY. A critic measured how many
       of each property's evaluations could possibly have failed and found the
       loose half of property 1 resting on ONE line of this list and property
       2 on one other. Deleting the Привет line left property 1 write-id
       asserted over an empty set and both suites stayed green, the same 167
       passing. These two exist so no single deletion can empty a property,
       and the census below fails rather than going quiet. Twin:
       tools/run_tests.sh. */
    ['Mail it (`msg.send`) Übersicht 売上', null],
    ['Move it (`mоney.transfer`) ' + 'Q'.repeat(400),          'Q'.repeat(300)],
  ];
  /* A SECOND DIMENSION, and a two-arm mutation run is what showed it was
     missing. With one cell varied at a time no case ever combined an
     offending token in one cell with a bare money suffix in an ECHOED cell,
     so property 3 was asserted over messages that never carried a money
     token, and the mutation removing the bare-money collapse survived the
     invariant on its own. A payload matrix that varies one dimension proves
     closure over one dimension: the record's standing lesson about sweep
     tables, arriving in a new instrument. Twin: tools/run_tests.sh. */
  /* CASE IS THE THIRD DIMENSION. The second (TAILS) was added because the
     matrix varied one cell at a time and property 3 was green over an empty
     set. This one because every payload was lower case while the guard folds
     ASCII case on purpose. Same shape, one axis over. */
  const TAILS = ['yes',
                 'yes, see money.transfer_acct_99_IBAN_CH93_0076_2011_6238',
                 'yes, see MONEY.transfer_acct_99_IBAN_CH93_0076_2011_6238'];
  const seen = new Set();
  /* WHAT EACH PROPERTY ACTUALLY GOT TO LOOK AT. The census below counts the
     cells reached, which is coverage of the INPUT, while every property is a
     statement about the OUTPUT. Nothing counted how often a property had an
     output worth looking at, so a property asserted over an empty set is
     green forever and looks like coverage. Measured against this file by the
     ROW-167 critic: of 105 refusals, property 2 could fail on 15 and every
     one of those came from a single payload line. TEETH records, per
     property, how many cases could have failed it and which payloads
     supplied them; the floor after the loop wants two payloads and five
     cases, because one of either is a line somebody deletes while the suite
     keeps printing green. Twin: tools/run_tests.sh. */
  const TEETH_FLOOR = 5;
  const TEETH = new Map([
    ['property 1, opaque', []], ['property 1, write-id', []],
    ['property 2, long run', []], ['property 3, prefix suffix', []],
    ['forbidden literal', []],
  ]);
  const tooth = (name, yes, text) => { if (yes) TEETH.get(name).push(text); };
  for (let cell = 0; cell < 5; cell++) {
   for (const tail of TAILS) {
    for (const [text, forbidden] of PAYLOADS) {
      /* Two cells carry a controlled vocabulary that other checks read
         first. Without these prefixes the row is refused by the Installable
         wording rule or the required/optional one, and the probe measures a
         check that is not this one. The census below is what caught it. */
      const body = FLOOR_ONE_CELL(cell,
        cell === 4 ? 'yes, ' + text : cell === 2 ? 'required, ' + text : text,
        tail);
      const v = validate(body);
      if (v.errors.length) continue;          // refused before derive(): not this family
      const d = derive(v.front, v.lines);
      if (!d.error || !String(d.error.code).startsWith('E_DERIVE_ENVELOPE')) continue;
      seen.add(cell);
      const msg = d.error.message;
      if (forbidden !== null) assert.ok(!msg.includes(forbidden),
        `echo invariant, cell ${cell}: the message carried back ${JSON.stringify(String(forbidden).slice(0, 24))}`);
      /* PROPERTY 1, and its scope is chosen by the CODE rather than applied
         flat, because the flat version is false and the invariant found that
         out on its own first run.

           OPAQUE:  pure ASCII. The offending token is by definition a
             lookalike or an invisible and both echoes are span-collapsed for
             exactly that reason, so any non-ASCII here came through a hole in
             a collapse.
           TOKEN / FIXED: the offending token is plain ASCII by definition, and
             these messages echo the Capability and Installable cells as the
             passport wrote them ON PURPOSE, so an author recognises their own
             row. A German row must survive that. What must not survive is
             non-ASCII from a cell that is never shown: cells 1, 2 and 3 are
             read by the scan and not echoed, so a character from one of them
             in the message is a leak.

         POLICY is keyed by code and the census below fails on a code that is
         not in it, so a new refusal in this family cannot be added without
         someone deciding which echo policy it follows. */
      const POLICY = {
        E_DERIVE_ENVELOPE_OPAQUE: 'ascii-only',
        E_DERIVE_ENVELOPE_TOKEN:  'echoes-cells-0-and-4',
        E_DERIVE_ENVELOPE_FIXED:  'echoes-cells-0-and-4',
        E_DERIVE_ENVELOPE:        'no-echo',
      };
      const policy = POLICY[d.error.code];
      assert.ok(policy,
        d.error.code + ' is a check-16 refusal with no entry in POLICY. Decide which ' +
        'echo policy it follows and add it, or the echo invariant is silent about it.');
      const cellsOf = body.split('\n').filter(l => l.trim().startsWith('|'));
      const row = cellsOf.find(l => l.includes(text)) || '';
      const parts = row.split('|').map(x => x.trim());
      const echoed = policy === 'echoes-cells-0-and-4'
        ? (parts[1] || '') + (parts[5] || '') : '';
      /* An opportunity, per property, is a case where the property COULD have
         failed: the opaque half of property 1 on every message that echoes no
         cell, its loose half only when a cell that is never echoed carries a
         non-ASCII character, property 2 only when some cell is long enough to
         hold a 260-character run, property 3 only when the folded message
         contains the prefix at all, and the forbidden literal only when the
         payload declares one. */
      const neverEchoed = (parts[2] || '') + (parts[3] || '') + (parts[4] || '');
      /* THE OPAQUE TOOTH IS NOT "the message echoes no cell", and the first
         version of it was. Property 1 strict says no non-ASCII in the message,
         and a message can only carry non-ASCII if the passport contains some.
         The opaque rule has two halves and the control-character half fires on
         pure ASCII, so a refusal from a control character was counted as an
         opportunity that could not fail. Measured by the ROW-167 critic: swap
         the five homoglyph payloads for control-character ones, a natural edit
         rather than a contrived one, and the floor certified 75 cases from 5
         payloads of which zero could fail while the mutation the property
         exists to catch went unreported. Twin: tools/run_tests.sh. */
      const rowText = parts.slice(1, 6).join('');
      const rowHasNonAscii = [...rowText].some(c => c.codePointAt(0) > 0x7f);
      tooth(echoed === '' ? 'property 1, opaque' : 'property 1, write-id',
            echoed === '' ? rowHasNonAscii
                          : [...neverEchoed].some(c => c.codePointAt(0) > 0x7f),
            text);
      /* AND THE OTHER TWO ASK ABOUT AN ECHOED CELL rather than any cell: a
         long cell the message never echoes cannot detect an uncapped echo and
         a money suffix in one cannot leak. Both overstated by about 2.5x,
         measured by replaying the matrix against the mutation each property
         guards. Neither was wrong and neither fell below the floor; a floor
         raised on inflated numbers is raised against nothing. */
      const echoedCells = [parts[1] || '', parts[5] || ''];
      tooth('property 2, long run',
            echoedCells.some(src => src.length >= 260), text);
      const foldEchoed = foldAscii(echoedCells.join(' '));
      let leakable = false;
      for (let k = 0; ;) {
        k = foldEchoed.indexOf(DECLARED_ONLY_PREFIX, k);
        if (k < 0) break;
        k += DECLARED_ONLY_PREFIX.length;
        const next = foldEchoed[k] === undefined ? '' : foldEchoed[k];
        if (next !== '' && next !== ' ' && next !== '*') { leakable = true; break; }
      }
      tooth('property 3, prefix suffix', leakable, text);
      tooth('forbidden literal', forbidden !== null, text);
      const badChars = [...new Set([...msg].filter(
        c => c.codePointAt(0) > 0x7f && !echoed.includes(c)))];
      assert.equal(badChars.length, 0,
        `echo invariant, cell ${cell}: ${d.error.code} contains ` +
        `${JSON.stringify(badChars.join(''))}, which is not in a cell this message echoes on purpose`);
      /* Property 2 is about how much OF THE PASSPORT reaches the message,
         not about how long the message is. The first spelling measured runs
         of the message between backticks and failed on the template's own
         prose, which is a fixed string nobody wrote at us. ECHO_CAP is 200,
         so 260 leaves room for a cap plus its ellipsis and still refuses a
         cell echoed whole. */
      const cells = body.split('\n').find(l => l.includes(text) && l.startsWith('|'));
      for (const src of (cells || '').split('|')) {
        for (let i = 0; i + 260 <= src.length; i++) {
          assert.ok(!msg.includes(src.slice(i, i + 260)),
            `echo invariant, cell ${cell}: 260 characters of a passport cell reached the message`);
        }
      }
      /* FOLDED THROUGH THE GATE'S OWN FUNCTION, not through toLowerCase()
         and not left raw. The first spelling was case-SENSITIVE while the
         collapse it guards is case-INSENSITIVE, so MONEY.transfer_acct_99 in
         a message was invisible to the scan that exists to find exactly
         that, and a two-sided mutation dropping the /i survived all three
         checks while leaking an IBAN. Found by the ROW-167 critic. foldAscii
         is length-preserving, so the indices still address msg. */
      const folded = foldAscii(msg);
      let i = 0;
      for (;;) {
        i = folded.indexOf(DECLARED_ONLY_PREFIX, i);
        if (i < 0) break;
        i += DECLARED_ONLY_PREFIX.length;
        assert.equal(msg[i], '*',
          `echo invariant, cell ${cell}: a prefix id kept its suffix: ` +
          JSON.stringify(msg.slice(i - 8, i + 24)));
      }
    }
   }
  }
  /* The census, which is what keeps this a mechanism. A cell the payloads
     never reach is a cell this says nothing about, and saying nothing while
     looking like coverage is the failure the whole file exists to catch. */
  assert.equal([...seen].sort().join(','), '0,1,2,3,4',
    'the echo invariant reached only cells ' + [...seen].sort().join(',') + ': extend PAYLOADS');
  /* AND EVERY PROPERTY HAS TO HAVE HAD SOMETHING TO LOOK AT, from more than
     one payload. Not a quality bar: the failure this closes is one line of
     PAYLOADS being deleted or edited into harmlessness while the suite keeps
     printing 167 pass, 0 fail. */
  for (const [prop, hits] of TEETH) {
    const payloads = new Set(hits).size;
    assert.ok(payloads >= 2 && hits.length >= TEETH_FLOOR,
      `the echo invariant asserted ${prop} over ${hits.length} case(s) from ` +
      `${payloads} payload(s), and the floor is ${TEETH_FLOOR} from 2: it ` +
      'would be green because nothing could have failed it, not because ' +
      'nothing did. Add a payload that gives it a case.');
  }
});

test('a lookalike inside a DOUBLE-backticked span is refused and never echoed', () => {
  /* Why the opaque echo collapses from the FIRST backtick to the LAST rather
     than per span. A mutation reverting it to a per-span collapse survived
     every check in mutation run 4, and the Python docstring says an assertion
     caught exactly that when the function was first written the narrow way.
     No such assertion existed, so the docstring had been standing in for a
     test. In ``Move it ``x`` now`` the per-span reading pairs the two EMPTY
     spans and leaves the lookalike standing between them. */
  const v = validate(FLOOR_ONE_CELL(0, 'Move it (``mоney.transfer`` now)'));
  assert.equal(v.errors.length, 0, 'the probe must reach derive()');
  const d = derive(v.front, v.lines);
  assert.ok(d.error, 'a lookalike inside a double-backticked span was accepted');
  assert.ok(!d.error.message.includes('о'),
    'the per-span reading pairs the empty backticks and hands the message the lookalike between them');
});

test('a refusal message names the escape hatch in the four prose cells and not in the Capability cell', () => {
  /* ROW-168 widened the scan from one cell to five, and the message written
     for the Capability cell became WRONG ADVICE in the other four: an author
     whose Why cell honestly names what some other agent did was told to mark
     their own row declared-only, which is a lie about their agent. That is
     the failure this build split the cells to avoid one cell over. HAL asked
     for the escape hatch to be named in the message rather than left for the
     author to find. Twin: tools/run_tests.sh. */
  const ESCAPE = 'before the first backtick in the cell or after the last';
  const msg = text => {
    const v = validate(text);
    if (v.errors.length) return v.errors.map(e => e.message).join(' | ');
    const d = derive(v.front, v.lines);
    assert.ok(d.error, 'the probe row must be refused or it is testing nothing');
    return d.error.message;
  };
  for (const [idx, name] of [[1, 'Why'], [3, 'If-you-skip'], [4, 'Installable']]) {
    for (const id of ['email.send', 'money.transfer']) {
      const text = idx === 4 ? `yes (via \`${id}\`)` : `it used \`${id}\``;
      assert.ok(msg(FLOOR_ONE_CELL(idx, text)).includes(ESCAPE),
        `the ${name} cell refusal for ${id} names no escape hatch`);
    }
  }
  assert.ok(!msg(FLOOR_ONE_CELL(0, 'Mail it (`email.send`)')).includes(ESCAPE),
    'the Capability cell names what the row installs, so there is no sentence to move the id into');
});

test('the escape hatch the message names actually works', () => {
  /* The half a message probe cannot assert on its own, and the sentence has
     been wrong TWICE. "Without backticks" alone is false, because a whole
     SEGMENT is tested wherever it lies. And "a word with other words beside
     it, outside backticks, is not read" is also false: a stretch BETWEEN two
     code spans is bounded by a backtick on both sides, so it is inner and its
     words are scanned. A critic built that case; all seven original spellings
     had at most one code span in the cell, which is why the class was
     invisible to them. The sentence now names a POSITION. Twin:
     tools/run_tests.sh, and the measured table beside PROSE_FIX. */
  for (const [text, want, why] of [
    ['the original used email.send to mail the digest', 'ACCEPT', 'a word of prose inside a sentence'],
    ['the original used email.send, this one does not', 'ACCEPT', 'the same with punctuation'],
    ['it used email.send `see docs`',                   'ACCEPT', 'prose beside a code span'],
    ['the original used money.transfer nightly',        'ACCEPT', 'the money id in a sentence'],
    ['email.send',                                      'REFUSE', 'the id alone as the whole cell'],
    ['email.send `see docs`',                           'REFUSE', 'the id alone BEFORE the first backtick'],
    ['`see docs` email.send',                           'REFUSE', 'the id alone AFTER the last backtick'],
    ['the previous agent used email.send before we read `inbox.csv`', 'ACCEPT', 'prose BEFORE the first backtick, which the message now names'],
    ['we read `inbox.csv` and the previous agent used email.send',  'ACCEPT', 'prose AFTER the last backtick, the other named position'],
    ['the previous agent used email.send; we read `a.csv`, `b.csv` and `c.csv`', 'ACCEPT', 'the same before THREE spans'],
    ['we read `a.csv`, `b.csv` and `c.csv`; the previous agent used email.send', 'ACCEPT', 'and after three spans'],
    ['the one it replaces did money.transfer; reads `a.csv` and `b.csv`', 'ACCEPT', 'the money id in the same safe position'],
    ['we read `inbox.csv` and it used email.send to mail `d.html`', 'REFUSE', 'BETWEEN two spans: the critic counterexample to the first escape hatch'],
    ['the old cron in `sync.sh` did email.send nightly, ours writes `out.csv`', 'REFUSE', 'the same shape, and an ordinary Why cell'],
    ['reads `a.csv`, the one it replaces did money.transfer, writes `b.csv`', 'REFUSE', 'and with the money id'],
  ]) {
    const got = floorVerdict(FLOOR_ONE_CELL(1, text));
    if (want === 'ACCEPT') assert.equal(got, 'ACCEPT', why);
    else assert.notEqual(got, 'ACCEPT', why);
  }
});

test('the opaque message never echoes the lookalike it exists to withhold', () => {
  /* A critic mutation reverting the span collapse to the identity survived
     every check in both languages, because no test read the message. The
     whole reason the collapse exists is that the offending token is by
     definition a lookalike or an invisible. о is the Cyrillic o. */
  const v = validate(FLOOR_ONE_CELL(0, 'Move it (`mоney.transfer`)'));
  assert.equal(v.errors.length, 0, 'the probe must reach derive()');
  const d = derive(v.front, v.lines);
  assert.equal(d.error && d.error.code, 'E_DERIVE_ENVELOPE_OPAQUE');
  assert.ok(!d.error.message.includes('о'),
    'the opaque message carried the Cyrillic o back to the reader');
});

test('an honest non-English installable row still passes with the one-word carve-out gone', () => {
  /* The carve-out existed to stop exactly these being refused, and a critic
     showed its protection was pinned on the JavaScript side only: dropping
     it in Python alone passed all three suites while flipping the first line
     from ACCEPT to REFUSE. ROW-167 removes it outright and lets the narrow
     lookalike rule carry the protection, so the protection needs its own
     pins on both sides. Twin: tools/run_tests.sh. */
  for (const cap of ['Read `a.csv` und dann `b.csv`',
                     'Liest die `Zahlungsübersicht lesen` Datei',
                     'Lit le `relevé mensuel` chaque matin',
                     '売上 (`売上.csv`) を読む']) {
    assert.equal(floorVerdict(FLOOR_ONE_CELL(0, cap)), 'ACCEPT',
      'an honest non-English installable row was refused: ' + cap);
  }
});

/* DO NOT DELETE THIS AS SUPERSEDED BY THE ECHO INVARIANT. That test's comment
   says a probe per message is not a mechanism, which is true and is not a
   reason to remove this one. Measured by the ROW-167 critic: with the
   invariant's bounding property made vacuous, reverting clipEcho to the
   identity in both languages was caught by THIS probe and not by the
   invariant. The invariant is the mechanism, this is the backstop, and a
   backstop earns its keep exactly when the mechanism has quietly stopped
   looking at anything. */
test('a refusal echo is bounded in length and collapses a money token with no backticks', () => {
  /* Found by the ROW-168 critic, after the same leak had been fixed for
     BACKTICKED money tokens only. Both span collapses worked on backticked
     text, so an UNbackticked money id in the same cell walked through into an
     endpoint error; and nothing clipped the field, while a passport may be
     262144 bytes with most of it in one cell. Twin: tools/run_tests.sh. */
  const SUFFIX = 'money.transfer_acct_99_IBAN_CH93_0076_2011_6238_5295_7';
  const msg = text => {
    const v = validate(text);
    if (v.errors.length) return v.errors.map(e => e.message).join(' | ');
    const d = derive(v.front, v.lines);
    assert.ok(d.error, 'the probe row must be refused or it is testing nothing');
    return d.error.message;
  };
  const withIns = (cap, ins) => FLOOR_ONE_CELL(0, cap).replace(
    '| ' + 'the agent has no input' + ' | yes |',
    '| the agent has no input | ' + ins + ' |');

  const opaque = msg(withIns('Move it (`mоney.transfer`)', 'yes, see ' + SUFFIX));
  assert.ok(!opaque.includes('acct_99'), 'a bare money id reached the opaque message: ' + opaque);
  const token = msg(withIns('Mail it (`email.send`)', 'yes, but never ' + SUFFIX));
  assert.ok(!token.includes('acct_99'), 'a bare money id reached the fixed-id message: ' + token);
  const longCap = msg(FLOOR_ONE_CELL(0, 'Mail it (`email.send`) ' + 'A'.repeat(300)));
  assert.ok(!longCap.includes('A'.repeat(210)), 'the echoed row is not capped');
  const longIns = msg(withIns('Move it (`mоney.transfer`)', 'yes ' + 'Q'.repeat(300)));
  assert.ok(!longIns.includes('Q'.repeat(210)), 'the echoed column is not capped');
});

test('a TAB inside a code span separates words for the id scan', () => {
  /* The id scan splits on anything outside printable ASCII. A mutation
     narrowing that to a single space survived every check in both languages
     and two-sided, because no fixture put a tab in a span in a cell with no
     opaque rule behind it. Found by the ROW-168 critic. */
  for (const [idx, name] of [[1, 'Why'], [3, 'If-you-skip'], [4, 'Installable']]) {
    const text = idx === 4 ? 'yes (via `run\temail.send\tdaily`)'
                           : 'it used `run\temail.send\tdaily`';
    assert.notEqual(floorVerdict(FLOOR_ONE_CELL(idx, text)), 'ACCEPT',
      `a tab-separated write id in the ${name} cell`);
  }
});

test('the five-cell refusal names the column and never echoes a money suffix', () => {
  /* The CAPABILITY cell is echoed whichever cell offended, so a stranger's
     money suffix in cell 4 never reaches the message that safeRefLabel()
     exists to keep it out of, and the column name says where to look. */
  const v = validate(FLOOR_ONE_CELL(4, 'yes (via `run money.transfer_acct_99 now`)'));
  const d = derive(v.front, v.lines);
  assert.equal(d.error.code, 'E_DERIVE_ENVELOPE_TOKEN');
  assert.ok(!d.error.message.includes('transfer_acct_99'), 'the suffix reached the message from cell 4');
  assert.ok(d.error.message.includes('Installable in v0.1 column'), d.error.message);
  assert.ok(d.error.message.includes('Read the ledger file'), 'the Capability cell is what names the row');
  /* And the collapse fires on a span CONTAINING a money token, not only one
     that starts with it, which is what the word scan made possible. */
  const w = validate(FLOOR_ONE_CELL(0, 'Move it (`run money.transfer_acct_99 now`)'));
  const dw = derive(w.front, w.lines);
  assert.equal(dw.error.code, 'E_DERIVE_ENVELOPE_TOKEN');
  assert.ok(!dw.error.message.includes('transfer_acct_99'), 'the suffix reached the message from a multi-word span');
  assert.ok(dw.error.message.includes('`money.*`'), dw.error.message);
  assert.ok(dw.error.message.includes('Capability column'), dw.error.message);
});

test('the narrow opaque rule refuses a lookalike and accepts an honest non-ASCII token', async () => {
  /* ROW-167. Twin of the OPAQUE probes in tools/run_tests.sh test 15. Every
     case is a PAIR: the honest token passes and the lookalike in the same
     position refuses, because a probe asserting only the passes would go
     green if the rule were deleted. */
  const { consentTokenIsOpaque, wildcardMatches, consentCellCodeRuns, opaqueReading,
          consentCellWriteId, consentCellOpaqueWord } = await import('../lib/_validate.mjs');
  const CASES = [
    ['mоney.transfer', true], ['money․transfer', true],
    ['money．transfer', true], ['money.trans​fer', true],
    ['money.csv﻿', true], ['emаil.send', true],
    ['email.se​nd', true], ['ext.wrіte', true],
    ['money.csv', true], ['money.csv', true],
    ['\u{1d452}mail.send', true], ['mоney.csv', true],
    ['MONEY.trans​fer', true],
    ['Zahlungsübersicht.csv', false], ['naïve.json', false],
    ['メモ/notes.md', false], ['2026–Q1.csv', false],
    ['Bücher.csv', false], ['für', false],
    ['Buchhaltungsübersicht', false], ['money.csv', false],
    ['email.send', false], ['money.transfer', false], ['', false],
    /* NINE SCRIPTS, every one REFUSED until wildcardMatches was made to
       require an anchor. It compared each position as "equal OR non-ASCII",
       so any six consecutive non-ASCII characters matched the money prefix at
       every position, and ROW-167 was refusing more languages in five cells
       than the rule it replaced refused in one. Its own justification, that a
       narrow rule costs no language anything, was false. The honest cases in
       the original table all contained ASCII: the subject was never in front
       of the check. Twin: tools/run_tests.sh. */
    ['Приложение.csv', false], ['プロジェクト.csv', false],
    ['προϋπολογισμός', false], ['ملفاتالحساب.csv', false],
    ['תקציבשנתי.csv', false], ['รายงานประจำปี.csv', false],
    ['बजटरिपोर्ट.csv', false],
    /* Korean, and the case that survived the FIRST anchor: its full stop sat
       in position 5 and matched, so the anchor has to be a letter or digit. */
    ['메모장기록.csv', false],
    ['账单明细记录.csv', false], ['账单.csv', false], ['Отчет2026.csv', false],
    ['売上レポート', false], ['сообщение', false],
    /* THE STATED RESIDUAL of requiring an anchor, pinned so anyone narrowing
       it further sees what they are buying. A token with no ASCII letter or
       digit surviving in the compared region is not a lookalike, which is
       right: this rule exists for a token that reads AS THE ID to a person,
       and fullwidth characters visibly are not the ASCII ones. */
    ['ｅｍａｉｌ．ｓｅｎｄ', false], ['ｍｏｎｅｙ．transfer', false],
    /* ROW-172, PINNED OPEN. Not costs argued down, a hole, and this probe is
       here so it stays a tracked one. Every character is in Unicode's own
       confusables data and renders at normal width: U+217F SMALL ROMAN NUMERAL
       ONE THOUSAND is drawn as a lowercase m, U+0578 ARMENIAN SMALL LETTER VO
       as an n. The money case is the cheap one, because the prefix test reads
       six characters and the account suffix stays in plain ASCII. Built by the
       ROW-167 critic. When ROW-172 lands these flip to true. */
    ['ⅿоոеу․transfer_acct_99', false], ['еⅿаⅰⅼ․ѕеոⅾ', false],
  ];
  for (const [tok, want] of CASES) {
    assert.equal(consentTokenIsOpaque(tok), want, JSON.stringify(tok));
  }
  /* THE OPACITY SCAN TRIMS TOO, and until the ROW-167 critic it did not. The
     id scan trims with idCore and carries no lookalike test; this scan carried
     the lookalike test and no trim. So a lookalike with ordinary sentence
     punctuation on either end was read by NEITHER, reached a Granted stamp
     through both gates, and had been refused by the printable-ASCII rule
     ROW-167 replaced. Two scans each carrying half of one reading. */
  for (const tok of ['emаil.send.', 'emаil.send,', '(emаil.send)',
                     '(mоney.transfer)', 'emаil.send', 'mоney.transfer.']) {
    assert.notEqual(opaqueReading(tok), null,
      'a lookalike with sentence punctuation is read by neither scan: ' + tok);
  }
  /* The control in the other direction: trimming must not INVENT a lookalike. */
  for (const tok of ['(Приложение.csv)', 'Bücher.csv,', '(2026–Q1.csv)']) {
    assert.equal(opaqueReading(tok), null,
      'trimming turned an honest filename into a lookalike: ' + tok);
  }
  /* A lookalike outside the Basic Multilingual Plane is ONE codepoint and TWO
     UTF-16 units. Indexing or .length here instead of Array.from() makes the
     length test disagree with the Python twin on exactly the input somebody
     chose for being unusual. */
  assert.equal(wildcardMatches(Array.from('\u{1d452}mail.send'), 'email.send'), true);
  assert.equal(wildcardMatches(Array.from('mоney.'), 'money.'), true);
  assert.equal(wildcardMatches(Array.from('monex.'), 'money.'), false);
  assert.equal(wildcardMatches(Array.from('money'), 'money.'), false);

  /* The RUN reading, found by this build's critic: the renderer pairs
     backticks and emits one <code> per pair, so two ADJACENT spans render as
     one unbroken run of monospace. */
  assert.deepEqual(consentCellCodeRuns('`a``b`'), ['ab']);
  assert.deepEqual(consentCellCodeRuns('`a` `b`'), ['a', 'b']);
  assert.deepEqual(consentCellCodeRuns('`a` and `b`'), ['a', 'b']);
  assert.deepEqual(consentCellCodeRuns('no backticks'), []);
  const RUNS = [
    ['Mail it (`email.``send`)', 'email.send'],
    ['Mail it (`email``.send`)', 'email.send'],
    ['Mail it (`email.se``nd`)', 'email.send'],
    ['Do it (`ext.``write`)', 'ext.write'],
    ['Mail it (`email.send now`)', 'email.send'],
    ['Read `a.csv` and `b.csv`', null],
    ['Read `a.csv` `b.csv`', null],
    ['Read it (`Zahlungs``übersicht.csv`)', null],
  ];
  for (const [cell, want] of RUNS) {
    assert.equal(consentCellWriteId(cell, new Set()), want, cell);
  }
  assert.notEqual(consentCellOpaqueWord('Move it (`mо``ney.transfer`)'), null,
    'a lookalike split across two adjacent spans');
  assert.equal(consentCellOpaqueWord('Read it (`Zahlungs``übersicht.csv`)'), null,
    'an honest German filename split the same way');
});

test('idCore trims the ends and never the interior', async () => {
  const { idCore, consentCellWriteId } = await import('../lib/_validate.mjs');
  /* A lookalike or a zero-width space INSIDE a word must survive to the
     opaque test, which is the test built for it. Trimming the interior would
     turn an honest German filename into an id. Twin of test 15's id_core
     probes in tools/run_tests.sh. */
  const CASES = [
    ['email.send', 'email.send'], ['(email.send)', 'email.send'],
    ['email.send,', 'email.send'], ['email.send.', 'email.send'],
    ['“email.send”', 'email.send'],
    ['money.transfer#1', 'money.transfer#1'],
    ['...', ''], ['()', ''], ['', ''],
    ['Zahlungsübersicht.csv', 'Zahlungsübersicht.csv'],
    ['mоney.transfer', 'mоney.transfer'],
  ];
  for (const [word, want] of CASES) assert.equal(idCore(word), want, word);
  /* The union, not the trim alone: `money.` is a write id as written by the
     prefix test, and its core `money` is not, so testing only the core would
     have LOOSENED the guard. */
  assert.equal(consentCellWriteId('`money.`', new Set()), 'money.', 'the bare prefix stays refused');
  assert.equal(consentCellWriteId('`email.send now`', new Set()), 'email.send', 'the word is named, not the span');
  assert.equal(consentCellWriteId('`money.transfer daily`', new Set()), 'money.transfer', 'the word is named, not the four-word segment');
  assert.equal(consentCellWriteId('the original used email.send', new Set()), null, 'bare prose is not read');
});

test('derive() sets ref from a trimmed, folded token and never from a filename-shaped money token', () => {
  /* The ref rule and the guard read the same token the same way, or one
     passport derives two records. A critic reverted the ref rule to the old
     `startsWith('money.')` and this suite stayed green; and with the raw
     group in place of the trimmed one, `money.csv ` stored ref "money.csv "
     here and no ref in passport-to-page.py. */
  const rec = text => { const v = validate(text); assert.equal(v.errors.length, 0); const d = derive(v.front, v.lines); assert.equal(d.error, undefined); return d.record; };
  assert.equal(rec(FLOOR_FIXTURE).needs[0].ref, undefined, 'money.csv is a filename and sets no ref');
  assert.equal(rec(FLOOR_PROBE('Read the ledger (`money.csv `)')).needs[0].ref, undefined, 'a padded filename sets no ref');
  assert.equal(rec(FLOOR_PROBE('Read them (`Files.Read `)')).needs[0].ref, 'files.read', 'a padded, capitalised vocabulary id is stored as the id it is');
  const declared = FLOOR_PROBE('Read them (`files.read`)').replace(
    'Mail the digest to the subscriber list (`email.send`) | that is what the digest is for | declared only | it goes to you and to nobody else | no, declared only',
    'Move it (`money.transfer`) | the original paid | declared only | you pay | no, declared only');
  assert.equal(rec(declared).needs[1].ref, 'money.transfer', 'an honest declared-only money row keeps its ref');
});

test('a row marked no is never read for opacity or for a write id', () => {
  /* The opaque rule and the id rule read installable rows only. A critic
     removed the installable guard from the opaque branch and nothing went
     red: an honest declared-only row that backticks a filename with an
     umlaut, or names the write id it declares, must pass, and did, with no
     probe saying so. */
  const declaredRow = cell => FLOOR_FIXTURE.replace(
    'Mail the digest to the subscriber list (`email.send`) | that is what the digest is for | declared only | it goes to you and to nobody else | no, declared only',
    cell + ' | the original did this | declared only | nothing | no, declared only');
  assert.equal(floorVerdict(declaredRow('Mail it (`email.send`)')), 'ACCEPT', 'a declared-only row naming its own write id');
  assert.equal(floorVerdict(declaredRow('Read (`B\u00fccher.csv`)')), 'ACCEPT', 'a declared-only row with a non-ASCII backticked filename');
  assert.equal(floorVerdict(declaredRow('Move it (`m\u043eney.transfer`)')), 'ACCEPT', 'a declared-only row is not read for opacity');
});

test('part 3 of the floor in _derive.mjs refuses a declared write id with no declared-only row, on its own', () => {
  const body = FLOOR_FIXTURE
    .replace('Mail the digest to the subscriber list (`email.send`)', 'Mail the digest to the subscriber list')
    .replace('| no, declared only |', '| yes |');
  assert.ok(!body.includes('| no, declared only |'), 'the mutation did not take');
  assert.equal(floorVerdict(body), 'REFUSE:E_DERIVE_ENVELOPE',
    'section 3 declares email.send and every row says it installs, with no backtick for part 2 to see');
});

test('a declared-only id found only on an inputs: entry gets E_DERIVE_ENVELOPE_INPUT, not the bare code', () => {
  /* Spec §6.3, ruled by HAL 2026-09-08: the Bateman shape (a declared-only
     write id that surfaces only on an input, never in the capabilities:
     block, with no consent row at all) is its own code, named for its own
     fix, because the old message ("put a declared-only row back in the
     table") asks an owner who just told the write-consent gate no and
     deleted that exact row to reassert the thing she just denied. */
  const inputOnly = FLOOR_FIXTURE
    .replace(
      'capabilities:\n  - capability_ref: files.read\n    status: used\n  - capability_ref: email.send\n    status: declared_only',
      'inputs:\n  - what: a list of things to mail\n    capability_ref: email.send\n    access: open\n\ncapabilities:\n  - capability_ref: files.read\n    status: used'
    )
    .replace(/\n\| Mail the digest to the subscriber list \(`email\.send`\)[^\n]*\|\n/, '\n');
  assert.ok(!inputOnly.includes('status: declared_only'), 'the mutation removed the only declared-only block entry');
  assert.ok(inputOnly.includes('inputs:'), 'the mutation added an inputs: block');
  const v = validate(inputOnly);
  assert.equal(v.errors.length, 0, 'the mutated passport must validate clean, or this is not testing derive()');
  const d = derive(v.front, v.lines);
  assert.equal(d.error && d.error.code, 'E_DERIVE_ENVELOPE_INPUT',
    'a declared-only id on an input alone, nowhere in the capabilities: block, is the sibling code');
  assert.match(d.error.message, /email\.send/, '{refs} names the offending id');

  /* The block case wins when an id is in both places (still E_DERIVE_ENVELOPE,
     not the input sibling), because a block entry carries the passport's own
     status statement. `status: declared_only`, not `status: used`: a critic
     on this branch caught the first version of this fixture using `used`,
     which the envelope floor's part 1 (E_ENVELOPE_FLOOR, a declared-only ref
     whose status is not declared_only) refuses before derive() is ever
     reached — the fixture never tested the branch it claimed to. */
  const both = inputOnly.replace(
    'capabilities:\n  - capability_ref: files.read\n    status: used',
    'capabilities:\n  - capability_ref: files.read\n    status: used\n  - capability_ref: email.send\n    status: declared_only'
  );
  const vb = validate(both);
  assert.equal(vb.errors.length, 0,
    'status: declared_only must validate clean (status: used, the first version of this fixture, failed earlier at E_ENVELOPE_FLOOR and never reached this assertion)');
  const db = derive(vb.front, vb.lines);
  assert.equal(db.error && db.error.code, 'E_DERIVE_ENVELOPE',
    'the same id also declared in the capabilities: block gets the bare code, not the input sibling, even though inputOnly already removed the only no-row');
});

test('a declared-only id found in NEITHER place gets the bare code, not the input sibling', () => {
  /* Refuted claim, caught by a critic: the first version of the branch in
     _derive.mjs tested "not in the capabilities: block", which is also true
     of an id that is not on an input either — under `output:`, say. Spec
     §6.3 is explicit this shape gets the bare E_DERIVE_ENVELOPE. Needs its
     own consent row kept (unlike the input-only fixture above) so the floor
     actually reaches the arithmetic check with declaresWrite true and no
     no-row satisfying it from elsewhere. */
  const neitherPlace = FLOOR_FIXTURE
    .replace(
      '  - capability_ref: files.read\n    status: used\n  - capability_ref: email.send\n    status: declared_only',
      '  - capability_ref: files.read\n    status: used'
    )
    .replace(/\n\| Mail the digest to the subscriber list \(`email\.send`\)[^\n]*\|\n/, '\n')
    .replace('```\n\n## 4. Golden examples', 'output:\n  format: text\n  capability_ref: email.send\n```\n\n## 4. Golden examples');
  assert.ok(!neitherPlace.includes('status: declared_only'), 'the mutation removed the only declared-only block entry');
  assert.ok(neitherPlace.includes('output:'), 'the mutation added an output: block carrying the id');
  const v = validate(neitherPlace);
  assert.equal(v.errors.length, 0, 'the mutated passport must validate clean, or this is not testing derive()');
  const d = derive(v.front, v.lines);
  assert.equal(d.error && d.error.code, 'E_DERIVE_ENVELOPE',
    'an id under output: is in neither the capabilities: block nor an inputs: entry, so it is the bare code');
});
