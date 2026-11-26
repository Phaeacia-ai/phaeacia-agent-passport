/* Which POSTs an endpoint refuses because a page on another site sent them.

   Every endpoint that changes something is called by this site's own pages
   and by nothing else that runs in a browser. A browser will still carry a
   POST to this site from any page on any site: a form, or a fetch in no-cors
   mode, needs no permission from the receiving site, and the answer being
   unreadable to the page that sent it does not matter when the point was the
   write. Without this check any page could make its visitors vote, count
   copies or publish, from their own browsers and their own addresses, where a
   per-address limit sees one request per visitor and never fires. Found by the
   security review of 2026-09-30 (M1) for vote, the two copy counters and
   upload. Manage, delete, subscribe, hold-email and send take the same check
   because they have the same callers. Every function that does not take it is
   named, with its reason, in tools/run-endpoint-tests.mjs, so a new .mjs
   endpoint fails that suite until somebody decides which list it belongs on.
   That census reads .mjs files only: a .js, .ts or folder function, which
   Netlify also builds, passes it unseen (PH-599).

   Two request headers say where a browser request came from, and the page
   sending it can set neither:

     Sec-Fetch-Site  same-origin, same-site, cross-site or none, computed by the
                     browser. Every current browser sends it; older ones and
                     anything that is not a browser do not.
     Origin          the origin of the page that sent it, on every POST from
                     every browser in use, or the literal `null` (below).

   THE RULE, in the order `crossSite` applies it:

     1. Sec-Fetch-Site present and anything but `same-origin`: refused. That
        includes `same-site`, because phaeacia.ai and every other subdomain are
        another site as far as these writes go and none of them calls this one.
        It includes `none`, which a browser sends for a request no page
        started, such as an address typed into it, and nothing here is started
        that way: the pages call these endpoints with fetch, and the one form,
        the vote control, answers 303, so a reload repeats the GET and never the
        POST.

     2. No Origin at all: allowed. That is a script, not a browser in current
        use, all of which send Origin on a POST. scripts/publish.py is one and
        it is how the skill publishes: it sends content-type, accept and
        user-agent, never Origin or Sec-Fetch-Site. A script can also send any
        Origin it likes, so none of this stops a script. The per-address limits
        are what bound those.

     3. `Origin: null`: allowed only beside `Sec-Fetch-Site: same-origin`.
        THIS SITE'S OWN VOTE FORM SENDS IT. Every page here is served with
        `Referrer-Policy: no-referrer`, and under that policy a browser submits
        a form with `Origin: null` instead of the page's origin. That is the
        Fetch standard's rule for a POST whose mode is not cors, and it was
        measured, not read: Chrome 154 on 2026-09-30 sent `null` for the
        same form under that policy and the real origin without it. The
        pages' fetch calls are untouched by it, because fetch defaults to cors
        mode and cors mode always sends the real origin. But `null` is also
        what a sandboxed frame on another site sends, and what any page gets by
        setting the same policy on itself (measured the same day), so on its
        own it proves nothing. The cost, stated: a browser too old to send
        Sec-Fetch-Site cannot vote with JavaScript off. With JavaScript on it
        votes through fetch, which sends its real origin.

     4. Any other Origin: allowed only when it is exactly this request's own
        origin, the one in the request URL. Not CANONICAL, on purpose: a deploy
        preview and the app's netlify.app name serve the same pages from their
        own hostnames, and those pages' fetches carry those origins. The
        request URL is built from the Host header, which is why the links that
        leave the building are not built from it (lib/_site.mjs). Here that is
        harmless: a browser always sends the Host of the site it is sending
        to, so a page elsewhere cannot make the two agree, and a program that
        forges both could as well have left Origin out. On app.phaeacia.ai the
        request URL's origin is https://app.phaeacia.ai: until 834aecc the
        upload response built the passport's link from it, and the link files
        publish.py wrote from those responses on 2026-08-11 say exactly that.
        The measurements behind rules 3 and 4 are in
        record/findings/a-same-origin-form-post-here-sends-origin-null.md.

   WHAT THIS DOES NOT DO. It stops browsers, not programs, and it does not
   replace a limit. It is a no to one kind of request and writes nothing, so it
   runs before the limiter and before the body is read: a refused request
   charges nobody's limit, touches no store and leaves no trace. */

/* The reason a request is refused, or null when it is not. A reason rather
   than a boolean so a test can tell which rule fired; no endpoint returns it,
   and every refusal looks the same from outside. */
export function crossSite(req) {
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return 'sec-fetch-site';
  const origin = req.headers.get('origin');
  if (origin === null) return null;
  if (origin === 'null') return site === 'same-origin' ? null : 'origin-null';
  let own;
  try {
    own = new URL(req.url).origin;
  } catch {
    return 'origin';
  }
  return origin === own ? null : 'origin';
}

/* The request's media type, lower-cased and without parameters, or '' when
   there is no Content-Type. The same reading vote.mjs and transport() give it. */
export const mediaType = (req) =>
  (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
