/* _ops.mjs

   One line in the function log for a failure that is otherwise silent or looks
   like the visitor's own fault: a limiter that could not record an attempt and
   answered 429, a passport read that failed and served the not-found page, a
   mail provider that refused or fell over. Added 2026-10-22 from the audit of
   analysis_and_improvement_plan.md (F7; "store failures look like user errors").

   CODES AND COUNTS, NEVER IDENTIFIERS. The function log is easier to read than
   the stores are, and Netlify keeps it for a day to a week. A passport uuid is
   the one secret in this system, an address is personal data, and a provider's
   error message can echo the address it refused. So a line is a code plus a few
   fields, and each field value is a number, a boolean or a short lower-case
   token (a limiter bucket, a provider's error name). Anything else is written
   as `?`. That filter is a backstop for a careless caller, not a classifier: a
   slug is a short lower-case token too, so callers pass literals.

   NEVER THROWS. It runs on failure paths, inside catch blocks whose job is to
   return the answer they already return, and a logging fault must not turn that
   answer into a 500. It writes to no store, on purpose: the failure most worth
   seeing is a Blobs outage, and a store write would fail along with it. */

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const TOKEN = /^[a-z][a-z0-9_-]{0,47}$/;
/* Eight hex characters in a row is a uuid, a hash or a token, never a code. */
const HEX_RUN = /[0-9a-f]{8}/;

const safe = v =>
  (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' ? v
    : typeof v === 'string' && TOKEN.test(v) && !HEX_RUN.test(v) ? v
      : '?';

export function opsLog(code, fields = {}) {
  try {
    const line = { code: CODE.test(code) ? code : 'OPS_BAD_CODE' };
    for (const [k, v] of Object.entries(fields || {})) {
      if (KEY.test(k) && k !== 'code') line[k] = safe(v);
    }
    console.error('ops:', JSON.stringify(line));
  } catch { /* see NEVER THROWS */ }
}
