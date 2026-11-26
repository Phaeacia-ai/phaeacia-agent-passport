# Upload validation contract, share layer v0.1

**Status:** normative for the upload endpoint of the Agent Passport site. Clients of this document: the create page (`site/spec/create-page.md`), the storage layer (`site/spec/schema.sql`), and whoever implements the endpoint.

**Rules version:** `0.1.0`. This string is stored on every accepted row as `validator_version`. Section 5 says when to change it.

**What this endpoint is for:** it accepts one Markdown file from an anonymous stranger and decides whether it becomes a public page. Everything arriving here is untrusted. The uploader may be careless, the uploader's assistant may have hallucinated a section, and the uploader may be hostile. The endpoint's job is to reject rather than repair. There is no partial acceptance and no auto-correction anywhere in this document.

---

## 1. Pipeline

Five stages, in order. A stage runs only if the previous one passed.

| stage | what it does | failure behaviour |
|---|---|---|
| 1. Transport | origin, size, encoding, content type, rate limit | fail fast, one error |
| 2. Format | every rule in `spec/passport-0.1.md` section 7 | collect all errors, report all |
| 3. Untrusted content | HTML, active content, unscrubbed secrets | collect all errors, report all |
| 4. Derivation | build `title`, `summary`, `needs`, and the frontmatter-derived columns | fail fast, one error |
| 5. Storage | one call to `public.create_passport` | fail closed, see 6.5 |

Stages 2 and 3 collect because a passport with four format problems should be fixed in one pass, not four round trips. Stages 1, 4 and 5 fail fast because the first failure makes the rest meaningless.

Nothing is written to the database before stage 5. There is no draft state, no temporary row, no orphan.

---

## 2. Stage 1, transport

| check | rule |
|---|---|
| Origin | Checked first, before the rate limit is charged or the body is read. A browser request that a page on another site sent is refused `403 E_CROSS_SITE`: `Sec-Fetch-Site` present and not `same-origin`, or `Origin` present and not this request's own origin. `Origin: null` passes only beside `Sec-Fetch-Site: same-origin`, because the site's own pages are served with `Referrer-Policy: no-referrer`, under which a same-origin form post carries `Origin: null`. A request with neither header, which is what a script such as `publish.py` sends, is not refused by this check. The vote, copy-count, manage, delete, subscribe, hold-email and send endpoints apply the same rule (`web/lib/_origin.mjs`). |
| Content type | `text/markdown` or `text/plain`. Anything else is refused. A file upload with a `.md` extension and a browser-guessed type of `application/octet-stream` is accepted if and only if the bytes pass the UTF-8 check below. |
| Size ceiling | **262144 bytes (256 KiB)** of raw request body. Measured in bytes, not characters. |
| Size floor | **512 bytes.** Six sections and nine frontmatter keys cannot fit in less. |
| Encoding | Valid UTF-8, decoded strictly. Invalid byte sequences are a rejection, never a replacement character. A UTF-8 BOM is stripped before any other check and is not an error. |
| Line endings | CRLF is normalised to LF before stage 2. This is the only normalisation the endpoint performs on the body. |
| Control characters | No C0 control characters other than LF and TAB. No unpaired surrogates. No `U+0000`. |
| Rate limit | See section 3. |

The 256 KiB ceiling is set to match `passports_body_size_ck` in `schema.sql`. The two numbers must move together or uploads will pass the endpoint and be refused by the database, which is failure mode 6.5.

---

## 3. Rate limits

RLS cannot count requests. A policy sees one candidate row inside one transaction and has no view of who is calling or how often. Everything in this section lives in the endpoint.

| limit | value | scope |
|---|---|---|
| Uploads | 5 per hour, 20 per day | per source IP |
| Upload attempts that fail validation | 30 per hour, then they stay on the upload ceiling | per source IP |
| Delete attempts | 20 per hour | per source IP |
| Manage attempts | 20 per hour; listing and unlisting from the manage page ride on this | per source IP |
| Votes on listed passports | 30 per hour | per source IP |
| Presses of the copy control | 60 per hour | per source IP |
| Emails sent | 10 per hour per IP, 5 per day per passport, 5 per day per recipient, 50 per day in all | per source IP, per passport, per recipient address across every sender, and for the whole site |
| Passport reads | not limited | reading requires a uuid the caller already holds |
| Body fingerprint | identical SHA-256 of the body twice within an hour is refused as a duplicate | global |

Source IP is taken from the platform's own forwarded-for header and is trusted only as far as that platform's edge. It is a speed bump, not an identity.

**Source IP means the caller's network.** An IPv4 address is counted as itself. An IPv6 address is counted as its /64 block (`IPV6_BLOCK_BITS` in `web/lib/_store.mjs`), because one IPv6 customer is routed a whole block of 2^64 addresses and a limit per address was no limit there. People who share a block, a household or an office, share one budget, as people behind one IPv4 address always have. Every spelling of one address counts as one: compressed or not, any case, bracketed with or without a port, with a zone suffix, and IPv4-mapped IPv6 as the IPv4 address. Outside global unicast (2000::/3) the full address is counted. Text that is not an address is counted as itself.

**The two email ceilings that are not about the sender** are counted per recipient and for the whole site, and both windows are the UTC day. The recipient is the address as typed, trimmed and lower-cased; plus-tags and dots are not merged. The site-wide ceiling exists because the mail account is shared with other products and capped per day. A message is charged before it is handed to the provider, so concurrent requests see it, and given back only when the provider answers with a 4xx, a refusal; a 5xx, a network error or a timeout keeps the charge, because the provider may have taken the message before the answer went wrong. A request that asks for a sender copy charges the copy to both ceilings as well; if either is full the copy is not sent and the recipient's message still goes. Both answer `E_SEND_DAILY_LIMIT`, which does not say which ceiling fired.

**Amended: delete attempts are 20 an hour, not 10.** The token is 20 bytes of cryptographic randomness compared in constant time, so working through half of 2^160 at any ceiling this side of a million an hour takes the same answer, 10^37 years or 10^42. The limiter is therefore a flood speed bump and never the thing standing between an attacker and a passport, so its ceiling belongs to the owner's comfort rather than to the attacker's inconvenience. Ten wrong pastes used to lock somebody out of deleting their own passport, under a page promising deletion is immediate.

**Windows are fixed, not rolling.** They are bucketed on `floor(now / windowMs)`, so a ceiling spent at the end of one window is available again at the start of the next: 40 delete attempts can straddle an hour boundary. This is written down because a limit described as rolling and implemented as tumbling is the sort of difference that gets designed around later.

**The address is not stored.** Counters are keyed on a truncated SHA-256 of the source IP, for IPv6 of its block. That is a pseudonym and not anonymity: the address space is small enough that somebody holding the store and a guess could confirm the guess. What it buys is that the store is not a readable list of who used the site. The per-recipient email counter is keyed the same way on a SHA-256 of the recipient's address, never the address, with the same caveat: somebody holding the store and a guessed address could confirm that it was sent a passport that day.

**The failure ceiling is not a gate.** It is checked nowhere before the work. `up-h` is charged up front and bounds everything to 5 an hour by itself; a refusal then MOVES that attempt to `bad-h`, and when `bad-h` is full the move fails and the attempt stays where it was. The ceiling on full validator runs per address per hour is therefore 30 moved plus 5 that could not move. Gating on `bad-h` was tried and removed: it meant an address that spent 30 failures could not publish at all for the rest of the hour, so on a shared office egress one person's malformed file locked out everybody.

**Every counted attempt is a real attempt, and failures move rather than vanish.** A request that reaches the validator and is refused has its attempt moved from the upload ceiling to the failure ceiling: `up-h` is refunded and `bad-h` is charged. That is what makes both numbers mean something. Charging without refunding made the failure ceiling unreachable, because 5 an hour sits in front of it and at most 5 keys could ever exist against a limit of 30. Refunding without charging is worse:

> **A refund of a recorded attempt must be accompanied by a charge somewhere else.**

The owner-review gate broke that rule twice. First it refunded on a path selected by a request header, which bought unlimited full validations of 256 KB bodies. Then it refunded on consuming a server-minted ticket, which still bought two full validations per recorded attempt by alternating refuse and retry. It now charges the failure ceiling like every other refusal and the ticket carries nothing. See §8b.

A blunt database-side backstop exists (`public.check_request`, 20 writes per 10 minutes per IP). It is not the limit. It exists so that a project whose endpoint is broken or bypassed still has a ceiling. If the endpoint's limits are removed, the insert policy admits unlimited rows.

---

## 4. Stage 2, format

These are the rules of `spec/passport-0.1.md` section 7, restated as endpoint checks. `tools/validate.py` implements the same list. Section 5 governs which one wins when they disagree.

### 4.1 Frontmatter

1. The file begins with `---` on line 1.
2. A closing `---` appears within the first 40 lines.
3. The block parses as YAML mappings. A parse error is `E_FRONTMATTER`.
4. All nine keys are present: `passport`, `name`, `title`, `created`, `capture_path`, `source_stack`, `owner_confirmed`, `scrub`, `envelope`.
5. `passport` is exactly `0.1`. **Any other value, including `0.2` and `1.0`, is refused.** The endpoint does not guess forward and does not degrade gracefully. This is spec section 8: readers refuse versions they do not know.
6. `name` matches `^[a-z0-9][a-z0-9.-]{0,63}$`.
7. `title` is one line, 1 to 200 characters after trimming.
8. `created` is `YYYY-MM-DD` and is a real date. A date more than 24 hours in the future is refused.
9. `capture_path` is `file` or `browser`.
10. `owner_confirmed` is a boolean. `false` is valid and shareable. It is never a reason to reject and it must be rendered, per spec section 2.
11. `envelope` is exactly `read-notify`. **A passport declaring any other envelope is refused for v0.1**, whatever it claims to need. Widening the envelope is a spec version change, not an upload-time decision.
12. `scrub` is a non-empty string.

### 4.2 Body structure

13. All six headings are present, each exactly once, matching verbatim: `## 1. What this agent is`, `## 2. What it needs from you`, `## 3. Functional spec`, `## 4. Golden examples`, `## 5. Installer`, `## 6. Losses`.
14. They appear in that order.
15. Exactly one `comparison_mode:` line exists in the body, and its value is `structural`, `exact` or `input_relative`.
16. Every `capability_ref:` value is in `spec/vocabulary.md`, or begins with `money.`.
17. Section 4 contains between one and three fenced code blocks. Zero golden examples is a refusal: no evidence, no passport.
18. Fenced code blocks are balanced across the whole file.

### 4.3 The scrub gate

19. If the body contains `[SCRUBBED:` anywhere, the `scrub` frontmatter value must contain the substring `owner-reviewed`. A passport carrying redactions nobody looked at is invalid. This is the one rule that exists purely to stop a leak.
20. The body contains none of the denied-path names: `browser_profile`, `id_rsa`, `.pem`, `credentials/`, `secrets/`. This list is shared with `tools/validate.py` and must stay identical.

---

### 4.4 `created` is a real date, and not a future one

`created` must match `^\d{4}-\d{2}-\d{2}$`, must parse back to the same three parts, and must not be more than one day ahead of the validating machine's date. The one day of slack is for clocks in different timezones, not for a passport dated next year.

Parsing back is the part that is easy to get wrong and was got wrong on both sides. `Date.parse('2026-02-31T00:00:00Z')` does not fail: it rolls the date forward to 3 March, so a passport dated a day that does not exist was accepted and then rendered carrying that day. Python's `datetime.date.fromisoformat` does raise, which is why the two implementations disagreed rather than both being wrong.

`validate.py` check 10. Endpoint: `E_BAD_VALUE` with `field: created`.

### 4.5 Section 2 carries the consent table

`## 2. What it needs from you` must contain a Markdown table with the five columns of spec section 3, a divider row, and at least one data row. Each data row's Required column must start with `required`, `optional` or `declared`, and its Installable column with `yes` or `no`.

This is a format rule and not only a derivation rule, and the distinction cost something. `validate.py` used to accept a section 2 containing one line of prose, so a capture could finish, print PASS, and produce a passport with nothing in it for a person to consent to. The endpoint refused that file, which is the right answer arriving far too late: by then the owner has been told their passport is valid. The consent table is the part of the document a person actually reads before deciding, so its absence is a malformed passport, not a rendering problem.

`validate.py` check 11. Endpoint: `E_DERIVE_NEEDS`.

### 4.6 The envelope floor

A passport declaring `envelope: read-notify` may not also offer to install a capability that writes to the world. Check 11 of §4.1 refuses a passport whose `envelope` is not `read-notify`; this is the other half, and it was missing. Until it landed, a passport could declare the envelope correctly at the top of the file and mark `email.send` "Installable: yes" three sections down, and every gate passed it. The recipient's page then stamped that row "Granted".

The declared-only ids come from `spec/vocabulary.md`: `email.send`, `msg.send`, `social.post`, `ext.write`, and anything under the `money.` prefix. `money.` is a prefix and never an id, and its suffix is a stranger's text: report it as `money.*` and never echo the suffix into a page or a store. That is not a style note. `lib/_metrics.mjs` put 71 characters of a stranger's text into a store on exactly this inference.

The rule is three checks, because the format gives an id three different amounts of context:

1. **Status**, this stage. An entry in the section 3 `capabilities` block whose `capability_ref` is declared-only must carry `status: declared_only`. Read within the block and within one `- ` entry: a `capability_ref` under `inputs` is an honest line and must not fire this. Endpoint: `E_ENVELOPE_FLOOR`.
2. **Backticked rows**, stage 4, §6.3.
3. **Arithmetic**, stage 4, §6.3.

Parts 2 and 3 read the consent table, which this stage never parses, so they sit in derivation. Derivation counts as a refusal (§1), so the combined verdict still matches `tools/validate.py` check 16, which does all three in one pass. (Check 16, not 14: the floor shipped under 14, a number the fidelity check already owned, and was renumbered on 2026-09-04, ROW-157.) The split follows the pipeline, not the rule, and `tools/parity.mjs` is what holds the two to the same verdict.

## 5. Stage 3, untrusted content

`tools/validate.py` does not implement this stage. It runs on the owner's own machine over a file the owner's own assistant just wrote. The endpoint runs on bytes from a stranger. These checks exist only here.

### 5.1 Markdown only, no HTML

The passport page renders stored Markdown. Every accepted body must be safe to render.

21. **No HTML tags.** Any match of `</?[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?>` outside a fenced code block is a refusal, with the offending tag named in the error. Inside fenced code blocks, tags are text and are permitted, because a golden example may legitimately contain HTML output. The renderer must escape fenced content, which is stated here because that requirement is created by this exemption.
22. Markdown autolinks (`<https://example.com>`) and comparisons (`fewer than <5 items`) are not tags and must not trip check 21. The regex above already excludes both, since neither is followed by a tag name pattern.
23. No `javascript:`, `vbscript:` or `data:text/html` URI anywhere, including inside code blocks.
24. No HTML comments (`<!--`), which are the usual smuggling channel for content that renders in some parsers and not others.
25. Image and link targets must be `https:`, `http:`, `mailto:` or relative. Anything else is a refusal.

The renderer must **also** sanitise its output. Check 21 is a gate, not a substitute for escaping. If the only thing standing between a stored passport and script execution is this regex, the design is wrong.

### 5.2 Unscrubbed secret scan

The purpose is not to catch every secret. It is to catch the case where the owner skipped or ignored the scrub step, and to send them back to it rather than publishing their key to a public URL.

26. The body is scanned for these shapes. A match is a refusal, not a warning, and not a silent redaction:

<!-- secret-table:begin  GENERATED from tools/preflight.py --dump-secret-rules.
     tools/run_tests.sh compares this table against that dump and fails on any
     difference, in either direction. Do not hand-edit a row: change the rule in
     all three tables (tools/scrub.py, tools/preflight.py, web/lib/_validate.mjs)
     and regenerate. This block exists because the ten rows that stood here until
     2026-08-31 had been wrong since 08-18: three rules were missing entirely and
     the URL row still printed a form abandoned on 08-30. The status/code table
     twelve lines below has been machine-checked all along. -->

| shape | pattern |
|---|---|
| an Anthropic key | `(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_\-]{10,}(?![A-Za-z0-9])` |
| an OpenAI style key | `(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])` |
| an AWS access key id | `(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])` |
| a GitHub token | `(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])\|(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}(?![A-Za-z0-9])` |
| a Google API key | `(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?:(?<=[-_])\|(?![A-Za-z0-9]))` |
| a Slack token | `(?<![A-Za-z0-9])xox[abprs]-[0-9A-Za-z-]{10,}(?![A-Za-z0-9])` |
| a JWT | `(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])` |
| a private key block | `-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----` |
| a URL carrying a credential | `(?<=\S)(?:[?]\|&(?:(?:[Aa][Mm][Pp]\|#0*38\|#[Xx]0*26);)*)(?:(?:[Tt][Oo][Kk][Ee][Nn]\|[Kk][Ee][Yy]\|[Ss][Ee][Cc][Rr][Ee][Tt]\|[Aa][Uu][Tt][Hh]\|[Aa][Pp][Ii][Kk][Ee][Yy]\|[Aa][Pp][Ii]_[Kk][Ee][Yy]\|[Aa][Cc][Cc][Ee][Ss][Ss]_[Tt][Oo][Kk][Ee][Nn])=(?!(?:\$\{[A-Za-z_][A-Za-z_]{0,64}\}\|\{\{[A-Za-z_][A-Za-z _.-]{0,64}\}\}\|<[A-Za-z_][A-Za-z _.-]{0,64}>\|\[[A-Za-z_][A-Za-z _.-]{0,64}\])(?=[\s&#]\|$))\S+\|(?:[Ss][Ii][Gg]\|(?:[Xx]-[A-Za-z][A-Za-z0-9]{1,9}-)?[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee])=(?!(?:\$\{[A-Za-z_][A-Za-z_]{0,64}\}\|\{\{[A-Za-z_][A-Za-z _.-]{0,64}\}\}\|<[A-Za-z_][A-Za-z _.-]{0,64}>\|\[[A-Za-z_][A-Za-z _.-]{0,64}\])(?=[\s&#]\|$))[^\s&#]{16,})` |
| a webhook URL carrying its own secret | `(?<![A-Za-z0-9_])[Hh][Tt][Tt][Pp][Ss]://(?:(?:[Hh][Oo][Oo][Kk][Ss]\.[Ss][Ll][Aa][Cc][Kk]\.[Cc][Oo][Mm](?::[0-9]*)?/(?:[Ss][Ee][Rr][Vv][Ii][Cc][Ee][Ss]\|[Tt][Rr][Ii][Gg][Gg][Ee][Rr][Ss]\|[Ww][Oo][Rr][Kk][Ff][Ll][Oo][Ww][Ss])\|(?:[Cc][Aa][Nn][Aa][Rr][Yy]\.\|[Pp][Tt][Bb]\.)?[Dd][Ii][Ss][Cc][Oo][Rr][Dd](?:[Aa][Pp][Pp])?\.[Cc][Oo][Mm](?::[0-9]*)?/[Aa][Pp][Ii]/(?:[Vv][0-9]{1,2}/)?[Ww][Ee][Bb][Hh][Oo][Oo][Kk][Ss]\|[A-Za-z0-9-]{1,63}\.[Ww][Ee][Bb][Hh][Oo][Oo][Kk]\.[Oo][Ff][Ff][Ii][Cc][Ee]\.[Cc][Oo][Mm](?::[0-9]*)?/[Ww][Ee][Bb][Hh][Oo][Oo][Kk][Bb]2\|[Oo][Uu][Tt][Ll][Oo][Oo][Kk]\.[Oo][Ff][Ff][Ii][Cc][Ee]\.[Cc][Oo][Mm](?::[0-9]*)?/[Ww][Ee][Bb][Hh][Oo][Oo][Kk]\|[Hh][Oo][Oo][Kk][Ss]\.[Zz][Aa][Pp][Ii][Ee][Rr]\.[Cc][Oo][Mm](?::[0-9]*)?/[Hh][Oo][Oo][Kk][Ss]/(?:[Cc][Aa][Tt][Cc][Hh]\|[Ss][Tt][Aa][Nn][Dd][Aa][Rr][Dd]))[/A-Za-z0-9_+=-]{0,4}/[A-Za-z0-9_/+=@.-]{16,}\|[Aa][Pp][Ii]\.[Tt][Ee][Ll][Ee][Gg][Rr][Aa][Mm]\.[Oo][Rr][Gg](?::[0-9]*)?/[Bb][Oo][Tt][0-9]{6,}:[A-Za-z0-9_-]{20,})` |
| a password assignment | `(?:(?<![A-Za-z0-9_.\-])(?:(?:[A-Za-z0-9_.\-]*[_\-.][Pp][Aa][Ssſ][Ssſ]\|[A-Za-z0-9_.\-]*[A-Za-z0-9][Pp][Aa][Ssſ][Ssſ])(?![A-Za-z])(?=[\"'`]?[ \t]*(?:\r?\n[ \t]*)*[:=](?![=>~:])[ \t]*(?:\r?\n[ \t]*)*[\"'`]?(?=[^\s\"']{8})(?=[^\s\"']{0,256}[0-9]))[\"'`]?[ \t]*(?:\r?\n[ \t]*)*[:=](?![=>~:])[ \t]*(?:\r?\n[ \t]*)*[\"'`]?(?![\"'`])(?=[^\s\"']{3})(?![\[{(<>/\]])(?!(?:[Tt]rue\|TRUE\|[Ff]alse\|FALSE\|[Nn]ull\|NULL\|[Nn]il\|None\|undefined\|void)(?![A-Za-z0-9_]))(?!(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_.]))(?![A-Za-z_][A-Za-z0-9_]*[ \t]*\()(?!\$\{)(?!\$[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_]))(?!(?:[Yy][Oo][Uu][Rr]\|[Mm][Yy]\|[Ii][Nn][Ss][Ee][Rr][Tt]\|[Rr][Ee][Pp][Ll][Aa][Cc][Ee]\|[Ee][Xx][Aa][Mm][Pp][Ll][Ee]\|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]\|[Cc][Hh][Aa][Nn][Gg][Ee][Mm][Ee]\|[Ss][Aa][Mm][Pp][Ll][Ee]\|[Dd][Uu][Mm][Mm][Yy]\|[Pp][Aa][Ss][Tt][Ee]\|[Tt][Oo][Dd][Oo]\|[Xx][Xx][Xx])[A-Za-z\-]*(?![A-Za-z0-9_\-+/=~.]))(?![0-9]{1,7}(?![A-Za-z0-9_.\-]))(?![\^~>=<]*[0-9]+\.[0-9]+)\S+(?:[\t \xa0\u1680\u2000-\u200a\u202f\u205f\u3000]+\S+)*\|[A-Za-z0-9_.\-]*(?:[Pp][Aa][Ssſ][Ssſ][Ww][Oo][Rr][Dd]\|[Pp][Aa][Ssſ][Ssſ][Ww][Dd]\|[Pp][Ww][Dd])[Ssſ]?(?![A-Za-z])[\"'`]?\s*[:=]\s*[\"'`]?\S+(?:[\t \xa0\u1680\u2000-\u200a\u202f\u205f\u3000]+\S+)*))` |
| a database URL carrying a password | `\b[A-Za-z][A-Za-z0-9+.\-]{0,31}://[^\s:/@]*:(?!<(?:[Rr][Ee][Dd][Aa][Cc][Tt][Ee][Dd]\|[Ss][Cc][Rr][Uu][Bb][Bb][Ee][Dd]\|[Rr][Ee][Mm][Oo][Vv][Ee][Dd]\|[Hh][Ii][Dd][Dd][Ee][Nn]\|[Mm][Aa][Ss][Kk][Ee][Dd]\|[Ee][Ll][Ii][Dd][Ee][Dd]\|[Oo][Mm][Ii][Tt][Tt][Ee][Dd]\|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]\|[Yy][Oo][Uu][Rr][-_]?[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]\|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]\|[Ss][Ee][Cc][Rr][Ee][Tt]\|[Xx]+\|\*+)(?:[:_ -][A-Za-z]+)*[-_0-9]*>@\|\[(?:[Rr][Ee][Dd][Aa][Cc][Tt][Ee][Dd]\|[Ss][Cc][Rr][Uu][Bb][Bb][Ee][Dd]\|[Rr][Ee][Mm][Oo][Vv][Ee][Dd]\|[Hh][Ii][Dd][Dd][Ee][Nn]\|[Mm][Aa][Ss][Kk][Ee][Dd]\|[Ee][Ll][Ii][Dd][Ee][Dd]\|[Oo][Mm][Ii][Tt][Tt][Ee][Dd]\|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]\|[Yy][Oo][Uu][Rr][-_]?[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]\|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]\|[Ss][Ee][Cc][Rr][Ee][Tt]\|[Xx]+\|\*+)(?:[:_ -][A-Za-z]+)*[-_0-9]*\]@\|\*+@\|\$\{[A-Za-z_][A-Za-z0-9_]*\}@\|\$[A-Za-z_][A-Za-z0-9_]*@)[^\s:/@]{3,}@[^\s/]+` |
| a SendGrid key | `(?<![A-Za-z0-9])SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}(?![A-Za-z0-9])` |
| a credential assignment | `(?<![A-Za-z0-9_.\-])(?:[A-Za-z0-9_.\-]*(?:[Aa][Uu][Tt][Hh][Oo][Rr][Iiİı][Zz][Aa][Tt][Iiİı][Oo][Nn]\|[Tt][Oo][KkK][Ee][Nn]\|[Ssſ][Ee][Cc][Rr][Ee][Tt]\|[Aa][Uu][Tt][Hh]\|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Iiİı][Aa][Ll]\|[Pp][Aa][Ssſ][Ssſ][Pp][Hh][Rr][Aa][Ssſ][Ee])[Ssſ]?\|[A-Za-z0-9_.\-]*[Aa][Pp][Iiİı][_\-]?[KkK][Ee][Yy][Ssſ]?\|[A-Za-z0-9_.\-]*[a-z0-9][KK]ey[Ssſ]?\|(?!(?:[Cc][Aa][Cc][Hh][Ee]\|[Ss][Oo][Rr][Tt]\|[Pp][Aa][Rr][Tt][Ii][Tt][Ii][Oo][Nn]\|[Ii][Dd][Ee][Mm][Pp][Oo][Tt][Ee][Nn][Cc][Yy]\|[Ff][Oo][Rr][Ee][Ii][Gg][Nn])[_\-.][KkK][Ee][Yy][Ssſ]?(?![A-Za-z0-9_.\-]))[A-Za-z0-9_.\-]*[_\-.][KkK][Ee][Yy][Ssſ]?)(?![A-Za-z])[\"']?\s*[:=]\s*(?:Bearer\s+)?[\"']?(?!(?![A-Za-z0-9_.]*?(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]*[0-9])[A-Za-z0-9_]{16,})(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_\-+/=~.]))(?!(?:[Yy][Oo][Uu][Rr]\|[Mm][Yy]\|[Ii][Nn][Ss][Ee][Rr][Tt]\|[Rr][Ee][Pp][Ll][Aa][Cc][Ee]\|[Ee][Xx][Aa][Mm][Pp][Ll][Ee]\|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]\|[Cc][Hh][Aa][Nn][Gg][Ee][Mm][Ee]\|[Ss][Aa][Mm][Pp][Ll][Ee]\|[Dd][Uu][Mm][Mm][Yy]\|[Pp][Aa][Ss][Tt][Ee]\|[Tt][Oo][Dd][Oo]\|[Xx][Xx][Xx])[A-Za-z0-9_\-]*(?![A-Za-z0-9_\-+/=~.]))(?![A-Za-z0-9_\-+/=~.]{0,128}[_\-]?[Hh][Ee][Rr][Ee](?![A-Za-z0-9_\-+/=~.]))(?![A-Za-z0-9_\-+/=~.]{0,128}/[A-Za-z0-9_\-+/=~.]{0,128}\.[A-Za-z]{2,5}(?![A-Za-z0-9_\-+/=~.]))[A-Za-z0-9_\-+/=~.]{20,}[\"']?(?:[\t \xa0\u1680\u2000-\u200a\u202f\u205f\u3000]+\S+)*` |
| a Notion integration token | `(?<![A-Za-z0-9])ntn_[A-Za-z0-9]{40,}(?![A-Za-z0-9])` |
| a legacy Notion integration token | `(?<![A-Za-z0-9])secret_[A-Za-z0-9]{32,}(?![A-Za-z0-9])` |
| a Stripe secret key | `(?<![A-Za-z0-9])(?:sk\|rk)_live_[A-Za-z0-9]{20,}(?![A-Za-z0-9])` |
| a Slack webhook URL | `[Hh][Oo][Oo][Kk][Ss]\.[Ss][Ll][Aa][Cc][Kk]\.[Cc][Oo][Mm](?::[0-9]*)?/[Ss][Ee][Rr][Vv][Ii][Cc][Ee][Ss]/[Tt][A-Za-z0-9]+/[Bb][A-Za-z0-9]+/[A-Za-z0-9]{20,}` |
| a Hugging Face token | `(?<![A-Za-z0-9])hf_[A-Za-z0-9]{32,}(?![A-Za-z0-9])` |
| a Linear API key | `(?<![A-Za-z0-9])lin_api_[A-Za-z0-9]{36,}(?![A-Za-z0-9])` |
| an Airtable personal access token | `(?<![A-Za-z0-9])pat[A-Za-z0-9]{14}\.[0-9a-f]{64}(?![A-Za-z0-9])` |

<!-- secret-table:end -->

27. Email addresses and IPv4 literals are **not** upload failures. `tools/scrub.py` replaces them and the owner review gate covers them, and a passport that says "reads your mailbox" or quotes a golden example containing an address would otherwise be unpublishable for no security gain. This is a deliberate difference from `scrub.py`, recorded here so nobody treats it as a bug.

28. Generic high-entropy strings are **not** upload failures either. `scrub.py` flags them for owner review, where a human can tell a git hash from a token. At upload time there is no human and the false positive rate would refuse legitimate passports. This is the honest limit of the scan: an unusual credential shape gets through, and the owner review gate is the only thing that catches it.

The refusal message must send the uploader back to the scrub step, not offer to strip the secret. Stripping it here would mean the site had a plaintext credential in memory and told the owner it was fine. It is not fine: the owner must assume that key is burned and rotate it.

---

## 6. Stage 4, derivation

Four stored columns are derived from the uploaded Markdown so the passport page renders without parsing Markdown in the browser. Derivation is part of validation: **if any field cannot be derived, the upload fails and nothing is stored.** A half-parsed passport is worse than no passport, because it renders as if it were complete.

### 6.1 `title`

The frontmatter `title`, trimmed, with internal runs of whitespace collapsed to single spaces. Maximum 200 characters, minimum one, counted in **code points** rather than UTF-16 units, so a title of 12 emoji is 12 characters and not 24. **Never truncated**, because silently shortening what the owner wrote is a lie about the passport.

A title over 200 characters, or one containing a newline, fails frontmatter validation with `E_BAD_VALUE`, which runs before derivation. `E_DERIVE_TITLE` is what a title that is empty once trimmed fails with. This paragraph said `E_DERIVE_TITLE` for both until a critic ran it: the length check is in `_validate.mjs` and fires first, so the code the spec named was one the endpoint could not emit for that input.

"Whitespace" here is the union: every character that either the Python or the JavaScript runtime calls whitespace, which is 30 codepoints rather than the 24 they agree on. The two differ over U+001C to U+001F, U+0085 and U+FEFF, so a title made of one of those six was blank to one implementation and a one-character title to the other, and the same passport rendered two different pages with no error anywhere. See ROW-211.

### 6.2 `summary`

The prose between the heading `## 1. What this agent is` and the next heading. Blank lines collapsed, leading and trailing whitespace removed.

- Must be at least 20 characters and at most 2000.
- Must contain no Markdown headings, tables, or fenced blocks. Section 1 is three sentences of prose by definition (spec section 3). Anything else means the capture put the wrong content there.
- Never truncated. Over 2000 characters fails with `E_DERIVE_SUMMARY`.

### 6.3 `needs`

Parsed from the consent table in `## 2. What it needs from you`. The table is the one in spec section 3, with five columns in this order: Capability, Why, Required / Optional, If you skip it, Installable in v0.1.

Output is a JSON array. One object per data row:

```json
{
  "capability": "reads your mailbox",
  "why": "without it the brief has no inbox items",
  "required": true,
  "required_label": "Required",
  "if_skipped": "the inbox section is omitted",
  "installable": true,
  "installable_label": "yes",
  "ref": "email.read"
}
```

- `required` is `true` when the third cell, lowercased and trimmed, starts with `required`, `false` when it starts with `optional` or with `declared`. Anything else fails.
- `declared` sets `required: false` and marks the row declared-only. **Amended.** This originally accepted `required` and `optional` and nothing else, and the repository's own example passport writes `declared only` for its `email.send` row, so the site could not render its own demo. It is also the more honest value: a capability outside the envelope is neither required nor optional, and coercing it to optional would be a small lie in a product whose thesis is not telling those.
- `installable` is `true` when the fifth cell, lowercased, starts with `yes`, `false` when it starts with `no`. Anything else fails.
- `required_label` and `installable_label` are the third and fifth cells verbatim, trimmed and not lowercased. **Added.** The booleans decide styling and the envelope; the labels are what a reader sees. Storing only the booleans forced the renderer to word the verdict itself, and what it worded ("Declared only") is in no passport, while the install block on the same page carries the passport's table verbatim. Echoing keeps page and block identical by construction.
- A renderer must print both labels, and must print each of them in full, in prose, where the length of the value cannot break the layout. Neither cell is bounded: this document caps the file at 256 KB and the table at 24 rows and caps no cell, so a passport may legitimately write `optional, but the brief is thin without it` in the third column. A fixed-size ornament such as the runtime page's stamp may carry a **clipped echo** of a label beside the full text, never the label itself.
- **A renderer must not word a verdict of its own for a row that has no label.** Rows stored before these two fields existed carry only the booleans, and the booleans are not enough to word them: the derivation that stored them set `required: false` for a declared-only capability, so "Optional" printed from that boolean contradicts the passport and the install block on the same page. Print nothing where the label is missing. This replaces an earlier allowance to fall back to wording a verdict for old rows, which was wrong on exactly the rows it was written for.
- `capability` is the first cell with **backticks removed**. **Added.** The two implementations differed here on identical input, one stripping and one storing the cell raw, and the parity harness could not see it. Stripping is correct: the value is displayed and nothing else, both renderers already set it in a monospace face, and the id a backticked token carries is extracted separately into `ref`, so the marks carry no information the object does not already hold.
- `ref` is optional. It is set when the capability cell contains a backticked token that is a valid vocabulary id, or a `money.` token that is not shaped like a data file (see the envelope floor below; a backticked `money.csv` is a filename and sets no `ref`, whether or not section 3 declares it; only the envelope floor below consults section 3, and a declared `money.csv` in an installable row is refused there while still setting no `ref`). The token is read after stripping ASCII space and tab and folding A-Z, so `` `Files.Read` `` sets `ref: files.read`. It is omitted otherwise. It is never guessed from the prose.
- At least one row is required. Twenty-four is the ceiling, matching the database constraint. A row whose cells are all empty is skipped as spacing, not counted and not refused.
- The **trailing** pipe is optional on every row, header and separator included. The **leading** pipe is not, and this file said otherwise until 2026-09-05. Both gates and the renderer select a table row with `startsWith("|")` after trimming (`tools/validate.py`, `lib/_derive.mjs`, `lib/_render.mjs`), so a row that omits its leading pipe is not a row to any of the three, while GitHub-flavoured Markdown and every ordinary editor render it as one. The disagreement runs in the direction that hides a capability: measured, `Move the fee (`money.transfer`) | ... | yes |` with no leading pipe passes both gates, and the identical row with a leading pipe is refused by both. Tracked as ROW-170. It is not patched here because accepting such a row would change what counts as a table row everywhere in the passport, including the column-count check and the separator, which is a format decision. The header's first cell is not required to read `Capability`; the column count is what is checked.
- A malformed table, a wrong column count, a missing header row, or zero data rows fails with `E_DERIVE_NEEDS`.

**The envelope floor, parts 2 and 3 (§4.6).** Both refuse; neither corrects.

- **An installable row that names a capability outside the envelope is refused.** This paragraph is the rules, and the topic sentence is deliberately not one of them. Over two days, five sentences in this section were found false by critics, and every one was a topic sentence or a summary clause left at its pre-change wording while the correction was appended further down the same paragraph: the paragraph was right at the end and wrong at the start, every time, because it is amended by appending and nobody re-reads the opening. A reader who stops early is the normal case for a paragraph this long. So the opening now points rather than claims. **Which code is raised, which cells are read, what counts as naming an id, what is trimmed, what is echoed and what is refused unread are each stated below, once, with their own history beside them.** This reads each cell's text directly, not `ref`, and every segment of it, not only the first. **Added 2026-09-05.** The Capability cell was the only one read, while `installable_label` is the fifth cell travelling verbatim into `inline()`, which renders backticks as `<code>`: `yes (via `money.transfer`)` reached the reader in monospace beside a granted stamp on a row both gates accepted (ROW-168). Every **word** of a segment lying between two backticks is also tested on its own, the word boundary being anything outside printable ASCII (see below) and not space and tab, because the four fixed ids are compared by equality and `` `email.send now` `` matched nothing, while `` `money.transfer daily` `` was refused all along on the prefix. The **word** reading applies inside backticks only, and its word boundary is anything outside printable ASCII 0x21 to 0x7E rather than space and tab, because a vocabulary id is printable ASCII by definition and `` `email.send<NBSP>now` `` split on space and tab is one word, equal to no fixed id, and reached a granted stamp in four of five cells with the id itself in byte-identical ASCII. The **segment** reading applies everywhere: a segment is tested whole wherever it lies, between two backticks, before the first, after the last, or as the whole cell when it has none. So bare prose is read exactly when a whole segment IS the id, and not otherwise. This sentence said "bare prose naming an id is deliberately not read" until 2026-09-05, which was false in the direction that hides a refusal from its author: measured, `the original used email.send to mail the digest` in a Why cell is accepted, `email.send \`see docs\`` and `` \`see docs\` email.send`` and a Why cell that is nothing but `email.send` are all refused. The prose-to-id gap described at the end of this section is therefore narrower than it was written: a word of prose inside a sentence is not read, a lone one is. The cost of reading the other four cells is an installable row whose Why or If-you-skip cell honestly backticks a write id it is not itself asking for; that row is now refused and its author drops the backticks, because nothing in the format says whether a backticked id in those cells is the row talking about itself. Every character that is **not an ASCII letter or digit** is trimmed from both ends of a candidate before comparison, down to the first and last letter or digit. This is a whitelist of what an id may end with rather than a list of punctuation marks, so it needs no Unicode table, and it therefore trims non-ASCII too: `` `money.transfeг` `` with a Cyrillic er on the end trims to `money.transfe`, which carries the `money.` prefix and is refused, and so are a CJK character, a fullwidth stop or a zero-width space in the same position. That is deliberate and this file called it "ASCII punctuation" until 2026-09-05. Nothing inside a word is trimmed; a lookalike in the interior is the opacity rule's business. The trimmed core is tested **in addition to** the candidate as written, never instead of it, so `` `(email.send)` `` is refused and `` `money.` `` stays refused. A `money.` token is an id unless it is exactly `money.<ext>` for an extension `lib/_validate.mjs` lists in `FILENAME_EXTENSIONS` (mirrored entry for entry in `tools/validate.py`; the whole suffix after the prefix is compared, so `money.transfer.csv` is an id), or unless the passport declares it as a `capability_ref`, in which case it is an id whatever its shape. Until 2026-09-04 an undeclared `money.` token was skipped outright, which accepted and stored an undeclared `money.transfer` row with `installable: true` (ROW-158). A `money.` token refuses with `E_DERIVE_ENVELOPE_TOKEN`, whose message names both fixes and says only one is true of the agent, because the token may be an honest filename the list does not know; `{token}` is filled as `money.*`, never the suffix; `{row}` is the **Capability** cell whichever cell offended, since that is what names the row and echoing the offending cell would carry a stranger's money suffix back into the message `safeRefLabel()` exists to keep it out of, and `{cell}` is the offending column's name, a fixed English string from `CONSENT_COLUMNS` in each implementation rather than a cell read out of the passport's own header, so a passport with a German header is still told "in its Why column". **Every echoed cell is sanitised three ways, and this sentence described only the first until 2026-09-05.** One, every backticked span CONTAINING a money token is collapsed to `` `money.*` ``, a span containing one and not only a span beginning with one; `{column}` was echoed raw until a probe put `money.transfer_acct_99` in the Installable cell and the suffix reached the message through it while `{token}` was correctly collapsed. Two, an UNBACKTICKED money token is collapsed the same way, because a critic put the same suffix in the same cell without backticks and it walked through both span collapses into an endpoint error. Three, every echo is capped at 200 characters with an ellipsis, because a passport may be 262144 bytes with most of them in one cell and nothing bounded the field at all. The opaque message additionally collapses everything from the first backtick to the last, greedily and without pairing, because its offending token is by definition a lookalike or an invisible and a per-span collapse leaves one standing between two empty spans. An echo invariant in both suites asserts all of this over the family rather than per message. A fixed write id refuses with `E_DERIVE_ENVELOPE_FIXED`, which since 2026-09-05 is its own code rather than the bare `E_DERIVE_ENVELOPE` it shared with the declared-only-row check below; the sharing was why the site could not name the offending column while `validate.py` could, since that check has no offending cell and an unfilled placeholder prints literally. **Both write-id messages name the escape hatch when the offending cell is not the Capability one.** Widening the scan to five cells made a message written for the Capability cell into wrong advice everywhere else: the other four are prose about the row, and telling an author whose Why cell honestly names what some other agent did to mark their own row declared-only is a lie about their agent, which is the failure this check splits the cells to avoid one cell over. The added sentence names a POSITION: write the mention in a sentence with no backticks, placed before the cell's first backtick or after its last. Two weaker spellings were measured and both were false. "Without backticks" alone is false, because a whole segment is tested wherever it lies, so a cell that is nothing but the id is refused either way. And "a word with other words beside it, outside backticks, is not read" is also false: a stretch BETWEEN two code spans has a backtick on each side, so the cell split calls it inner and scans its words, and `we read `inbox.csv` and the previous agent used email.send to mail `digest.html`` is refused although it follows that advice exactly. The split cannot tell "inside a code span" from "between two code spans" without pairing, which it refuses to do because a stray backtick shifts pairing; making innerness depend on pairing would let ``a`run email.send now`b`` through. So the conservative reading stays and the message is what names the safe positions. The cell is split on every backtick and every segment is tested, not the regex-paired spans: an odd backtick count or a double-backtick span shifted the pairing so an id was never enumerated while the page rendered it. Before either, the **opacity** rule, rewritten 2026-09-05 (ROW-167). Every word of every backtick-bounded segment of **all five cells** of an installable row is read, after stripping ASCII space and tab and only those (`trim()` and Python's `strip()` disagree on U+001C to U+001F, U+0085 and U+FEFF), and the row refuses with `E_DERIVE_ENVELOPE_OPAQUE` if the word CONTAINS an ASCII control character (0x00 to 0x1F, 0x7F), which is not text, or if it is **shaped like a write id**. Shaped like one means a word containing at least one non-ASCII character which, under either of two readings, lands on a fixed declared-only id or on the `money.` prefix: **delete** every non-ASCII character, which catches an insertion such as a zero-width space inside `email.send` or a byte-order mark after `money.csv`; or **replace** each non-ASCII character with a single-character wildcard and compare position by position after a length test, which catches a substitution such as a Cyrillic o, a one-dot leader or a fullwidth stop. Neither reading is enough alone: deletion cannot see a substitution because it shortens the word past the id, and the wildcard cannot see an insertion because it changes the length. A wildcard match must also be ANCHORED: at least one position has to match by equality on an ASCII letter or digit, or the reading is not evidence. Without that, six consecutive non-ASCII characters matched `money.` at every position, and this rule refused `Приложение.csv`, `プロジェクト.csv`, `προϋπολογισμός`, `ملفاتالحساب.csv`, `תקציבשנתי.csv`, `รายงานประจำปี.csv`, `बजटरिपोर्ट.csv`, `메모장기록.csv` and `账单明细记录.csv` in an installable row: nine scripts, in five cells, where the printable-ASCII rule it replaced refused them in one. The anchor must be a letter or a digit and not any equal character, because a full stop in position 5 was enough to keep the Korean case refused. **The residual is an open hole and it is TRADED, not free (ROW-172).** A token with no ASCII letter or digit surviving in the compared region is not a lookalike, so `ⅿоոеу․transfer_acct_99_IBAN_CH93` is accepted and reads as a payment id: U+217F SMALL ROMAN NUMERAL ONE THOUSAND is drawn as an ordinary lowercase m and U+0578 ARMENIAN SMALL LETTER VO as an n, so "fullwidth and CJK are visibly not the ASCII ones", which this paragraph gave as the reason the residual was safe, is true of `ｅｍａｉｌ．ｓｅｎｄ` and false of these. The prefix test reads six characters, so six substitutions buy an entire plain-ASCII account suffix. **Measured against deployed main, `51eb1bc`, and not against an unmerged branch.** Main carries ROW-158's opacity rule, `any(not (0x21 <= ord(c) <= 0x7E) for c in token)`, which refuses ANY non-ASCII in a backticked Capability-cell token of an installable row. So production today refuses `Приложение.csv`, `売上レポート` and `Zahlungsübersicht.csv`, which is the live bug ROW-167 exists to fix, and refuses `ⅿоոеу․transfer_acct_99` too, by the same blanket rule and by accident. ROW-167 therefore does two things against production: it **closes** a refusal of honest non-Latin passports in nine writing systems, and it **opens** one confusable route in the Capability cell that production closes as a side effect. It is a TRADED hole and not a free one. Both readings run on the word **as written and as its core**, the same trim the id scan uses; until 2026-09-05 only the id scan trimmed, so `` `(emаil.send)` `` and `` `emаil.send.` `` were read by neither scan and reached a granted stamp through both gates. There is no regex and no Unicode table, because the two runtimes carry different tables; in JavaScript the comparison iterates codepoints via `Array.from()` and not UTF-16 units, or `𝑒mail.send` (U+1D452) would be two characters to one gate and one to the other. ASCII capitals are folded first, so `MONEY.transfer` is `money.transfer`. **Until 2026-09-05 this rule refused any non-ASCII in a one-word backticked segment of the Capability cell**, which closed every lookalike and also refused `Zahlungsübersicht.csv`, `naïve.json`, `メモ/notes.md` and `2026–Q1.csv` in an installable row: 804 installable rows across three repositories carried no such token, so nothing that existed was refused and a German-speaking author's first passport was. Because the rule fires only on a word that is already shaped like an id AND carries an ASCII letter or digit matching the id in place, two restrictions came off with it. The unqualified version of that sentence was the justification for removing them and it was FALSE for nine non-Latin scripts until the anchor was added on 2026-09-05, so the rule was refusing more languages in five cells than the rule it replaced refused in one: the scoping to the Capability cell, and the carve-out that exempted any segment containing a space. `run мoney.transfer now` in any of the five cells is now refused, and `Read \`a.csv\` und dann \`b.csv\`` still passes. **The cost, stated rather than implied:** a lookalike of a money FILENAME, `money.csv` with a Cyrillic o, is refused, because both readings test the prefix and neither consults the extension list. Nothing honest spells a filename with a Cyrillic o. **And the renderer's own reading, in addition to the split one.** `inline()` pairs backticks with `` /`([^`]+)`/g `` and emits one code element per pair, so `` `email.``send` `` renders as two code elements with nothing between them, which on the page is the single unbroken monospace string `email.send`; the validator splits on every backtick and saw `email.`, the empty string and `send`, none of which is an id. Measured by a critic and reproduced: 30 of 35 combinations accepted, four fixed ids across three split points across four of the five cells, both gates. Each maximal run of ADJACENT code spans is therefore concatenated and fed to both scans in addition to the split reading, a run continuing only across an empty gap, since one space between two spans is two words to a reader. A gate and a renderer reading the same bytes differently is a hole by construction whatever either one does, and this is a model of the renderer rather than the renderer: if `inline()` changes, it silently stops modelling it. Rows whose Installable column starts with `no` are not read by this part, in any cell. Coercing `installable` to false instead is wrong and was tried on paper: the fifth cell also travels verbatim as `installable_label`, so the page would carry a "Not granted" stamp beside the passport's own word "yes", each contradicting the other in the same block.
- A passport declaring at least one declared-only capability **anywhere in section 3**, whose consent table has no row at all with `installable` false, fails with `E_DERIVE_ENVELOPE`. Anywhere, not only in the `capabilities` block, and the difference is the whole point of this check: scoping it to the block let a passport clear the entire floor by moving the `capability_ref` under `inputs:`, which was 20 of the 30 evasions a differential fuzz found. `tools/fixtures/passports/invalid_envelope_in_inputs.md` pins it. Note that part 1 above is scoped to the block deliberately and correctly: a `capability_ref` under `inputs:` is an honest line that carries no `status`, so it must not fire the status check. The two scopes differ on purpose. **Since 2026-09-08 the refusal says which of the two places it found the id in.** When every declared-only id this check found sits on an `inputs:` entry and none in the `capabilities:` block, the code is `E_DERIVE_ENVELOPE_INPUT` and the message in §7 is the one written for that case; `{refs}` is filled with the offending ids, comma-separated, any money id collapsed to `money.*` as `{token}` is. Same rule, a sibling code, for the reason `E_DERIVE_ENVELOPE_FIXED` became one on 2026-09-05: when the fix differs the message differs. (`record/proposals/row-228-refusal-code-and-payload-shape.md` proposed a `variant: "on_input"` field on the bare code with the page choosing the sentence. The decisive objection is §7's rule that `message` is the exact text the page shows, unchanged: a page-chosen sentence lives in `web/` where the test that holds this file's table equal to the site's `MESSAGES` table cannot see it, and that test is the only thing that has kept the two from drifting. The code is the deviation and the wording is the proposal's.) A declared-only id found in neither place, under `output:` say, gets the bare code and its message; neither message fits a stray id there, and that is accepted rather than given a third code. The old message tells the author to put a declared-only row in the table. For an owner who has just been asked by the write-consent gate (§8c) whether her agent writes anywhere, answered no, deleted the row and the `capabilities:` entry, and left `capability_ref: ext.write` on an input she never read as a write, that instruction asks her to reassert the thing she just denied. The block case wins when an id is in both places, because a block entry carries a `status` and is the passport's own statement about the capability. What fires the check, and when, is exactly as above.

The second of those exists because the first cannot carry the rule alone, and the reason is in the format. `ref` is set only from a backticked token (above), the Capability column is otherwise prose written for a person, and **nothing in the format links a consent row to a capability id**. `examples/daily-brief-passport.md` backticks nothing, so a check resting on `ref` alone is vacuous on the repository's own flagship. Part 3 cannot say which row is lying. It makes the flat version of the lie impossible, which is as far as a deterministic check reaches. Closing the gap properly means a machine-readable id column in the consent table, which is a format change and not this document's to make.

This is the one place derivation reads the section 3 YAML, and it reads it only to decide whether the consent table owes the reader a declared-only row. It does not derive `needs` from it, per the paragraph below.

The endpoint must not fall back to deriving `needs` from the `capabilities` list in the section 3 YAML. Those two lists can legitimately differ, and the consent table is the one a human read and the one the page shows. If the consent table is unparseable, that is what needs fixing.

### 6.4 Frontmatter-derived columns

`capture_path`, `passport_version` (from `passport`) and `owner_confirmed` are copied verbatim from validated frontmatter. `validated_at` is the current server time. `validator_version` is the rules version at the top of this document.

### 6.4a Section structure: `golden_parts`

Sections 2, 4 and 6 carry prose beside their tables and fenced blocks, and both renderers split them with the same rule. The endpoint stores the body and splits it at render time; `scripts/passport-to-page.py`, which generates the standalone page offline, stores the split under the key `golden_parts` for section 4. Either way the shape is the same:

```json
[ { "kind": "prose", "text": "This is a synthetic example…" },
  { "kind": "block", "text": "MORNING BRIEF, Saturday 9 August\n…" },
  { "kind": "prose", "text": "Templates of shape, not expected content." } ]
```

- **Order is the contract.** A paragraph renders where the passport put it: above the block it introduces, below the block it qualifies. This replaces a per-example `note` list and a `golden_closing_note` field, which encoded a placement rule ("prose attaches to the block below it, except after the last block") that the two renderers had each guessed differently, so one passport's elision note landed on a different example depending on which page you opened.
- A section ends at the next level-1 or level-2 heading that is **not inside a fenced block**. A `###` sub-heading is that section's own content and renders as a paragraph with its marker removed; it is neither a boundary nor a line to drop.
- A fence closes on a run of backticks at least as long as the one that opened it. A shorter run inside a longer fence is content, so a four-backtick example quoting a three-backtick block is one block.
- A paragraph that is a single angle-bracketed instruction is an unfilled capture template and is dropped, not printed. Upload refuses such a body anyway under 5.1 check 21; the rule matters to the offline generator, which does not run that gate.
- **How lines become paragraphs**, all four load-bearing and all four checked by parity: consecutive non-blank lines join into one paragraph separated by a single space; a blank line ends the paragraph; a table row (a line whose first non-space character is `|`) ends the paragraph and is itself dropped, because a consent or losses table is rendered as a table and not narrated twice; and a list item starts a paragraph of its own. The last of these exists because joining them ran a numbered elision list together as `1. items 4-11 removed 2. shape preserved`, where the `2` reads as part of the removal.
- Section 4 carries one to three blocks. Zero, more than three, or a fence left open fails with `E_DERIVE_GOLDEN`.
- Prose renders through the same inline-Markdown reader as the rest of the page: code, bold, italic, and a link shown as its label followed by the visible URL, never as an anchor.

`web/tools/parity.mjs` runs both implementations over every fixture and diffs this structure part by part. `scripts/passport-to-page.py --dump-parts` is what it calls on the Python side.

### 6.5 Storage and the disagreement case

Stage 5 is a single call to `public.create_passport`. Call it as `select * from create_passport(...)`, never `select (create_passport(...)).*`, which evaluates the function once per output column and inserts two rows. A PostgREST or supabase-js RPC call is safe.

If that call is refused by a database constraint or the insert policy, the endpoint's rules and the schema's rules have drifted. That is a bug in this system, not in the upload. The endpoint returns `E_INTERNAL` with a neutral message, logs the row's would-be values minus the body, and pages whoever owns the deployment. It does not retry, does not relax, and does not tell the uploader their file was bad.

---

## 7. Failure responses

One row per failure mode. `status` is the HTTP status. `code` is the machine code in the JSON body. `message` is the exact text the create page shows, unchanged.

Response body shape, always:

```json
{ "ok": false, "code": "E_HTML", "message": "...", "details": ["line 41: <img>"] }
```

`details` is optional, is an array of strings, and is shown under the message as a plain list. It never contains the body content itself, only locations and identifiers.

**Two 409 responses carry more than that shape, and both are refusals of a well-formed passport.** `E_OWNER_UNCONFIRMED` and `E_WRITE_UNCONFIRMED` (§8b, §8c) each add an `ack` ticket. When a `capture_path: browser` passport trips both gates on one POST it is refused once, not twice: the body carries a `refusals` array with one entry per gate still unresolved, owner-review first, and the first entry is spread at the top level, so a client that reads only `code`, `message` and `ack` sees a coherent single-problem response. When only one gate fires, `refusals` has one entry and the top level agrees with it. The write entry additionally carries `capability_markers` and `consent_rows`, described in §8c. One refusal, one failure charge, however many gates are in it. **Added 2026-09-08 (ROW-228).**

```json
{
  "ok": false,
  "code": "E_OWNER_UNCONFIRMED",
  "message": "...",
  "ack": "<owner-review ticket>",
  "refusals": [
    { "code": "E_OWNER_UNCONFIRMED", "message": "...", "ack": "<owner-review ticket>" },
    { "code": "E_WRITE_UNCONFIRMED", "message": "...", "ack": "<write-consent ticket>",
      "capability_markers": [ { "id": "ext.write", "lines": ["  - capability_ref: ext.write", "    status: declared_only"] } ],
      "consent_rows": [ { "line": "| Write to Notion | ... | ... | ... | no, declared only |" } ] }
  ]
}
```

| status | code | message shown on the create page |
|---|---|---|
| 415 | `E_CONTENT_TYPE` | This does not look like a Markdown file. Upload the .md file the capture produced, or paste its text. |
| 413 | `E_TOO_LARGE` | That file is larger than 256 KB. A passport describes an agent, it does not contain one. Trim the golden examples and try again. |
| 422 | `E_TOO_SMALL` | That file is too short to be a passport. Check that you copied the whole thing, including the frontmatter at the top. |
| 422 | `E_NOT_UTF8` | This file is not valid UTF-8 text. Save it as UTF-8 and upload it again. |
| 422 | `E_CONTROL_CHARS` | This file contains control characters that do not belong in a text document. Re-export it from your editor as plain UTF-8. |
| 429 | `E_RATE_LIMIT` | Too many uploads from this network. Try again in an hour. |
| 429 | `E_DELETE_LIMIT` | Too many delete attempts from this network. The limit is 20 in an hour, counted per network and not per passport. Try again in an hour; your passport and its token are unaffected. |
| 409 | `E_DUPLICATE` | This exact passport was uploaded a moment ago. If it was published, use the link you already have. If the page said it was waiting for a person to look at it, it still is, and uploading it again will not change that. |
| 422 | `E_FRONTMATTER` | The block at the top of the file is missing or unreadable. A passport starts with three dashes, then the key and value lines, then three dashes. |
| 422 | `E_MISSING_KEY` | The passport is missing required information at the top of the file. Missing: {keys}. Re-run the capture rather than filling these in by hand. |
| 422 | `E_BAD_VALUE` | One of the values at the top of the file is not valid: {field}. Expected {expected}. |
| 422 | `E_UNKNOWN_VERSION` | This passport says it is format version {version}. This site only reads version 0.1. |
| 422 | `E_BAD_ENVELOPE` | This passport declares the envelope {envelope}. Version 0.1 only accepts read-notify. An agent that writes to the world can still be captured, but its write capabilities are listed and not installed. |
| 422 | `E_SECTIONS` | The passport is missing one or more of its six sections, or has one twice. Missing or duplicated: {sections}. |
| 422 | `E_SECTION_ORDER` | The six sections are present but out of order. They must run from "What this agent is" through to "Losses". |
| 422 | `E_COMPARISON_MODE` | The functional spec is missing a valid comparison_mode, or has more than one. It must appear exactly once and be structural, exact, or input_relative. |
| 422 | `E_CAPABILITY` | The passport asks for a capability this site does not recognise: {refs}. Capabilities come from the published vocabulary and cannot be invented at capture time. |
| 422 | `E_ENVELOPE_FLOOR` | This passport declares the read-notify envelope and then marks a capability that writes to the world as something this version installs: {refs}. Version 0.1 lists those and does not install them. Re-run the capture so they carry status declared_only and read "no, declared only" in the consent table. |
| 422 | `E_DERIVE_ENVELOPE` | The consent table offers to install a capability that writes to the world, which the read-notify envelope does not install. A capability outside the envelope belongs in that table, and its last column reads "no, declared only". |
| 422 | `E_DERIVE_ENVELOPE_TOKEN` | Consent row "{row}" names `{token}` in its {cell} column, which writes to the world, and its Installable column says "{column}". Two fixes, and only one of them is true of your agent: if the backticked token is a filename, write it without backticks; if it is a capability that moves money, the column reads "no, declared only". Never write the second when the first is the truth.{prose} |
| 422 | `E_DERIVE_ENVELOPE_FIXED` | Consent row "{row}" names `{token}` in its {cell} column, which writes to the world, and its Installable column says "{column}". Two fixes, and only one of them is true of your agent: if this row installs that capability, its Installable column reads "no, declared only"; if it does not, the cell should not name it as one.{prose} |
| 422 | `E_DERIVE_ENVELOPE_OPAQUE` | Consent row "{row}" backticks a token in its {cell} column that this site will not repeat back, because it is either an ASCII control character, or a capability id spelled with a lookalike character, such as a Cyrillic o in place of the Latin one, or a zero-width space inside the word. Its Installable column says "{column}". If the token is a capability that writes to the world, that column reads "no, declared only"; never write that when it is not true of your agent. If it is an honest filename, retype it: the characters that look wrong are not the ones you meant. |
| 422 | `E_DERIVE_ENVELOPE_INPUT` | Section 3 names a capability that writes to the world on one of the agent's inputs, {refs}, and the consent table has no row reading "no, declared only". Two fixes, and only one of them is true of your agent: if the original agent did use that capability, the consent row belongs back and its last column reads "no, declared only"; if it did not, the table is not what is wrong, the input is. Change that input's capability_ref to the capability the original actually read it with, or delete the input. Never write the row back to satisfy this message when the agent did not write there. |
| 422 | `E_FENCE_INVISIBLE` | A line in this passport carries an invisible character before its code fence, so the fence never opens and the block below it is read as prose. A Markdown renderer will not open a code block there either. Delete the character before the backticks. |
| 422 | `E_GOLDEN_COUNT` | A passport needs between one and three golden examples. This one has {count}. Examples are the evidence that the agent does what the passport says. |
| 422 | `E_SCRUB_GATE` | This passport contains redacted sections, but nobody confirmed they were reviewed. Re-run the capture and complete the review step before sharing. |
| 422 | `E_DENIED_PATH` | This passport names a file or folder that capture is not allowed to read: {names}. Re-run the capture. |
| 422 | `E_HTML` | Passports are Markdown only. This one contains HTML: {tags}. Remove it and upload again. |
| 422 | `E_UNFILLED` | The capture did not finish. This passport still carries the template's own placeholders: {tags}. Replace each one with the real thing. If they are the losses table in section 6, delete the placeholder row and leave that table empty, because the install is what fills it in. |
| 422 | `E_ACTIVE_CONTENT` | This passport contains a link or URI that can execute code. Remove it and upload again. |
| 422 | `E_SECRET_FOUND` | This passport still contains something that looks like a credential: {kinds}. It was not stored. Remove it from the passport and upload again, then treat that credential as exposed and rotate it. If you captured this in a chat rather than with the skill, scroll back to the block you copied and fix it there. |
| 422 | `E_DERIVE_TITLE` | The title at the top of the file is empty once invisible characters are removed. Give it one line a stranger can read at a glance. An over-long title is refused earlier, as `E_BAD_VALUE`. |
| 422 | `E_DERIVE_SUMMARY` | Section 1 could not be read as a description. It should be three plain sentences: what the agent does, when it does it, and what the output is for. |
| 422 | `E_DERIVE_NEEDS` | The table in section 2 could not be read. It needs five columns: capability, why, required or optional, what happens if skipped, and whether it installs in v0.1. |
| 404 | `E_NOT_FOUND` | No passport at this link. It may have been deleted, it may have expired, or the link may be incomplete. |
| 404 | `E_DELETE_FAILED` | That delete token does not match this passport. Nothing was deleted. |
| 409 | `E_OWNER_UNCONFIRMED` | This passport has not been through its owner review. Nobody confirmed that what it says about the agent is true, or that the redactions were checked. Publishing it is still your call, but you are publishing something that has not been read. |
| 409 | `E_WRITE_UNCONFIRMED` | This passport was captured in a chat, and it marks something as declared only: a capability its original had that this version will not install, which is how a passport records a write to somewhere outside the agent. The lines that say so are listed below. Nobody but you can say whether they are true of the agent. If they are, publish it as it stands: nothing on those lines is installed for the recipient. If they are not, delete them from your paste and upload it again. This answer is open for fifteen minutes. |
| 429 | `E_SEND_LIMIT` | Too many emails from this network. The limit is 10 in an hour. The passport is published and the link works; send it yourself in the meantime. |
| 429 | `E_SEND_PASSPORT_LIMIT` | This passport has been emailed five times today, which is the most one link can be sent from here in a day. The passport is published and the link works; copy it and send it yourself, or try again tomorrow. |
| 429 | `E_SEND_DAILY_LIMIT` | This site has sent as many emails today as it allows, either to this address or in all. The passport is published and the link works; copy it and send it yourself, or try again after midnight UTC. |
| 422 | `E_SEND_ADDRESS` | That does not look like an email address this site can send to. Check it, or copy the link and send it yourself. |
| 503 | `E_SEND_DISABLED` | Sending email is not switched on for this deployment. The passport is published and the link works; copy it and send it yourself. |
| 502 | `E_SEND_FAILED` | The email did not go out. The passport is published and the link works, so copy it and send it yourself rather than trying again. |
| 404 | `E_MANAGE_FAILED` | That link and token do not go together. Check that you pasted both in full. |
| 429 | `E_MANAGE_LIMIT` | Too many attempts from this network. The limit is 20 in an hour, counted per network and not per passport. Your passport and its token are unaffected. |
| 422 | `E_CATEGORY` | To list a passport in the gallery, pick one of the categories. Nothing was published: choose a category and publish again, or untick the box to publish without listing. |
| 404 | `E_VOTE_FAILED` | That vote was not recorded. The passport may not be listed in the gallery any more, or the link may be incomplete. |
| 429 | `E_VOTE_LIMIT` | Too many votes from this network. The limit is 30 in an hour, counted per network. Try again later. |
| 405 | `E_METHOD` | This endpoint does not accept that method. Nothing was read and nothing was changed. |
| 403 | `E_CROSS_SITE` | This request did not come from a page on this site, or the browser that sent it did not say where it came from, so it was refused. Nothing was read and nothing was changed. |
| 500 | `E_INTERNAL` | Something failed on our side. The passport was not stored. Nothing was published. |

Two rows above are deliberately identical in effect and must stay that way:

- `E_NOT_FOUND` is returned for a uuid that never existed **and** for one that was deleted. Same status, same body, same headers. A visitor must not be able to tell the two apart.
- `E_DELETE_FAILED` is returned for a wrong token **and** for a uuid that does not exist. Same reasoning. Do not "improve" the message to say which one it was.

---

## 8. Relationship to `tools/validate.py`

Two implementations of one rule set, in two languages, on two sides of the system. They will drift unless something stops them.

**Authority, in order:**

1. `spec/passport-0.1.md` is normative. Where either implementation disagrees with the spec, the implementation is a bug.
2. `tools/validate.py` is the reference implementation of the **format rules** (section 4 of this document). Where the endpoint and `validate.py` disagree about a format rule and the spec is silent, `validate.py` wins and the endpoint is fixed to match. It wins because it is the one the capture skill runs, which means it is the one owners hit first.
3. This document is the sole authority for the rules `validate.py` does not implement: transport (section 2), rate limits (section 3), untrusted content (section 5), derivation (section 6), and every response in section 7. `validate.py` must never grow these. It runs on the owner's own file on the owner's own machine, where they are the wrong checks.

**Keeping them in sync, concretely:**

- Both carry the rules version string, `0.1.0`. `validate.py` exposes it as `RULES_VERSION`; the endpoint stores it in `validator_version` on every accepted row.
- The shared fixture corpus is `tools/fixtures/passports/`, with `tools/fixtures/validator/` (checks 12 to 15 of `validate.py`, which the endpoint does not run) and `tools/fixtures/transport/` (stage 1) beside it. Every format rule in section 4 has at least one fixture that violates it and exactly one expected verdict.
- CI runs both implementations over the whole corpus and compares verdicts rule by rule. A mismatch fails the build. This is the only mechanism that actually holds; the rest is intention.
- **This now exists**, as `web/tools/parity.mjs`, run from `web/build.sh` and from `tools/run_tests.sh`. It compares verdicts, not error text: the two have different vocabularies on purpose, and what must never differ is the answer to "would this be stored". Each side is compared as it runs: `validate.py` and `tools/preflight.py` together, as the capture skill runs them, against `transport()`, `validate()` and `derive()`, as the upload does. Its table of allowed divergences, `ALLOWED`, is not empty. It records the ten `validator/` fixtures (checks 12 to 15), a file whose every line break is a lone CR, and a leading BOM, each pinned exactly with its written reason beside it, and an entry that stops being true fails the build. A divergence added to it needs a written reason too.
- It found three real things the first time it ran, all since fixed. `validate.py` required `created` to be present and never looked at it, while the endpoint refused a malformed or future date, so a capture could pass its own loop and be refused on upload; that is now check 10. `validate.py` accepted a `## 2.` containing one line of prose, while the endpoint refused a passport with no consent table, so a capture could emit a passport with nothing to consent to and be told it was valid; that is now check 11. And the endpoint accepted `created: 2026-02-31`, because `Date.parse` rolls an impossible date forward to 3 March rather than failing.
- Changing any format rule means: edit the spec, edit `validate.py`, edit this document, add a fixture, bump `RULES_VERSION` in both, in one change. A version bump with no fixture is a review failure.
- Because `validator_version` is stored per row, a later tightening of the rules can find every row that was admitted under the older ruleset without guessing from `created_at`.

---

## 8b. The owner-review ticket

`owner_confirmed: false` is not a validation failure. The passport is well formed
and may be published; it has simply not been read by the person it describes. The
endpoint refuses it once with `E_OWNER_UNCONFIRMED` and returns an `ack` in the
body: 18 bytes of randomness as 36 hex characters, of which only the sha256 is
stored. The retry presents it in `x-passport-owner-ack`.

The record is keyed on the ticket and the body's sha256 together, so no part of
the body is stored: a request presenting the wrong body computes a key that is
not there. It is consumed on use and dead after fifteen minutes, and the store is
bucketed by ticket window so a sweep can clear the records of everybody who hit
the stop and closed the tab.

The ticket carries nothing to refund. It is proof that the request is downstream
of a refusal the server issued, and it buys the right to publish rather than a
discount on it: the refusal is charged to the failure ceiling like any other, and
the retry pays its own upload attempt.

Two rules follow from how the first version of this failed, and neither is
optional:

- **The acknowledgement must not be a constant.** It was `unconfirmed`, a fixed
  string any client could send on its first request, which made the word
  "unskippable" in §7 untrue.
- **A refusal must cost something.** The refusal used to refund both attempts
  before checking anything the server controlled, so a client that never
  acknowledged could put unlimited 256 KB bodies through the full validator
  without the limiter recording a single attempt. Making the refund conditional
  on a server ticket bounded that but did not price it: alternating refuse and
  retry still ran the validator twice per recorded attempt.

What this enforces is that the exchange happened, not that a person read the
paragraph, which no stateless endpoint can establish. The rendered passport
prints the owner's non-confirmation on its second page regardless.

---

## 8c. The write-consent ticket

**Added 2026-09-08 under ROW-227 and ROW-228**, from
`record/proposals/where-the-owners-yes-no-on-a-declared-only-write-row-lives.md` and
`record/proposals/row-228-refusal-code-and-payload-shape.md`. This section is the normative
statement of that design; where the proposals and this file differ, this file wins and the
difference is named below.

**What it is for.** A passport captured in a chat (`capture_path: browser`) carries a
declared-only write capability when the interviewer decided the original agent could write
somewhere, and the interviewer decides that from pasted text and an owner's answers, not from
the agent's files. Measured on one fixture whose agent writes nowhere: the shipping prompt put
`capability_ref: ext.write` into section 3 in four of eight runs (09-05), three of them after
the owner had denied a write in her own words, and the cause is a credential sitting in the
pasted instructions (09-08, zero of ten without it; the two arms ran on different Vertex serving
regions, which the finding names and cannot rule out). The recipient of that passport is told the
original wrote to Notion. Nothing on the upload path asked the one person who knows. This gate
asks, once, and the passport is refused until she answers.

**When it fires.** `capture_path` is `browser` and the passport carries a declared-only marker
in **either** of the two places one can appear:

- an entry in section 3's `capabilities:` block whose `capability_ref` is a declared-only id
  (`email.send`, `msg.send`, `social.post`, `ext.write`, any `money.` prefix), read
  entry-scoped, the walk the envelope floor's status check makes, **over lines with
  block-scalar content stripped first** (`stripBlockScalarContent`, ROW-210), which the wide
  `declaresWrite` scan does and the floor's status walk today does not. That difference is
  not academic: a critic put `capability_ref: ext.write` inside a `notes: |` scalar on a
  `capabilities:` entry and the floor refused it `E_ENVELOPE_FLOOR` while the wide scan,
  correctly, saw nothing. That is the floor's defect and this gate must not inherit it: a
  quoted config line in a notes field is the false refusal ROW-210 exists to stop; or
- a consent row in section 2 whose Installable column starts with `no`, which is the
  `installable: false` derivation already holds. **Any such row, whatever it is about.**
  `installable` is set from the fifth cell's text alone (`_derive.mjs:216`), nothing links a
  row to an id (§6.3), and a browser passport with no write anywhere and one `no` row about
  running unattended overnight fires this gate (built by the critic, validates and derives
  clean). The gate cannot tell a write from anything else the owner marked not installable,
  and the message therefore says "declared only" and not "write"; "no, declared only" is the
  value §5 of the format assigns to a capability outside the envelope, and a row that carries
  it about something else is the owner's own wording put to the owner.

Both reads, because either alone leaves a hole a critic built and ran: an owner who deletes only
the section 3 entry produces a passport that passes both validators and still tells the
recipient her agent wrote to Notion. The section 2 read closes that; the section 3 read closes
the mirror image. A declared-only id on an `inputs:` entry is **not** a marker for this gate.
The first memo said "inputs included" and the ROW-228 proposal says the `capabilities:` block,
and this file follows the proposal, which is a difference from the memo and is named here as
one: an input entry carries no `status`, the gate reads the passport's own statements about
capabilities, and the envelope floor already covers the input case. Both halves were built and
run: an id on an input beside a `no` row derives clean and this gate fires on the row; the same
passport with the row deleted is refused by the floor with `E_DERIVE_ENVELOPE_INPUT` (§6.3),
which is the refusal written for it.

This is a declared-only gate and not an `ext.write` gate. Every declared-only id is write-class
and the gate cannot tell a false `ext.write` from a true `email.send`, so an honest browser
passport with a real write is asked once too, and its owner answers yes once. `capture_path:
file` is never gated: a file capture read the agent's own bindings, its declared-only rows are
what the skill found rather than what an interviewer inferred, and the 08-16 field passport's
`ext.write` is real.

**What it says.** A 409 with `E_WRITE_UNCONFIRMED`, an `ack` ticket, and two lists:
`capability_markers`, one entry per offending block entry as `{id, lines}` where `lines` is
the literal text of the `capability_ref` line and its `status` line; and `consent_rows`, one
entry per `no` row as `{line}`, the row's raw text. The lists are not paired. Nothing in the
format links a consent row to an id (§6.3), so with one of each the page may show them together
and with two of each it shows two lists, and this file does not pretend otherwise. The lines
are echoed **verbatim, money suffixes included**, which is the one place in this file that is
true: this response is never logged (`recordRejection` stores `{v, day, code}` under a random key,
`_metrics.mjs` `rejectionRecord`, and no passport text reaches it) and it returns only to the
browser that sent the bytes, so `safeRefLabel()` and
`safeCellEcho()` are the wrong tool here and stay in use everywhere else. The closing sentence
some passports carry under the table ("this agent's original could do that") is prose with no
grammar the validator parses, so it is **not** in the payload; the page tells the owner to look
for one rather than being handed a line reference that may be wrong.

**"Yes".** The retry presents the ticket in `x-passport-write-ack`. The record behind it is the
owner-review record's shape (§8b) plus a `reason` field, and the reason must be
`write_consent`: a ticket minted by the owner-review refusal presented in this header, or the
reverse, is treated as absent and that gate refuses again. This is why `mintAck` and `readAck`
gain a required reason. Without it, a ticket minted by this refusal would satisfy the
owner-review gate, and a passport with `owner_confirmed: false` would publish on its second
POST having been read by nobody; that was the second critic's finding on the sequential draft
and it is the reason the field exists. On a valid ticket the bytes publish **exactly as
pasted**. The endpoint has never rewritten a passport before storing it and does not start
here; the row the owner said yes to renders as declared only, is read aloud at consent and at
skip (`installer/core.md:39`, `:84`), and takes its losses row at install (`:168`).

**"No".** The page shows the lines and tells the owner to delete them from her own paste and
upload again. There is no strip endpoint and no partial accept. The retry is a fresh POST with
a fresh fingerprint, judged against both gates from its own bytes. If she deleted the row and
the entry and an input still carries the id, the envelope floor refuses with
`E_DERIVE_ENVELOPE_INPUT` and the message written for exactly that case. If she deleted the `no` row and not
the entry, this gate fires again on the entry; if the entry and not the row, on the row.

**Combined with owner-review.** Evaluated together, refused together, priced once: the
`refusals` shape in §7. The page reads `refusals`, every entry, and retries with every header
the entries gave it; the top-level spread is coherence for a client that reads one field, not
a licence to act on one. A client that retries with the owner-review ticket alone is refused
again by this gate, priced again, and that is by design. A browser passport that is both
unconfirmed and marked, whose owner answers **yes**, costs two POSTs and one failure charge:
refused once with two tickets, published on the retry with two headers. An owner who answers
**no** edits the paste, and the tickets are keyed on the ticket and the body's sha256 together
(§8b), so both die with the old bytes: the fresh POST is refused by owner-review again, with a
fresh ticket, and by this gate again if a marker survived. Three POSTs and two failure charges
on the no-then-fix path, against a failure ceiling of five; the first memo's "three POSTs, two
charges" was written for a sequential design and is right for this path by a different route,
and the ROW-228 proposal's "at most two" is right for the yes path only. Both tickets are burned
after `createPassport` succeeds, in a second burn slot beside the existing one, and neither
burn may throw, because by then a delete token exists nowhere but the response.

**What is counted.** One rejection record per entry in `refusals`, not one per POST. Every
existing refusal writes one row keyed on its code (`upload.mjs`, `recordRejection`), and the
metrics reader subtracts `E_OWNER_UNCONFIRMED` to get failures other than a gate the sharer
then passed (`_metrics.mjs`); if a combined refusal wrote one row under the top-level code, the
write gate would be invisible in the corpus on exactly the passports it exists for, because
owner-review is always first. With one row per entry the reader subtracts both gate codes. And
`rejectionRecord` returns `null` for a code that is not a key of `MESSAGES`, and
`recordRejection` drops a null silently, so a new code that reaches the wire before it reaches
`MESSAGES` is refused correctly and counted never. The test in `tools/run_tests.sh` that holds
this file's table equal to `MESSAGES` is what catches that before merge, and it is failing on
the branch this section was written on until `web/lib/_validate.mjs` carries both new strings.

**The clock and the ceiling.** `ACK_TTL_MS`, fifteen minutes, shared by both ticket kinds; the
page states the number, and the message above does. An owner who runs out of time re-POSTs and
is refused afresh, priced afresh. Out of attempts is `E_RATE_LIMIT` from `up-h`, charged at the
top of the handler before either gate runs; no code is added for it.

**What this gate does not see, so nobody reads it as more than it is.**

- **A row flipped to `yes`.** An owner who keeps the row and edits its fifth cell from `no,
  declared only` to `yes` publishes an installable write past both validators and both reads.
  That is the format's hole, not this gate's: the consent table has no machine-readable id
  column (§6.3, `_derive.mjs`), and only a format change closes it. The gate catches
  over-declaration while the markers survive; it does not make a lying owner honest.
- **A row that is absent.** The other half of the measured defect is a write the interview
  never asked about. No gate on stored bytes can tell "never had a write" from "had one and the
  interviewer missed it". The gate polices what the passport claims, not what it omits.
- **The prose sentence.** Above.
- **`capture_path` itself.** It is a frontmatter line the validator checks for being one of
  two words (`_validate.mjs`) and nothing attests it. An owner who edits `browser` to `file`
  is not asked. The gate is for the honest owner of an interview that over-declared, which is
  the measured case; it is not a defence against an owner who edits the frontmatter to skip a
  question, and neither is anything else on this endpoint.
- **Whether the answer is true.** As with §8b, what is enforced is that the exchange happened.

**Relation to the prompt.** The prompt's own rule R8 says the owner's denial removes the row,
and a sentence added on 2026-09-08 says a credential in the pasted text is not grounds for a
row. Those lower how often this gate fires. They are not the gate: R8 was obeyed one time in
four when it applied, and the prompt runs on a model in someone else's browser where nothing
this endpoint controls can check what it did. The gate fires zero times on a correct passport
and costs nothing there, so it has no retirement condition.

---

## 9. Delete tokens

### 9.1 Generation

The token is generated inside `public.create_passport`, in the database, from `gen_random_bytes(20)`. That is 20 bytes of cryptographic randomness, 160 bits, rendered as 40 lowercase hexadecimal characters.

It is generated in exactly one place. The endpoint must not generate its own, must not derive one from the uuid, and must not offer a "choose your own" option.

### 9.2 Storage

Only `encode(digest(token, 'sha256'), 'hex')` is stored, in `delete_token_hash`: 64 lowercase hex characters. The plaintext exists in the return value of one function call and nowhere else. It is never written to a log, never included in an error, never stored in a cookie, and never persisted server side.

**Amended: one narrow exception for email.** `WEBSITE-SPEC.md` §4 requires that the delete token reach the sharer visibly, "success screen and, if they used email send, in their copy of the email". So the sender's copy may carry the token, under three conditions and no others:

- The sharer asks for it. The box is unticked by default and the screen states, before it is ticked, that the copy carries the token and that anyone who reads that message can take the passport down.
- It goes only to the address the sharer typed for their own copy. It is never in the recipient's message.
- Nothing else changes. The token is still not logged, not stored in plaintext, not reissuable, and not recoverable.

This is a real weakening of a previously absolute sentence and it is written down as one. What makes it affordable is expiry: since a passport now comes down by itself after thirty days, losing the token is no longer the difference between a page that can be withdrawn and one that cannot. If that trade is not wanted, remove the copy checkbox from `share.html` and `manage.html`, drop `senderCopyMessage` from `web/lib/_email.mjs`, and restore the sentence above.

No salt, deliberately. Salting defends against precomputation over a guessable input space, and 160 random bits have none. A per-row salt here would add a column and defend against nothing.

### 9.3 Display

Returned once, in the success response of the upload, alongside the passport link. The create page shows it in a copyable block with the warning in `create-page.md` section 5. There is no second chance to see it, no recovery flow, and no support path. If it is lost, the passport is permanent until an operator removes it by hand.

The success response:

```json
{
  "ok": true,
  "id": "7542f457-a959-461b-b628-6dd675eb96d7",
  "url": "https://<site>/p/7542f457-a959-461b-b628-6dd675eb96d7",
  "delete_token": "ec456d9f6ea7b9566210479a1e18c91f8139847c"
}
```

The endpoint must not log this response body. Standard access logging of the request line is fine; response body logging must be off for this route specifically.

### 9.4 Verification

Deletion is `select public.delete_passport(<uuid>, <token>)`. The database hashes the presented token and compares it to the stored hash inside the row level security policy. The endpoint never reads `delete_token_hash` and could not, since it holds no read privilege on the table.

The function returns `true` when exactly one row was deleted and `false` otherwise. `false` covers a wrong token, a malformed token, and a uuid that does not exist, and the endpoint must render all three as the single `E_DELETE_FAILED` response in section 7.

Before hashing, the endpoint checks the token against `^[0-9a-f]{40}$` and returns `E_DELETE_FAILED` on a mismatch without calling the database. That is a cheap filter, not a security boundary.

Deletion is immediate and irreversible. There is no soft delete, no tombstone and no undo, because a tombstone would answer the question "did a passport ever exist at this uuid", which section 7 exists to refuse.
