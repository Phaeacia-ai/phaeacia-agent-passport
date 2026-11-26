/* How web/tools/parity.mjs reads `tools/preflight.py --codes`. A module of its
   own so that parity.test.mjs, beside it, can hold it to the rule below without
   running the whole harness.

   --codes has two answers: exit 0 with nothing on stdout (the upload would get
   past stages 1 and 3), or exit 1 with one code per line (it would be refused,
   and these are the codes). Everything else is a crash, and a crash is not an
   answer: exit 2 is the usage line, and an uncaught exception is Python's own
   exit 1 with a traceback on stderr and nothing on stdout, which is why stderr
   is read as well as the status.

   Until 2026-10-23 parity.mjs read stdout whatever the status, so that
   traceback read as [], which is the right answer for anything clean: with
   preflight.py raising on start, six of the fifteen stage-1 probes, and every
   fixture and stage-3 probe whose answer is [], agreed with it.

   Takes what execFile resolved with or rejected with, unchanged, so a caller
   writes run(...).then(readCodes, readCodes). */
export function readCodes(r) {
  const status = r instanceof Error ? (r.code ?? r.signal) : 0;
  const codes = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const stderr = String(r.stderr || '').trim();
  const answered = status === 0 ? !codes.length : status === 1 && codes.length > 0;
  if (answered && !/^Traceback \(most recent call last\)/m.test(stderr)) return { codes };
  /* The last line of a traceback is the exception, which is what to read
     first; a spawn that never ran has only its error message. */
  const why = stderr.split(/\r?\n/).pop() || String(r.message || '').split(/\r?\n/)[0] ||
              'nothing on stderr';
  return { crash: `preflight.py crashed: exit ${status}, ` +
                  `${codes.length ? 'stdout ' + JSON.stringify(codes) : 'no code'}, ${why}` };
}
