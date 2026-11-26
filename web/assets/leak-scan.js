/* A client-side, browser-only backstop for what Path W's own self-redaction
   misses, for /upload only. Built 2026-09-15 on Raffael's ruling (via HAL)
   after gemini-2.5-flash put a real planted name ("Declan") and an income
   figure ("£340,000") into a capture_path: browser passport that the
   validator still passed: record/findings/unscored-series-516c57b-eight-
   runs-gave-five-passports-at-temperature-zero-flash-leaked-a-name-and-the-
   income-figure-2026-09-15.md.

   WHAT THIS IS NOT. It is not the validator, it is not a refusal, and it
   sends nothing anywhere: share.js calls scan() on the same text already
   sitting in the page before Publish is ever pressed, and nothing here
   touches fetch. Two rules from site/spec/create-page.md still govern the
   actual publish path unchanged: the client performs no PUBLISHING
   validation beyond the size ceiling, and there is exactly one validator,
   on the server. This module never blocks a publish on its own; it only
   asks the owner to look and tick, same shape as the existing owner-review
   checkbox in the gate. Raffael can reject any one category (his own words
   named name/place/money/key; the email check and the tick-to-confirm step
   are HAL's additions on top) and it comes out without touching the rest,
   which is why the five checks below are five separate functions rather
   than one pattern.

   WHAT IT IS. A curated-list-and-regex heuristic, not a named-entity
   recognizer. It will miss real names it has never heard of and it will
   occasionally flag an ordinary word that happens to double as one (a
   fixture agent whose whole job is reporting grant amounts will get a LOT
   of money hits — that is expected and reported, not hidden: HAL asked for
   the false-positive count on real fixtures precisely to learn whether this
   reads or walls). "Looks like" is the honest word for every category here,
   and the UI must keep saying that rather than "is". */
(function (root) {
  'use strict';

  /* ── only for a browser-path passport, and only before it publishes ──
     capture_path has exactly two spec values, `file` or `browser`
     (spec/passport-0.1.md). Anything else — missing, malformed, `file` —
     returns active:false, so a capture_path: file upload sees nothing here,
     same as before this file existed. */
  function getCapturePath(text) {
    /* A round-2 critic caught an earlier version of this comment claiming
       tools/validate.py:615 strips leading whitespace before it parses
       frontmatter, and that this file had to match that leniency. That is
       false: line 615 is inside clip_echo(), an unrelated helper that
       truncates text for error messages. The real parser,
       parse_frontmatter() at validate.py:1088, requires lines[0] to equal
       "---" exactly, no trim, matching _validate.mjs's own
       `lines[0] !== '---'` check — so the server REFUSES a paste with
       leading blank lines or whitespace before the fence (E_FRONTMATTER),
       it does not accept one.
       The `.replace(/^\s+/, '')` below is kept anyway, but only as a
       leniency in this scanner, not server parity: a copy out of a chat
       window commonly carries leading blank lines, and without the trim
       this file returned active:false and warned about nothing for a body
       the server would in fact refuse outright. Treat this as "warn on a
       paste the server would reject too", never as this file agreeing
       with, or relaxing, what the server accepts. */
    var fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || '').replace(/^\s+/, ''));
    if (!fm) return null;
    /* A round-3 critic built a one-character counterexample against the
       version of this that used to live here (`"?([A-Za-z_-]+)"?`,
       exec()'d once): `capture_path: 'browser'` (single quotes) matched
       nothing at all, so a passport both tools/validate.py and
       lib/_validate.mjs accept and read as capture_path: browser got
       active:false and zero warnings out of this scanner — proved against
       the real s4-b-flash-ew1 fixture, where it took all 20 warnings
       (including the planted Declan/£340,000 lines) to 0. A second,
       independent counterexample: a repeated `capture_path:` key, where
       this used to take the FIRST match but both validators build a flat
       key→value mapping, so a later `capture_path:` line always wins
       there. Both validators strip a symmetric leading/trailing quote of
       EITHER kind after trimming whitespace (validate.py:1141,
       _validate.mjs:1054-56) and keep the last assignment for a repeated
       key (plain object/dict assignment, last write wins).

       A round-4 critic then broke the `/gm` fix that followed from that:
       JS `^`/`$` under the `m` flag treat U+2028 LINE SEPARATOR, U+2029
       PARAGRAPH SEPARATOR and a lone CR as line breaks, same as `\n` —
       but neither validator does. Both split ONLY on `\n`
       (`tools/validate.py:1088` is `text.split("\n")`, and
       `lib/_validate.mjs` normalises `\r\n`→`\n` then splits on `\n`), so
       a line like `note:<U+2028>capture_path: file` is ONE physical line
       to both validators — key `note`, value the literal text
       `capture_path: file` — while the real `capture_path: browser` line
       earlier in the block still governs. Under `/gm` this scanner read
       it as TWO virtual lines and took the fake `capture_path: file` as
       the last, and therefore winning, match: active:false, 0 hits, on a
       passport both validators still PASS as capture_path: browser.
       Proved the same way, on the same real fixture: 20 warnings to 0.

       Fixed by matching how the validators actually split text, not by
       trusting `^`/`$` to agree with that split: `\n` only, each physical
       line tested on its own with no `m` flag (so `^`/`$` on a lone-line
       string mean "the whole string", and `.` still won't cross an
       embedded U+2028/U+2029/CR that line may itself contain — exactly
       why `note:<U+2028>capture_path: file` no longer matches the
       capture_path pattern at all: it fails to match `^capture_path:`
       because the line's first five characters are `note:`, not because
       of anything happening at the U+2028). */
    var fmLines = String(fm[1]).split('\n');
    var lineRe = /^capture_path:\s*(.+?)\s*$/;
    var v = null;
    for (var i = 0; i < fmLines.length; i++) {
      var lm = lineRe.exec(fmLines[i]);
      if (lm) v = lm[1];
    }
    if (v === null) return null;
    if (v.length >= 2 && (v.charAt(0) === '"' || v.charAt(0) === "'") && v.charAt(v.length - 1) === v.charAt(0)) {
      v = v.slice(1, -1);
    }
    return v || null;
  }

  /* ── category: email ───────────────────────────────────────────────
     Identical pattern to tools/scrub.py's EMAIL rule (server-side, a
     different language and a different job — that one strips known
     credential-adjacent shapes before capture ships; this one is a second,
     independent look at whatever made it into the pasted body anyway). Kept
     byte-for-byte comparable on purpose: an email address is an email
     address in both places. */
  var EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/;

  function findEmail(line) {
    return EMAIL_RE.test(line);
  }

  /* ── category: key or token ────────────────────────────────────────
     The vendor-prefix patterns are ports of tools/scrub.py's named
     credential rules (ANTHROPIC_KEY, OPENAI_KEY, AWS_KEY, GITHUB_TOKEN,
     GOOGLE_KEY, SLACK_TOKEN, SENDGRID_KEY): a real key is a real key
     wherever it turns up, and scrub.py already earned this exact shape
     through the fixture corpus its own comments describe. This is a
     narrower read than scrub.py's full PASSWORD_ASSIGN / CREDENTIAL_ASSIGN
     rules (which carry a whole essay on why), not a re-implementation of
     them: a generic "key: value"/"token: value" line is added as one more
     coarse net, because this module's job is a visible warning an owner
     reads, not a byte-parity guarantee with the server scrubber. */
  var KEY_PATTERNS = [
    /\bsk-ant-[A-Za-z0-9-]{10,}\b/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/,
    /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
    /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*\S{6,}/i
  ];

  function findKey(line) {
    for (var i = 0; i < KEY_PATTERNS.length; i++) {
      if (KEY_PATTERNS[i].test(line)) return true;
    }
    return false;
  }

  /* ── category: money ───────────────────────────────────────────────
     A symbol or a currency code/word next to a number. Deliberately loose:
     a passport that reports grant sizes for a living will trip this a lot,
     and that is the honest answer to "does the warning read or wall",
     not a defect to regex around. */
  var MONEY_RE = new RegExp(
    '(?:[£$€]|CHF|USD|GBP|EUR)\\s?\\d[\\d,]*(?:\\.\\d+)?\\b' +
    '|\\b\\d[\\d,]*(?:\\.\\d+)?\\s?(?:GBP|USD|EUR|CHF|pounds?|dollars?|euros?|francs?)\\b',
    'i'
  );

  function findMoney(line) {
    return MONEY_RE.test(line);
  }

  /* ── category: place ───────────────────────────────────────────────
     Two nets. A short list of major real-world places (would catch "the
     owner is in Zurich"), and a suffix heuristic for the descriptive
     geography an interview actually produces ("Lynmere Valley", "Corran
     estuary") — a real operating area is exactly the kind of thing that can
     identify someone, so this net stays wide rather than being narrowed to
     only the list. */
  var KNOWN_PLACES = [
    'London', 'Zurich', 'Geneva', 'Bern', 'Basel', 'Lausanne', 'Lucerne',
    'St. Gallen', 'St Gallen', 'Winterthur', 'Paris', 'Berlin', 'Munich',
    'Vienna', 'Amsterdam', 'Brussels', 'Madrid', 'Barcelona', 'Rome', 'Milan',
    'Dublin', 'Edinburgh', 'Glasgow', 'Manchester', 'Birmingham', 'Leeds',
    'New York', 'Boston', 'Chicago', 'San Francisco', 'Los Angeles', 'Seattle',
    'Toronto', 'Vancouver', 'Montreal', 'Sydney', 'Melbourne', 'Singapore',
    'Tokyo', 'Hong Kong', 'Switzerland', 'Germany', 'France', 'Austria',
    'Ireland', 'Scotland', 'England', 'Wales', 'Portugal', 'Netherlands'
  ];
  var PLACE_SUFFIX_RE = /\b[A-Z][A-Za-z'-]*(?:\s[A-Z][A-Za-z'-]*)?\s(?:[Vv]alley|[Ee]stuary|[Rr]iver|[Cc]ounty|[Ff]jord|[Bb]ay|[Ss]trait|[Cc]anyon|[Dd]elta|[Pp]lateau|[Hh]arbour|[Hh]arbor|[Vv]illage|[Tt]ownship|[Pp]rovince|[Dd]istrict|[Pp]eninsula|[Cc]oast)\b/;

  function findPlace(line) {
    if (PLACE_SUFFIX_RE.test(line)) return true;
    for (var i = 0; i < KNOWN_PLACES.length; i++) {
      if (line.indexOf(KNOWN_PLACES[i]) !== -1) return true;
    }
    return false;
  }

  /* ── category: person's name ───────────────────────────────────────
     A closed list of common given names, checked as a whole word. This is
     the direct answer to the finding this file exists for: "Declan" is on
     it. It is not a name-entity recognizer and it will miss any name it has
     not been told about; it will also occasionally flag an organisation or
     a place that happens to share a common first name, which is accepted
     for a warning the owner reviews. Deliberately excludes month names and
     the handful of common-word names (Will, Mark, Grace, Hope, Faith, Rose,
     May, June, August, Drew, Sunny) that would fire on ordinary prose more
     than on an actual name. */
  var COMMON_NAMES = [
    'Declan', 'James', 'John', 'Robert', 'Michael', 'David', 'William',
    'Richard', 'Thomas', 'Charles', 'Daniel', 'Matthew', 'Anthony', 'Donald',
    'Paul', 'Andrew', 'Joshua', 'Kenneth', 'Kevin', 'Brian', 'George',
    'Edward', 'Ronald', 'Timothy', 'Jason', 'Jeffrey', 'Ryan', 'Jacob',
    'Gary', 'Nicholas', 'Eric', 'Stephen', 'Jonathan', 'Larry', 'Justin',
    'Scott', 'Brandon', 'Benjamin', 'Samuel', 'Gregory', 'Frank', 'Raymond',
    'Alexander', 'Patrick', 'Jack', 'Dennis', 'Jerry', 'Tyler', 'Aaron',
    'Henry', 'Douglas', 'Peter', 'Adam', 'Nathan', 'Zachary', 'Walter',
    'Harold', 'Kyle', 'Carl', 'Arthur', 'Gerald', 'Roger', 'Keith', 'Jeremy',
    'Terry', 'Lawrence', 'Sean', 'Christian', 'Austin', 'Joe', 'Albert',
    'Wayne', 'Ralph', 'Roy', 'Eugene', 'Louis', 'Philip', 'Bobby', 'Liam',
    'Noah', 'Oliver', 'Elijah', 'Lucas', 'Mason', 'Logan', 'Ethan', 'Aiden',
    'Owen', 'Connor', 'Dylan', 'Finn', 'Cameron', 'Ian', 'Callum', 'Ewan',
    'Fraser', 'Angus', 'Rory', 'Niall', 'Cormac', 'Cian', 'Aidan', 'Oisin',
    'Padraig', 'Seamus', 'Eamon', 'Brendan', 'Colm', 'Fergus',
    'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan',
    'Jessica', 'Sarah', 'Karen', 'Nancy', 'Lisa', 'Betty', 'Margaret',
    'Sandra', 'Ashley', 'Kimberly', 'Emily', 'Donna', 'Michelle', 'Carol',
    'Amanda', 'Melissa', 'Deborah', 'Stephanie', 'Rebecca', 'Laura', 'Sharon',
    'Cynthia', 'Kathleen', 'Amy', 'Angela', 'Shirley', 'Anna', 'Brenda',
    'Emma', 'Olivia', 'Sophia', 'Isabella', 'Charlotte', 'Amelia', 'Mia',
    'Evelyn', 'Harper', 'Ella', 'Grace', 'Chloe', 'Victoria', 'Aria',
    'Fatima', 'Aisha', 'Zainab', 'Amina', 'Layla', 'Noor', 'Yasmin',
    'Priya', 'Anika', 'Deepa', 'Sanjay', 'Rahul', 'Amit', 'Wei', 'Jing',
    'Mei', 'Hiroshi', 'Yuki', 'Kenji', 'Siobhan', 'Niamh', 'Aoife', 'Maeve',
    'Orla', 'Ciara', 'Roisin', 'Eilish', 'Bridget'
  ];
  var nameSet = {};
  for (var i = 0; i < COMMON_NAMES.length; i++) nameSet[COMMON_NAMES[i]] = true;

  var CAP_WORD_RE = /\b[A-Z][a-z]+\b/g;

  function findName(line) {
    var words = line.match(CAP_WORD_RE);
    if (!words) return false;
    for (var i = 0; i < words.length; i++) {
      if (nameSet[words[i]]) return true;
    }
    return false;
  }

  /* ── per-line scan, one entry per matching line ──────────────────── */
  var DETECTORS = [
    { key: 'name', label: "a person's name", test: findName },
    { key: 'place', label: 'a place', test: findPlace },
    { key: 'money', label: 'a money amount', test: findMoney },
    { key: 'key', label: 'a key or token', test: findKey },
    { key: 'email', label: 'an email address', test: findEmail }
  ];

  function categoriesFor(line) {
    var cats = [];
    for (var i = 0; i < DETECTORS.length; i++) {
      if (DETECTORS[i].test(line)) cats.push(DETECTORS[i].key);
    }
    return cats;
  }

  /* text -> { active, capturePath, hits: [{ lineNo, line, categories }] }
     active is false for anything other than capture_path: browser, so a
     capture_path: file passport (or one with no frontmatter at all, or
     malformed frontmatter) gets hits: [] and nothing renders. */
  function scan(text) {
    var capturePath = getCapturePath(text);
    if (capturePath !== 'browser') return { active: false, capturePath: capturePath, hits: [] };

    var lines = String(text || '').split(/\r?\n/);
    var hits = [];
    for (var i = 0; i < lines.length; i++) {
      var cats = categoriesFor(lines[i]);
      if (cats.length) hits.push({ lineNo: i + 1, line: lines[i], categories: cats });
    }
    return { active: true, capturePath: capturePath, hits: hits };
  }

  var CATEGORY_LABELS = {};
  DETECTORS.forEach(function (d) { CATEGORY_LABELS[d.key] = d.label; });

  root.PhaeaciaLeakScan = {
    scan: scan,
    getCapturePath: getCapturePath,
    CATEGORY_LABELS: CATEGORY_LABELS,
    /* Exposed for tests only, so a mutation test can call one detector in
       isolation without a private build. Not used by share.js. */
    _detectors: { name: findName, place: findPlace, money: findMoney, key: findKey, email: findEmail }
  };
})(typeof window !== 'undefined' ? window : globalThis);
