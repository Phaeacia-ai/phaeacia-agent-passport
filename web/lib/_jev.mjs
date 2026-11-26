/* PH-507: Jev check, shadow mode plus an optional gate.

   The layer rule, unchanged from shadow mode: the code verdict stands, and Jev
   may add a hold for review but may never clear a code refusal. What changed on
   `backend/ph507-jev-gate` is that this module can now also be READ, not only
   logged, when `JEV_DISPOSITION` says so. `jevFlagged()` and `jevDisposition()`
   below are the only two functions `upload.mjs` may branch on; `shadowCheck()`
   itself still returns nothing shaped as a verdict, on purpose, so inverting the
   layer rule anywhere else in this system still requires editing a call site, not
   toggling something already sitting here disguised as a boolean.

   The two whole-document questions below are copied verbatim from `jev_v3.py`'s
   `gate()` (see `record/reproductions/jev-2026-09-17/jev_v3.py` and
   `record/findings/jev-works-as-a-per-field-verifier-and-a-second-gate-layer-when-code-owns-every-rule-2026-09-17.md`).
   Do not edit the wording without re-running the fixtures that produced the cited
   32/42-caught, 0/24-false numbers; the fixture result is tied to this exact text.
   `unconsented` deliberately carries no `criteria` field below, matching
   `jev_v3.py`'s own `q_doc` exactly: this is not an omission introduced here.

   WHAT THIS DATA CAN AND CANNOT ANSWER. On the shadow-mode branch the call sat
   after `createPassport` succeeded and nowhere else, so every logged row was a
   passport that had already PASSED the code gate and the secret scan AND was
   already public. On this branch the call moves to before `createPassport` --
   required for gating at all, since nothing can be refused once it is already
   public -- but the input set it runs on is unchanged: still only text that has
   already passed every code-level refusal path (`validate()`'s secret scan
   included), never anything the code gate itself refused. The corpus can answer
   "where would this cut-off have held an honest, code-valid passport" and can
   never answer "would Jev have caught something the code gate let through",
   because nothing the gate refused ever reaches this call, on either branch.
   That is the correct trade under the layer rule (Jev may never clear a code
   refusal, so it never needs to see one), not an oversight.

   MOVING THE CALL EARLIER HAS A PRIVACY CONSEQUENCE SHADOW MODE DID NOT HAVE,
   flagged here because this file is where a future reader will look for it.
   In shadow mode, every passport whose text reached TypeSafe was already
   public at the link this endpoint returned -- sending its text externally
   added no exposure a stranger with the URL did not already have. On this
   branch, with any disposition other than 'off', a passport that the code
   gate would have accepted but that Jev then holds or refuses has its full
   text sent to TypeSafe and NEVER becomes public. That is a new category of
   disclosure shadow mode never created, independent of whatever the site
   itself stores (which stays text-free for a refusal either way, matching
   privacy.html:224-229). It exists on this branch in code but is inert while
   `JEV_DISPOSITION` defaults to 'off': nothing sends anything anywhere this
   endpoint was not already going to publish until Raffael picks a
   disposition other than 'off'. See
   record/proposals/jev-gate-disposition-options-2026-09-17.md, and restated
   from 5843e56: privacy.html:398 ("does not change whether a passport is
   accepted") goes false the moment a disposition other than 'off' is live. */

import { mailEnabled, validAddress } from './_email.mjs';
import { excerpts } from './_secretfinder.mjs';

/* PH-507: exported, not a private constant. critic-ph507-shadow-build-fix
   (round 1 of the deploy-failure fix) found that tools/run-endpoint-tests.mjs
   had a hand-typed second copy of this string, with nothing linking the two,
   and proved live that the copies drifting apart -- e.g. this URL gaining a
   query parameter on a future API version -- reproduces the exact class of
   bug that took an afternoon to find on the shadow-mode branch: green on
   every developer machine, red only on Netlify, because TYPESAFE_API_KEY is
   the one variable set there and nowhere any of us developed. Importing this
   constant instead of retyping it closes that class outright: the two
   strings cannot drift because there is only one. See
   record/findings/a-test-that-cannot-fail-anywhere-it-runs-and-fails-only-where-it-ships-2026-09-17.md. */
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

/* The model string Jev has been observed to return for `model: "jev-latest"" as of
   2026-09-17 (record finding above). Compared against every response's own `model`
   field, never assumed. A mismatch is surfaced in the log record (`modelMismatch:
   true`) rather than silently accepted, because a log that never checks this cannot
   tell a moved model from a held one, and a moved model moves the cut-off this
   shadow period exists to find. */
export const EXPECTED_MODEL = 'jev-1.13.0';

/* ~2 seconds. An upload must never fail, or even visibly slow down, because
   TypeSafe is slow or down: this is a shadow check, not a dependency. */
const TIMEOUT_MS = 2000;

/* 64KB. The real response is two floats, a model string and a usage object --
   comfortably under 1KB. This bounds a body that arrives FAST but huge, which
   the timeout above does not catch: a critic reproduced a 256MB '200' response
   completing in well under 2s. Their first RSS figure (process-wide, ~1.4GB)
   was confounded by their own in-process test server; the same critic and a
   second one both re-measured client-side only, with server and client in
   separate processes, and got a consistent ~1.1GB delta for a 256-268MB body
   -- still over Netlify's default 1024MB function memory, so the OOM
   conclusion holds even though the first number quoting it did not survive
   its own re-check. An OOM in the same post-write window the timeout fix
   above exists to close, from a cause the timeout cannot see because nothing
   about it is slow. A second critic additionally confirmed the bound
   survives a gzip-compressed body (undici inflates in chunks, and the reader
   aborts on the first chunk that crosses 64KB post-inflation) and a body
   written in a single large chunk (chunk size is set by the client's socket
   reads, not by how the server writes, so one `res.end()` of any size still
   arrives to this reader in bounded pieces). */
const MAX_BODY_BYTES = 65536;

/* Reads a response body under MAX_BODY_BYTES and parses it as JSON, aborting
   `controller` (which also fails the still-armed timer's job for it) the
   moment the bound is crossed rather than after buffering the rest.

   FAILS CLOSED, DOES NOT FALL BACK TO `res.json()`, if the response carries no
   streaming body. An earlier version fell back to the unbounded `res.json()`
   here, which is exactly the hole this function exists to close: it would
   have been silent on any runtime where the fallback fires. Checked, not
   assumed, before deciding this: `web/package.json` pins `engines.node
   ">=20"`, Netlify provisions a runtime meeting that floor, and Node's own
   `fetch` (undici) has returned a WHATWG `ReadableStream` with a working
   `getReader()` for every response carrying a body since global fetch
   stabilised in Node 18 — confirmed locally (`node --version` and a live
   fetch against a local server) rather than assumed from the spec, and
   confirmed again by a critic on Node 20.20.2, 22.23.2 and 26.8.1 (three
   points spanning the pinned floor to the tip, all agreeing). `res.body` is
   null only for a response with genuinely no body: 204, 205 and 304 measured
   this way, and a HEAD response by the same reasoning (not separately
   measured here). A `200` with `Content-Length: 0` is NOT one of these --
   measured on all three runtimes, its `res.body` is a real stream with a
   working `getReader()`, and it takes the normal path, failing at
   `JSON.parse('')` inside the loop below rather than at the guard here; the
   two land in the same `transport_error` outcome either way, so nothing user
   -visible depended on the earlier, wrong claim that it took this branch. For
   every case that does take this branch, there is nothing to bound and
   nothing to score, so throwing here and letting the outer catch classify it
   as `transport_error` is correct, not merely safe. If a future runtime ever
   lacks a streaming body on a real response, failing closed is the right
   failure: an unaccounted-for OOM window is worse than one more
   `transport_error` in a shadow-mode log nobody depends on. Not verified
   against Netlify's own Linux build, only against macOS/arm64 Node -- the
   WHATWG streams body has been the fetch shape since Node 18 regardless of
   platform, so this is held with high rather than total confidence. */
async function readBoundedJson(res, controller) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    throw new Error('jev response has no streaming body to bound');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        controller.abort();
        throw new Error('jev response body exceeded the size bound');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released on done/abort */ }
  }
  return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'));
}

const Q_DOC = {
  installable: {
    type: 'noul',
    instructions:
      "Does the consent table in this passport mark as installable or granted ('yes') a capability that sends, posts, writes, pays, or otherwise changes something outside the chat?",
    criteria: {
      true: 'A row for an action that changes the world is marked installable, required, or yes.',
      false: 'Every world-changing action is marked declared only / not installable, or there is none.'
    }
  },
  unconsented: {
    type: 'noul',
    instructions:
      'Does the functional spec reference a capability that changes something in the world (send, post, write, pay, transfer) that has no matching row in the consent table?'
  }
};

/* Five distinct outcomes, none of them a bare score of zero for a non-answer.
   'scored' is the only outcome that carries real question scores; the other four
   are facts about why no score exists, and each is a different fact:
     - skipped_no_key      no TYPESAFE_API_KEY at call time (see below: this is
                            also the kill switch)
     - timeout             the ~2s budget elapsed before a response arrived
     - transport_error     fetch itself failed (DNS, TLS, connection reset, ...)
     - http_error          a response arrived with a non-2xx status
     - scored              a response arrived, parsed, and carries both scores */
export const JEV_OUTCOMES = Object.freeze({
  SKIPPED_NO_KEY: 'skipped_no_key',
  TIMEOUT: 'timeout',
  TRANSPORT_ERROR: 'transport_error',
  HTTP_ERROR: 'http_error',
  SCORED: 'scored'
});

/* Call Jev with the two whole-document questions and classify the result into
   exactly one of the five outcomes above. Never throws: every failure path is a
   returned outcome, because this function sits after the real gate has already
   decided to accept, and nothing downstream may fail the upload.

   Kill switch: `process.env.TYPESAFE_API_KEY` is read HERE, inside the function
   body, on every call, never hoisted to module load. That is the kill switch
   condition 7 asks for, and THIS COMMENT USED TO OVERSTATE IT: it said unsetting
   the variable in the Netlify UI "takes effect on the very next invocation with
   no redeploy". It does not. Netlify's docs (build/functions/environment-
   variables, read 2026-10-22): "Environment variables are applied based on the
   values set at the time of deployment... To apply updated environment variable
   values, create a new deploy." So the switch is: unset the variable, THEN create
   a new deploy, and check that the deploy ran. The `ignore` rule in netlify.toml
   can cancel a rebuild of a commit with nothing changed under its paths, and
   Netlify's ignore-builds page documents only build-hook builds as never
   cancelled by it. Reading per call is still right, and it is what lets the
   tests flip the switch, but it is not what makes the switch work.
   It is also the "missing key" skip condition 4 asks for, by the same read: a
   production-only key is absent by design on previews, branch deploys and local
   dev, and that absence and "someone flipped the switch off" are indistinguishable
   on purpose, since both mean the same thing here: do not call Jev. */
export async function shadowCheck(passportText) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return { outcome: JEV_OUTCOMES.SKIPPED_NO_KEY };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  /* THE TIMER STAYS ARMED THROUGH THE BODY READ, NOT ONLY THE HEADERS. A first
     version cleared it in a `finally` attached to a try wrapping only `fetch`,
     which disarms the callback that calls `controller.abort()` the instant
     headers arrive — a response that sends headers and then stalls the body (or
     streams it slowly) was therefore unbounded: `res.json()` ran with no timeout
     left to fire, and a critic reproduced it hanging past 30s against a 2s
     budget, which the file's own 10s serverless-function-timeout comment says
     must never happen on this path. `fetch` and `res.json()` now share ONE try,
     so `clearTimeout` in the shared `finally` only runs once the whole exchange
     (headers AND body) is over, and an abort that lands during the body read
     rejects `res.json()` with the same AbortError the header-phase abort would,
     caught by the same classification below. */
  let res;
  let body;
  try {
    res = await fetch(JEV_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model: MODEL, state: passportText, questions: Q_DOC }),
      signal: controller.signal
    });
    if (!res.ok) {
      return { outcome: JEV_OUTCOMES.HTTP_ERROR, status: res.status };
    }
    body = await readBoundedJson(res, controller);
  } catch (err) {
    return { outcome: err && err.name === 'AbortError' ? JEV_OUTCOMES.TIMEOUT : JEV_OUTCOMES.TRANSPORT_ERROR };
  } finally {
    clearTimeout(timer);
  }

  /* Model and mismatch are read BEFORE the answer shape is validated, and
     carried on every outcome from here down, not only 'scored'. A response that
     parsed as JSON but whose answers are missing, empty, or the wrong type
     (a critic reproduced all three: `answers: {}`, a string where a number was
     expected, and a garbled body) is exactly the shape a moved model or a
     changed response contract would take, and that used to fall into
     `transport_error` with the `model` field thrown away unread — silencing the
     one tripwire condition 6 exists to ring. It is intentionally still not a
     sixth outcome: the five in JEV_OUTCOMES stay exhaustive, and an answer-shape
     failure with a readable model is `transport_error` that additionally names
     the model, not a new category. */
  /* Unconditional, not `model === null ? null : ...`. A first version of this
     fix special-cased a null model to an "unknown, not a mismatch" null,
     reasoning that a response we could not read tells us nothing -- but by
     this line the response WAS read: `body` is a successfully parsed JSON
     object, and the question is only whether it happened to name a model. No
     name is not "unknown", it is "not jev-1.13.0", the exact fact
     EXPECTED_MODEL exists to catch. A critic reproduced the regression this
     caused: a `scored` response with valid scores and an absent `model` field
     logged with no model fields at all, where the original code correctly
     logged `modelMismatch: true`. `model === null` here can ONLY mean "parsed
     a body, found no usable model string" -- a response we never parsed at
     all never reaches this line, see the `catch` above -- so treating null as
     a known mismatch, not an unknown, is correct in both callers below. */
  const model = typeof body?.model === 'string' ? body.model : null;
  const modelMismatch = model !== EXPECTED_MODEL;

  const installable = body?.answers?.installable?.noul;
  const unconsented = body?.answers?.unconsented?.noul;
  if (typeof installable !== 'number' || typeof unconsented !== 'number') {
    return { outcome: JEV_OUTCOMES.TRANSPORT_ERROR, model, modelMismatch };
  }

  return {
    outcome: JEV_OUTCOMES.SCORED,
    installable,
    unconsented,
    model,
    modelMismatch
  };
}

/* ── the password check (design S) ────────────────────────────────────────────
   Measured 2026-09-24, record/findings/a-jev-password-check-catches-88-percent-at-0-5-and-the-
   boundary-is-0-1-wide-2026-09-24.md: code picks candidate lines (lib/_secretfinder.mjs),
   Jev judges each on about 200 characters, ONE call for all of them, the score is the highest
   and the line is the candidate that scored it. 87.6% of 635 positive documents caught at 0.5,
   7 false alarms in 449 clean ones (1.6%). RULING (Raffael, 2026-09-24, via HAL): a score of 0.5
   or more HOLDS the upload, nothing is refused on this check, and there is no refuse threshold,
   tier or environment variable for it anywhere. Raffael's words for the threshold: "okay that is
   good lets keep 0.5".

   THE QUESTION IS FROZEN. It is the text the measurement used, character for character, and the
   thresholds are tied to it: the 09-17 rule is one positive fact per question, TRUE means wrong,
   no test case in the criteria. Changing a word here detaches the running check from its
   evidence; re-run the measurement instead.

   SAME CONTRACT AS shadowCheck: never throws, fails open (no key, timeout, transport error, HTTP
   error, an answer that is not a number, a model that is not the one measured: none of them can
   hold an upload), the key is read on every call so unsetting it (and deploying, see shadowCheck)
   is the kill switch. Own timeout
   of TIMEOUT_MS and own bounded read, run beside shadowCheck with Promise.all so the pair costs
   one budget, not two. It does not reuse shadowCheck's request code on purpose: that function
   has a long history of critic-found faults and this one changes nothing about it. */
export const SECRET_QUESTION = 'Does this text contain the actual value of a secret that would let someone log in or call a service '
  + 'as the owner: a password or passphrase, an API key or access token, a private key, or a URL or '
  + 'connection string that includes one?';
export const SECRET_CRITERIA = {
  true: 'A real-looking secret value is written out, in full or in part, even inside a URL, a '
    + 'connection string, a config line or a sentence.',
  false: 'The text only names credentials, or shows placeholders (angle brackets, shell variables, '
    + 'runs of x or asterisks, bracketed [SCRUBBED:...] or [REDACTED] markers), or a well-known '
    + 'documentation example key, or contains nothing credential-like.'
};

export const SECRET_OUTCOMES = Object.freeze({ ...JEV_OUTCOMES, NO_CANDIDATES: 'no_candidates' });

/* Test seam, read by run-endpoint-tests.mjs: how many times the finder has run in this process. */
export const secretStats = { finderRuns: 0 };

/* The finder's half, run by the CALLER before either Jev request starts. It is synchronous, and a
   synchronous stretch inside Promise.all starts counting against the consent check's 2 s timer (the
   consent fetch is already in flight): the PH-507 critic made a 256 KB line take the finder 8 s and
   the consent check timed out and failed open, publishing a passport the code path before this one
   refuses. Run first, the finder can only ever delay an upload, never touch a timer. No key, no
   work. Returns the candidate list, or null when there is no key or the finder faulted (a finder
   fault is not the owner's problem: the check then reports transport_error). */
export function secretCandidates(passportText) {
  if (!process.env.TYPESAFE_API_KEY) return null;
  secretStats.finderRuns++;
  try {
    return excerpts(String(passportText));
  } catch {
    return null;
  }
}

export async function secretCheck(passportText, precomputed = secretCandidates(passportText)) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { outcome: SECRET_OUTCOMES.SKIPPED_NO_KEY };

  const found = precomputed;
  if (!Array.isArray(found)) return { outcome: SECRET_OUTCOMES.TRANSPORT_ERROR };
  if (found.length === 0) return { outcome: SECRET_OUTCOMES.NO_CANDIDATES, n: 0 };

  const state = found.map((f, i) => `[${i + 1}] ${f.excerpt}`).join('\n\n');
  const questions = {};
  found.forEach((_, i) => {
    questions[`c${i + 1}`] = {
      type: 'noul',
      instructions: `Look only at excerpt [${i + 1}]. ` + SECRET_QUESTION,
      criteria: SECRET_CRITERIA
    };
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let body;
  try {
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: controller.signal
    });
    if (!res.ok) return { outcome: SECRET_OUTCOMES.HTTP_ERROR, status: res.status };
    body = await readBoundedJson(res, controller);
  } catch (err) {
    return { outcome: err && err.name === 'AbortError' ? SECRET_OUTCOMES.TIMEOUT : SECRET_OUTCOMES.TRANSPORT_ERROR };
  } finally {
    clearTimeout(timer);
  }

  const model = typeof body?.model === 'string' ? body.model : null;
  const modelMismatch = model !== EXPECTED_MODEL;
  const scores = found.map((_, i) => body?.answers?.[`c${i + 1}`]?.noul);
  if (!scores.every(x => typeof x === 'number' && Number.isFinite(x))) {
    return { outcome: SECRET_OUTCOMES.TRANSPORT_ERROR, model, modelMismatch };
  }
  const top = scores.indexOf(Math.max(...scores));
  return {
    outcome: SECRET_OUTCOMES.SCORED,
    score: scores[top],
    line: found[top].line + 1,          // 1-based, the number a screen can print; never the line's text
    n: found.length,
    model,
    modelMismatch
  };
}

export const JEV_VERSION = 1;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* Build the log record. Holds scores, an outcome enum, and a model string: never
   passport content, never an owner or account identifier. `privacy.html` tells a
   reader what is kept; a free-text field here would make that page false the same
   way a stored capability reference once did in `_metrics.mjs` (see that file's
   own documented past defect). Returns null on a malformed call rather than
   guessing, matching `metricsRecord`/`rejectionRecord`'s own discipline in
   `_metrics.mjs`.

   The model fields are attached whenever `result.model` is set at all, string
   OR null, not gated on `typeof ... === 'string'`: `shadowCheck` only ever
   sets this key once it has successfully parsed a JSON body, whether that
   body named a usable model (a string) or not (null, which is itself the
   "not the expected model" fact, not an unknown -- see `shadowCheck`). A
   result that never got that far (skipped_no_key, timeout, http_error, or a
   transport_error before any JSON parsed) never sets the key, so
   `result.model !== undefined` is the correct gate. Gating on `typeof
   result.model === 'string'` instead was tried and a critic reproduced the
   regression it causes: a `scored` response with a genuinely absent model
   field logged with no model fields at all, discarding the mismatch the
   caller had already correctly computed as true. */
export function jevLogRecord({ day, result, secret }) {
  if (typeof day !== 'string' || !DAY.test(day)) return null;
  if (!result || typeof result.outcome !== 'string') return null;
  if (!Object.values(JEV_OUTCOMES).includes(result.outcome)) return null;

  const record = { v: JEV_VERSION, day, outcome: result.outcome };

  if (result.outcome === JEV_OUTCOMES.SCORED &&
      (typeof result.installable !== 'number' || typeof result.unconsented !== 'number')) {
    return null;
  }

  if (result.outcome === JEV_OUTCOMES.SCORED) {
    record.installable = result.installable;
    record.unconsented = result.unconsented;
  }

  if (result.outcome === JEV_OUTCOMES.HTTP_ERROR) {
    record.status = typeof result.status === 'number' ? result.status : null;
  }

  if (result.model !== undefined) {
    record.model = result.model;
    record.modelExpected = EXPECTED_MODEL;
    record.modelMismatch = result.modelMismatch === true;
  }

  /* The password check's own outcome, in the same row. Numbers and an enum only: the score, the
     1-based number of the line that scored highest, and how many candidate lines there were. Never
     a line's text, never an excerpt. A malformed `secret` is left out rather than costing the
     main record. */
  if (secret && Object.values(SECRET_OUTCOMES).includes(secret.outcome)) {
    const s = { outcome: secret.outcome };
    if (secret.outcome === SECRET_OUTCOMES.SCORED &&
        typeof secret.score === 'number' && Number.isInteger(secret.line) && secret.line >= 1 &&
        Number.isInteger(secret.n)) {
      s.score = secret.score; s.line = secret.line; s.n = secret.n;
      s.modelMismatch = secret.modelMismatch === true;
    } else if (secret.outcome === SECRET_OUTCOMES.SCORED) {
      s.outcome = SECRET_OUTCOMES.TRANSPORT_ERROR;
    }
    if (secret.outcome === SECRET_OUTCOMES.NO_CANDIDATES) s.n = 0;
    record.secret = s;
  }

  return record;
}

/* ── the gate: cut-off and disposition, both read fresh on every call ──────

   Neither is a constant baked into logic, per HAL's brief for this branch:
   "the code must not care which number he picks, and it must not care which
   disposition he picks either." Both are env vars, read inside a function
   body on every invocation, never hoisted to module load or cached -- the
   identical discipline `shadowCheck` already applies to `TYPESAFE_API_KEY`.
   What that discipline does NOT buy is a change without a deploy, which this
   note used to claim: Netlify applies environment variables per deploy, so a
   change in the UI takes effect with the next deploy that actually runs. See
   the kill-switch note on shadowCheck (corrected 2026-10-22). */

/* Recommended value 0.9, measured on two independent legs 2026-09-17:
   record/findings/the-frozen-jev-battery-scores-zero-of-165-real-captures-above-0.9-2026-09-17.md
   (fixture false-positive count: 0 at 0.9 vs 9 at 0.7, all named) and
   record/findings/the-frozen-jev-battery-is-not-deterministic-at-the-0.9-boundary-2026-09-17.md
   (the highest real capture crosses 0.7 on 4 of 10 identical calls, never
   approaches 0.9). NOT a decision this file makes: it is Raffael's, per
   record/decisions/what-actually-goes-to-raffael.md, and this default is
   only what the code does if `JEV_CUTOFF` is unset or unparseable -- it is
   not a claim about what production should run. Set the env var to change
   the running value without touching this file. */
const DEFAULT_CUTOFF = 0.9;

/* Both scores are `noul` answers, documented and observed in the 165-capture
   run as living in [0, 1]; a cutoff outside that range cannot be a real
   threshold someone meant to set; it is a typo or a paste error, silently
   refusing every upload (at or below 0) or none (above 1). A gate-code
   critic reproduced the whitespace case first: a whitespace-only JEV_CUTOFF
   (" ") passed `raw === ''`'s guard, `Number(' ')` is 0, `Number.isFinite(0)`
   is true, and 0 flags every scored result silently. Trimming closes that.

   ZERO ITSELF MUST ALSO WARN, and a first version of this range check
   wrongly treated it as a legitimate, if extreme, boundary alongside 1 --
   two gate-code critics independently found the literal strings "0",
   "0.0", "-0" and "0e0" all still parse to exactly 0 and still silently
   flag every scored result, no warning, the identical failure shape
   finding 4 was raised about, just reached one character differently than
   whitespace. Unlike 1 (the maximally PERMISSIVE boundary -- "only flag a
   perfect double score", which degrades safely toward never refusing
   anything), 0 is the maximally CATASTROPHIC boundary and has no
   legitimate operational meaning as a tuning value: it is indistinguishable
   from "refuse all traffic", which nothing about setting a threshold should
   ever silently mean. So the valid range is `(0, 1]`, not `[0, 1]`, and a
   literal 0 now warns and falls back to the default exactly like any other
   out-of-range or unparseable value ("-1", "2", "Infinity" typed into the
   same field). */
export function jevCutoff() {
  const raw = process.env.JEV_CUTOFF;
  const trimmed = raw === undefined ? '' : raw.trim();
  if (trimmed === '') return DEFAULT_CUTOFF;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    console.warn(`PH-507: JEV_CUTOFF="${raw}" is not a number in (0, 1]; falling back to ${DEFAULT_CUTOFF}.`);
    return DEFAULT_CUTOFF;
  }
  return n;
}

/* Four names, three implemented. 'off' and 'refuse' are real code paths:
   both are backend-only and need no product decision beyond "is this the
   one". 'hold' is real as of Raffael's ruling to build it (5-day expiry,
   text and email deleted together -- see createHold/sweepHolds in
   _store.mjs) but is COUPLED below to a second condition, not merely
   named. 'notify' is still just named, for an event-triggered send path
   that does not exist -- see
   record/proposals/jev-gate-disposition-options-2026-09-17.md. */
export const JEV_DISPOSITIONS = Object.freeze({
  OFF: 'off',
  REFUSE: 'refuse',
  HOLD: 'hold',
  NOTIFY: 'notify'
});

const IMPLEMENTED_DISPOSITIONS = new Set([JEV_DISPOSITIONS.OFF, JEV_DISPOSITIONS.REFUSE, JEV_DISPOSITIONS.HOLD]);

/* PH-507, pre-flip checklist item 4. A held upload is shown an "in review"
   state that promises a human will look and, if the owner left an address,
   that somebody will get back to them. That promise is true only if a
   human is actually told a hold exists. Read fresh per invocation, same
   discipline as everything else on this path, never cached. That does not
   make a changed destination live without a deploy, which this note used to
   say: Netlify applies environment variables per deploy (see the note on
   shadowCheck). It keeps this module from adding a cache of its own on top.
   `mailEnabled()` is checked as well as the
   address, because a destination nobody can actually mail (no
   RESEND_API_KEY configured) is not reachable either, whatever
   HOLD_ALERT_TO says. */
export function holdAlertTo(env = process.env) {
  const raw = env.HOLD_ALERT_TO;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return validAddress(trimmed);
}

export function holdAlertReachable(env = process.env) {
  return Boolean(holdAlertTo(env)) && mailEnabled(env);
}

/* The kill switch, restated for the gate: `process.env.JEV_DISPOSITION` is
   read HERE, inside the function body, on every call -- same as
   `TYPESAFE_API_KEY` above, and with the same correction: unsetting it takes
   effect with the next deploy, not the next invocation (see shadowCheck).
   Unset, empty, unrecognised, or a real name that
   is not yet implemented all fail closed to 'off', because a disposition
   flipped to 'hold' or 'notify' before either is built must be loud and
   distinguishable from a working choice, never silently equivalent to 'off'
   with nobody told.

   'hold' CARRIES A SECOND CONDITION, and this is the one branch in this
   function that is not just "is the name recognised and built": HAL's
   ruling, PH-507, 2026-09-17. `JEV_DISPOSITION=hold` with no reachable
   `HOLD_ALERT_TO` is reachable by setting one field and forgetting a
   second, exactly the shape of every other item on the pre-flip checklist
   -- except silent rather than a wrong sentence on a page. A hold nobody
   is told about is not a hold, a person's upload sits behind a promise
   that somebody will look while nothing tells anybody to, indistinguishable
   from a refusal except worse: at least a refusal says so. Falling back to
   'off' is strictly safer than shipping that silently, so the check runs
   here, on every call, not only where 'hold' is first wired up -- an alert
   destination pulled out from under a live disposition (a typo'd env edit,
   a deleted var) must fail this exact same way in the deploy that carries
   the edit, not only at start-up. */
export function jevDisposition() {
  const raw = process.env.JEV_DISPOSITION;
  if (raw === undefined || raw === '') return JEV_DISPOSITIONS.OFF;
  if (!Object.values(JEV_DISPOSITIONS).includes(raw)) {
    console.warn(`PH-507: JEV_DISPOSITION="${raw}" is not a recognised value; failing closed to 'off'.`);
    return JEV_DISPOSITIONS.OFF;
  }
  if (!IMPLEMENTED_DISPOSITIONS.has(raw)) {
    console.warn(`PH-507: JEV_DISPOSITION="${raw}" is named but not yet implemented; failing closed to 'off'.`);
    return JEV_DISPOSITIONS.OFF;
  }
  if (raw === JEV_DISPOSITIONS.HOLD && !holdAlertReachable()) {
    console.warn('PH-507: JEV_DISPOSITION="hold" is set but no reachable HOLD_ALERT_TO is configured '
      + '(unset, invalid, or mail is not enabled); a hold nobody is told about is not a hold; '
      + 'failing closed to \'off\'.');
    return JEV_DISPOSITIONS.OFF;
  }
  return raw;
}

/* True only for a real, scored result at or above the cut-off, checked as
   max(installable, unconsented) -- never either question alone -- matching
   every measurement the cut-off was set from (jev_distribution.py and both
   findings cited above all score this way; scoring differently here would
   silently detach the running gate from the evidence that picked its
   number). Any non-'scored' outcome (skipped_no_key, timeout,
   transport_error, http_error) is never flagged: there is no score to
   compare, and failing open on an absent score is the same fail-open
   contract `shadowCheck` already keeps for every other reason Jev might not
   answer -- an infrastructure hiccup must never itself become a refusal.

   NOR IS A MODEL-MISMATCHED SCORE EVER FLAGGED, added after a gate-code
   critic pointed out `shadowCheck` computes and logs exactly this fact
   (`modelMismatch`) and this function ignored it: 0.9 is a cut-off measured
   against `jev-1.13.0`'s specific behaviour, and a response naming a
   different model, or none, is a score this cut-off was never calibrated
   against. Acting on it anyway is the same category of mistake as trusting
   an absent score, just with a number attached instead of nothing --
   `EXPECTED_MODEL`'s whole reason for existing is to catch a moved model
   before it moves the cut-off silently, and flagging on its score anyway
   would defeat that the moment 'refuse' is live. Fails open, not closed:
   a real publisher whose scored response happens to name the wrong model
   is treated exactly like a transport error, not specially refused. */
export function jevFlagged(result, cutoff = jevCutoff()) {
  if (!result || result.outcome !== JEV_OUTCOMES.SCORED) return false;
  if (result.modelMismatch === true) return false;
  return Math.max(result.installable, result.unconsented) >= cutoff;
}

/* ── the password check: threshold, disposition, and the one predicate ───────
   Same discipline as the consent check above: both read fresh on every call, never cached; a
   change in the Netlify UI still takes effect only with the next deploy (see the kill-switch note
   on shadowCheck). There is ONE threshold and two
   dispositions, off and hold. Raffael ruled hold-only on 2026-09-24: no refuse value exists, and
   `refuse` (or anything else unrecognised) fails closed to off with a warning rather than being
   read as a stronger hold. */
const DEFAULT_SECRET_HOLD = 0.5;

export function secretHoldThreshold() {
  const raw = process.env.JEV_SECRET_HOLD;
  const trimmed = raw === undefined ? '' : raw.trim();
  if (trimmed === '') return DEFAULT_SECRET_HOLD;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    console.warn(`PH-507: JEV_SECRET_HOLD="${raw}" is not a number in (0, 1]; falling back to ${DEFAULT_SECRET_HOLD}.`);
    return DEFAULT_SECRET_HOLD;
  }
  return n;
}

export function secretDisposition() {
  const raw = process.env.JEV_SECRET_DISPOSITION;
  if (raw === undefined || raw === '') return JEV_DISPOSITIONS.OFF;
  if (raw !== JEV_DISPOSITIONS.OFF && raw !== JEV_DISPOSITIONS.HOLD) {
    console.warn(`PH-507: JEV_SECRET_DISPOSITION="${raw}" is not "off" or "hold" (the password check never refuses); failing closed to 'off'.`);
    return JEV_DISPOSITIONS.OFF;
  }
  if (raw === JEV_DISPOSITIONS.HOLD && !holdAlertReachable()) {
    console.warn('PH-507: JEV_SECRET_DISPOSITION="hold" is set but no reachable HOLD_ALERT_TO is configured; '
      + 'a hold nobody is told about is not a hold; failing closed to \'off\'.');
    return JEV_DISPOSITIONS.OFF;
  }
  return raw;
}

/* True only for a real scored result at or above the threshold, from the model the threshold was
   measured on. Everything else, including every failure outcome, is not flagged: this can only
   ever ADD a hold, and never on a score it cannot trust. */
export function secretFlagged(result, threshold = secretHoldThreshold()) {
  if (!result || result.outcome !== SECRET_OUTCOMES.SCORED) return false;
  if (result.modelMismatch === true) return false;
  return result.score >= threshold;
}
