/* The browser-side suites, which each register their own tests when imported. Three of them are the
   ones tools/run-tests.mjs used to import for that side effect. They are left exactly where they were,
   in tools/; this file is what lets `node --test` and `node --test "tools/*.test.mjs"` find them, so
   that splitting the old runner does not quietly stop running them. If you would rather have them
   beside the other tests, move them here, rename them *.test.mjs, and delete this file.

   The fourth, leak-scan-tests.mjs, was added 2026-10-22. Its 19 tests of assets/leak-scan.js, the
   warning /upload shows before a stranger publishes, had run nowhere since they were written: the
   old runner never imported it and its name matches no test glob. */

import '../tools/gallery-client-tests.mjs';
import '../tools/copy-client-tests.mjs';
import '../tools/held-client-tests.mjs';
import '../tools/leak-scan-tests.mjs';
