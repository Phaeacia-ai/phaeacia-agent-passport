/* The one address this product has, and the only place it is written down.

   It lived in _render.mjs, which was correct while the renderer was its only
   consumer. ROW-63 gave it two more, both of which build links that LEAVE THE
   BUILDING: send.mjs puts one in an email this domain signs, and upload.mjs
   returns one the publisher pastes to someone else. Importing a
   thousand-line renderer into the upload and email bundles for one string is
   the wrong shape, so the string moved here and _render.mjs imports it.

   WHY A CONSTANT AND NOT THE REQUEST. Every one of those links used to be built
   from `new URL(req.url).origin`, which is the Host header.

   WHAT WAS MEASURED, stated exactly, because an earlier version of this comment
   cited these probes as though they covered more than they do:

     ESTABLISHED. Three unknown hosts — evil.example.invalid, attacker.test and
     phaeacia.ai.evil.com — all 404 against app.phaeacia.ai on a static path.
     A hostname the account owns routes to its own site. So the edge routes by
     Host and refuses one it does not own, 3 of 3.

     NOT ESTABLISHED. What a FUNCTION invocation sees. The probe attempted
     requested /p/<all-zero-uuid> with a bad Host and with the correct one, and
     both returned 404 — the correct host 404s because that passport does not
     exist. The negative control produced the same output as the test case, so
     the probe cannot distinguish "Host refused" from "passport not found" and
     establishes nothing.

     UNTESTED. Deploy-preview behaviour. deploy-preview-1--phaeacia.netlify.app
     does not resolve, because no pull request has ever been previewed. The
     residual risk this constant removes has never been observed in the wild and
     cannot currently be reproduced.

   That functions sit behind the same host-based routing is a reasonable
   inference and is probably true. It is an inference.

   AND THE FIX DOES NOT REST ON ANY OF IT, which is the point. Deriving the link
   from a constant is correct whatever the edge does, and it is correct
   PRECISELY BECAUSE nobody has to reason about the edge to be sure of it. The
   measurement bears only on how urgent this was, never on whether it is right.
   A link that leaves the building should name the product's address whatever
   host served the request, and there is no case where the sender's current
   hostname is relevant to a stranger reading mail next week.

   IF THIS EVER CHANGES, this is not the only place the host is written. A first
   draft of this comment named "three other places" and listed them, which was a
   guess: `grep -rl app.phaeacia.ai web/` returns FIFTEEN files outside lib/.
   It was thirteen until the router split `/` into index.html and upload.html and
   added create.html; a count in a comment ages against a directory.
   No list is given here on purpose, because a list in a comment is a claim that
   ages against a directory anyone can add to, and the enumeration is one grep
   away for whoever needs it.

   What is worth knowing rather than counting is that they fall into two kinds.

   THE BROWSER has its own copy, because classic scripts cannot import and a
   bundler for one string is not a trade worth making. There is exactly one of
   it, `window.PHAEACIA_CANONICAL` in `assets/site.js`, which every page loading
   `card.js` or `manage.js` loads first. Both read it; neither names a host.

   Two things are asserted about that, and the second exists because the first
   was not enough. An earlier version of this paragraph said the pair "fails
   loudly instead of drifting into a share button that copies the wrong host",
   and a critic showed that was false in one direction: the test then checked
   that card.js did not RE-DECLARE the canonical string and did not read the
   address bar, and said nothing about it simply naming a third host at its use
   site. It replaced card.js:665 with a preview hostname and every suite stayed
   green.

   So run-tests.mjs now asserts (a) site.js's literal equals this one, and (b)
   those scripts contain NO `http(s)://` literal at all, plus that site.js is
   loaded before anything reading the global. "Not the canonical string" guards
   the example you thought of; "no host at all" guards the class.

   Everything else is static `og:` markup in the page HTML. Those are not
   asserted against this constant, and that is a live gap rather than a decision:
   changing this line leaves them stale and nothing says so. Not fixed here
   because they are the frontend lane's files and because ROW-68 already exists
   for build-time checks over that repo's markup. */
export const CANONICAL = 'https://app.phaeacia.ai';
