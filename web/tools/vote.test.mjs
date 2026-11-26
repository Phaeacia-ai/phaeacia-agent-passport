/* gallery votes: one key per voter, tallies, the recount, and the races between a vote, an unlist,
   a relist and a delete.

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/vote.test.mjs */

import { test } from 'node:test';
import { CATEGORIES } from '../lib/_categories.mjs';
import assert from 'node:assert/strict';
import {
  CAT,
  GOOD,
  NOBODY,
  VOTER_A,
  VOTER_B,
  assertUnlistedShape,
  cardOf,
  listedPublish,
  metaOf,
  parsed,
  reset,
  rowOf,
  store,
  stores,
  tallyKeyFor,
  tallyKeysFor,
  voteKeysFor,
} from './_helpers.mjs';

const voteKeyFor = (id, voter) => `${tallyKeyFor(id)}:${voter}`;

test('gallery: a vote is one key per voter, the tally follows it, and the card copies the tally', async () => {
  reset();
  const { id } = await listedPublish();
  assert.deepEqual(await store.castVote(undefined, id, VOTER_A, 'up'),   { up: 1, down: 0, yours: 'up' });
  assert.deepEqual(await store.castVote(undefined, id, VOTER_A, 'down'), { up: 0, down: 1, yours: 'down' });
  assert.deepEqual(await store.castVote(undefined, id, VOTER_B, 'down'), { up: 0, down: 2, yours: 'down' });
  assert.deepEqual(await store.castVote(undefined, id, VOTER_A, 'none'), { up: 0, down: 1, yours: null });
  assert.equal(stores.get('votes').data.get(voteKeyFor(id, VOTER_B)), '-1');
  assert.equal(stores.get('votes').data.has(voteKeyFor(id, VOTER_A)), false, 'a cleared vote must delete its key');
  assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 1 });
  const card = cardOf(id);
  assert.equal(card.up, 0);
  assert.equal(card.down, 1);

  assert.equal(await store.castVote(undefined, id, VOTER_A, 'sideways'), null);
  assert.equal(await store.castVote(undefined, id, 'not-a-voter', 'up'), null);
  assert.equal(await store.castVote(undefined, NOBODY, VOTER_A, 'up'), null);
  assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 1 }, 'a refused vote changed the tally');
});

test('gallery: an unlisted passport takes no votes, and unlist-then-vote cannot resurrect the card', async () => {
  reset();
  const { id, token } = await listedPublish();
  await store.castVote(undefined, id, VOTER_A, 'up');
  await store.unlistPassport(undefined, id, token);
  assert.equal(await store.castVote(undefined, id, VOTER_B, 'up'), null, 'an unlisted passport accepted a vote');
  assert.equal(cardOf(id), null, 'a vote after unlisting brought the card back');
  assert.equal(voteKeysFor(id).length, 0);

  reset();
  const plain = await store.createPassport(undefined, parsed(), GOOD);
  assert.equal(await store.castVote(undefined, plain.id, VOTER_A, 'up'), null, 'a never-listed passport accepted a vote');
  assert.equal(stores.has('votes-count'), false, 'a refused vote opened the tally store');
});

test('gallery: the card copy re-reads the listing as the last read before writing (invariant 6)', async () => {
  reset();
  const { id, token } = await listedPublish();
  const passports = stores.get('passports');
  const real = passports.getMetadata.bind(passports);
  let reads = 0;
  passports.getMetadata = async (key) => {
    reads++;
    /* The second metadata read is the one castVote makes right before it
       writes the card. The owner unlists in that gap. */
    if (reads === 2) await store.unlistPassport(undefined, id, token);
    return real(key);
  };
  const res = await store.castVote(undefined, id, VOTER_A, 'up');
  passports.getMetadata = real;

  assert.ok(reads >= 2, 'castVote must read the listing twice: once to admit the vote and once before the card write');
  assert.equal(cardOf(id), null, 'the card was written back after the passport was unlisted');
  assertUnlistedShape(id);
  /* The vote itself was recorded before the unlist and may survive as an
     orphan; the recount is what sweeps that, and the test below asserts it. */
  assert.ok(res === null || typeof res.up === 'number');
});

test('gallery: the recount rebuilds tallies from the votes store and clears what a race left behind', async () => {
  reset();
  const { id } = await listedPublish();
  await store.castVote(undefined, id, VOTER_A, 'up');
  await store.castVote(undefined, id, VOTER_B, 'up');
  /* A lost update: the tally says one. */
  stores.get('votes-count').data.set(tallyKeyFor(id), JSON.stringify({ up: 1, down: 0, at: 'x' }));
  /* An orphan vote and an orphan tally for an id nobody lists. */
  stores.get('votes').data.set(`${NOBODY}:${VOTER_A}`, '1');
  stores.get('votes-count').data.set(NOBODY, JSON.stringify({ up: 1, down: 0 }));
  /* Views and copies moved since the card was written. */
  await store.bumpViews(undefined, id);
  await store.bumpViews(undefined, id);
  await store.bumpCopies(undefined, id);

  const out = await store.recount(undefined);
  assert.equal(out.listFailed, false);
  assert.deepEqual(await store.readVotes(undefined, id), { up: 2, down: 0 });
  const card = cardOf(id);
  assert.equal(card.up, 2);
  assert.equal(card.down, 0);
  assert.equal(card.views, 2);
  assert.equal(card.copies, 1);
  assert.equal(stores.get('votes').data.has(`${NOBODY}:${VOTER_A}`), false, 'the orphan vote survived the recount');
  assert.equal(stores.get('votes-count').data.has(NOBODY), false, 'the orphan tally survived the recount');
  assert.equal(out.orphanVotes, 1);
  assert.equal(out.orphanTallies, 1);
  assert.equal(out.cards, 1);
});

/* `listed` against `refreshed` is the recount's lag figure (audit, 2026-10-22):
   a run cut short by its budget used to report only `budgetSpent`, so nothing
   said how many cards were left showing stale counts. A clock that advances 10
   per read and a 30 budget let the run refresh one listed id of three. */
test('gallery: the recount reports how many listed ids it refreshed, against how many are listed', async () => {
  reset();
  for (let i = 0; i < 3; i++) {
    const { id } = await store.createPassport(undefined, parsed(), GOOD + '\n'.repeat(i + 1), { gallery: { category: CAT } });
    await store.castVote(undefined, id, VOTER_A, 'up');
  }
  let t = 0;
  const cut = await store.recount(undefined, { budgetMs: 30, clock: () => (t += 10) - 10 });
  assert.equal(cut.listed, 3);
  assert.equal(cut.budgetSpent, true, 'the fixture did not exhaust the budget');
  assert.ok(cut.refreshed >= 1 && cut.refreshed < cut.listed,
    `a cut-short run must report a partial refresh, got ${cut.refreshed} of ${cut.listed}`);

  const full = await store.recount(undefined);
  assert.equal(full.refreshed, full.listed, 'a run that finished refreshed every listed id');
});

/* `refreshed` counts tallies written, not cards written, which is why `cards`
   could not stand in for it (review, 2026-10-22). Four listed ids: one plain;
   one whose card is gone and cannot be rebuilt (built by hand: the metadata
   says listed, the row carries no gallery block); one whose card write fails;
   one whose tally write fails. The first three had their tally rewritten. */
test('gallery: the recount counts a rewritten tally as refreshed whether or not its card was written', async () => {
  reset();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const { id } = await store.createPassport(undefined, parsed(), GOOD + '\n'.repeat(i + 1), { gallery: { category: CAT } });
    await store.castVote(undefined, id, VOTER_A, 'up');
    ids.push(id);
  }
  const [, noCard, cardFails, tallyFails] = ids;
  stores.get('gallery').data.delete(noCard);
  stores.get('passports').data.set(noCard, JSON.stringify({ ...rowOf(noCard), gallery: null }));
  const failOn = (name, key) => {
    const s = stores.get(name);
    const real = s.setJSON.bind(s);
    s.setJSON = async (k, v, o) => { if (k === key) throw new Error('simulated write failure'); return real(k, v, o); };
  };
  failOn('gallery', cardFails);
  failOn('votes-count', tallyKeyFor(tallyFails));

  const out = await store.recount(undefined);
  assert.equal(out.listed, 4, 'the fixture did not list all four ids');
  assert.equal(out.cards, 1, 'only the plain id had its card written');
  assert.equal(out.refreshed, 3,
    `the ids with no card and with a failed card write still had their tally rewritten, and the failed tally did not: got ${out.refreshed}`);
});

/* The critic's interleavings (2026-09-04). The test above fires the unlist at
   the second metadata read; these fire it, and a delete, one round trip later,
   at the CARD read, which is the gap the re-read used to sit in front of and
   now sits behind. Against the earlier order every one of these went red. */
const galleryGetHook = (fn) => {
  const g = stores.get('gallery');
  const real = g.get.bind(g);
  let fired = false;
  g.get = async (key, opts) => {
    if (!fired) { fired = true; await fn(); }
    return real(key, opts);
  };
  return () => { g.get = real; };
};

test('gallery: an unlist landing between the card read and the card write leaves no card, and the vote undoes itself', async () => {
  reset();
  const { id, token } = await listedPublish();
  await store.castVote(undefined, id, VOTER_B, 'up');
  const restore = galleryGetHook(() => store.unlistPassport(undefined, id, token));
  const res = await store.castVote(undefined, id, VOTER_A, 'up');
  restore();
  assert.equal(res, null, 'a vote that found the row unlisted on its last read must fail');
  assert.equal(cardOf(id), null, 'the card was written back after the passport was unlisted');
  assert.deepEqual(voteKeysFor(id), [], 'the overtaken vote left its key behind');
  assert.equal(tallyKeysFor(id).length, 0, 'the overtaken vote left its tally behind');
  assertUnlistedShape(id);
});

test('gallery: a delete landing between the card read and the card write leaves nothing for that id', async () => {
  reset();
  const { id, token } = await listedPublish();
  const restore = galleryGetHook(() => store.deletePassport(undefined, id, token));
  const res = await store.castVote(undefined, id, VOTER_A, 'up');
  restore();
  assert.equal(res, null);
  for (const name of ['gallery', 'votes-count', 'passports', 'copies', 'views']) {
    const st = stores.get(name);
    assert.ok(!st || !st.data.has(id), `${name} still holds ${id} after a delete raced a vote`);
  }
  assert.deepEqual(voteKeysFor(id), []);
});

test('gallery: the recount re-reads the listing after its last counter read, and an unlist or delete in that gap writes no tally and no card', async () => {
  for (const how of ['unlist', 'delete']) {
    reset();
    const { id, token } = await listedPublish();
    await store.castVote(undefined, id, VOTER_A, 'up');
    await store.castVote(undefined, id, VOTER_B, 'up');
    /* readViews is the recount's last counter read before the listing
       re-read; the owner unlists, or deletes, inside it. The store is opened
       by a read first, because nothing has viewed this passport yet. */
    await store.readViews(undefined, id);
    const views = stores.get('views');
    const realGet = views.get.bind(views);
    let fired = false;
    views.get = async (key, opts) => {
      if (!fired) {
        fired = true;
        if (how === 'unlist') await store.unlistPassport(undefined, id, token);
        else await store.deletePassport(undefined, id, token);
      }
      return realGet(key, opts);
    };
    const out = await store.recount(undefined);
    views.get = realGet;
    assert.ok(fired, 'the hook never fired: the recount did not read views for the listed id');
    assert.equal(out.cards, 0, `${how}: the recount wrote a card for a row that was ${how}ed under it`);
    assert.equal(cardOf(id), null, `${how}: a card survived`);
    assert.equal(tallyKeysFor(id).length, 0, `${how}: a tally survived`);
    assert.deepEqual(voteKeysFor(id), [], `${how}: vote keys survived`);
    if (how === 'unlist') assertUnlistedShape(id);
    else assert.equal(stores.get('passports').data.has(id), false);
  }
});

/* A listing has its own vote namespace. None of these controls assumes that
   prefix listing or best-effort deletion proves every old vote is gone. */
test('gallery: relisting starts at zero despite failed, omitted or partial cleanup', async () => {
  for (const failure of ['votes-only', 'list', 'delete', 'omit', 'partial']) {
    reset();
    const { id, token } = await listedPublish();
    await store.castVote(undefined, id, VOTER_A, 'up');
    await store.castVote(undefined, id, VOTER_B, 'up');
    const votes = stores.get('votes');
    const counts = stores.get('votes-count');
    const list = votes.list.bind(votes);
    const del = votes.delete.bind(votes);
    const delTally = counts.delete.bind(counts);
    if (failure === 'list') votes.list = async () => { throw new Error('list unavailable'); };
    if (failure === 'omit') votes.list = async () => ({ blobs: [] });
    if (failure === 'votes-only' || failure === 'delete' || failure === 'partial') votes.delete = async key => {
      if (failure === 'votes-only' || failure === 'delete' || key.endsWith(VOTER_A)) throw new Error('delete unavailable');
      return del(key);
    };
    if (failure !== 'votes-only') counts.delete = async () => { throw new Error('tally cleanup unavailable'); };
    await store.unlistPassport(undefined, id, token);
    votes.list = list; votes.delete = del; counts.delete = delTally;
    assert.ok(voteKeysFor(id).length > 0, `${failure}: fixture must leave old votes`);
    await store.listPassport(undefined, id, token, CAT);
    assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 0 }, `${failure}: old tally returned on relist`);
    await store.recount(undefined);
    assert.equal(cardOf(id).up, 0, `${failure}: recount resurrected old votes`);
    assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 0 });
    assert.deepEqual(await store.castVote(undefined, id, VOTER_A, 'down'), { up: 0, down: 1, yours: 'down' },
      `${failure}: same voter inherited its prior listing vote`);
    assert.equal(voteKeysFor(id).length, 1, 'recount must reclaim old generation votes');
    assert.equal(tallyKeysFor(id).length, 1, 'recount must reclaim old generation tallies');
  }
});

test('gallery: delayed old vote and tally writes cannot overwrite or delete a new same-voter vote', async () => {
  for (const point of ['vote', 'tally']) {
    reset();
    const { id, token } = await listedPublish();
    await store.castVote(undefined, id, VOTER_B, 'up');
    const target = stores.get(point === 'vote' ? 'votes' : 'votes-count');
    const method = point === 'vote' ? 'set' : 'setJSON';
    const original = target[method].bind(target);
    let fired = false;
    target[method] = async (...args) => {
      if (!fired) {
        fired = true;
        await store.unlistPassport(undefined, id, token);
        await store.listPassport(undefined, id, token, CAT);
        await store.castVote(undefined, id, VOTER_A, 'down');
      }
      return original(...args);
    };
    assert.equal(await store.castVote(undefined, id, VOTER_A, 'up'), null, 'old listing vote must be refused once superseded');
    target[method] = original;
    assert.ok(fired);
    assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 1 }, `${point}: old write or undo damaged new tally`);
    assert.equal(stores.get('votes').data.get(voteKeyFor(id, VOTER_A)), '-1', `${point}: old undo deleted new same-voter key`);
    await store.recount(undefined);
    assert.equal(cardOf(id).up, 0);
    assert.equal(cardOf(id).down, 1);
  }
});

test('gallery: delayed old card writes never display old counts and recount repairs the card', async () => {
  for (const writer of ['vote', 'recount']) {
    reset();
    const { id, token } = await listedPublish();
    await store.castVote(undefined, id, VOTER_A, 'up');
    const g = stores.get('gallery');
    const set = g.setJSON.bind(g);
    let fired = false;
    g.setJSON = async (...args) => {
      if (!fired) {
        fired = true;
        await store.unlistPassport(undefined, id, token);
        await store.listPassport(undefined, id, token, CAT);
        await store.castVote(undefined, id, VOTER_B, 'down');
      }
      return set(...args);
    };
    if (writer === 'vote') await store.castVote(undefined, id, VOTER_A, 'up');
    else await store.recount(undefined);
    g.setJSON = set;
    assert.ok(fired);
    assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 1 });
    const shown = (await store.listGallery(undefined)).cards;
    assert.ok(shown.every(card => card.up === 0), `${writer}: old card counts were exposed`);
    await store.recount(undefined);
    assert.equal(cardOf(id).generation, rowOf(id).gallery.generation);
    assert.equal(cardOf(id).up, 0);
    assert.equal(cardOf(id).down, 1);
    assert.equal((await store.listGallery(undefined)).cards.length, 1, 'next recount must restore visible card');
  }
});

test('gallery: recount superseded before its last read or tally write cannot count the prior listing', async () => {
  for (const point of ['views', 'tally']) {
    reset();
    const { id, token } = await listedPublish();
    await store.castVote(undefined, id, VOTER_A, 'up');
    await store.bumpViews(undefined, id);
    const target = stores.get(point === 'views' ? 'views' : 'votes-count');
    const method = point === 'views' ? 'get' : 'setJSON';
    const original = target[method].bind(target);
    let fired = false;
    target[method] = async (...args) => {
      if (!fired) {
        fired = true;
        await store.unlistPassport(undefined, id, token);
        await store.listPassport(undefined, id, token, CAT);
        await store.castVote(undefined, id, VOTER_A, 'down');
      }
      return original(...args);
    };
    await store.recount(undefined);
    target[method] = original;
    assert.ok(fired);
    assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 1 }, `${point}: stale recount overwrote or deleted new tally`);
    assert.equal(stores.get('votes').data.get(voteKeyFor(id, VOTER_A)), '-1');
    assert.ok((await store.listGallery(undefined)).cards.every(card => card.up === 0));
    await store.recount(undefined);
    assert.equal(cardOf(id).up, 0);
    assert.equal(cardOf(id).down, 1);
  }
});

test('gallery: delayed unlist cleanup cannot remove new listing votes or tally, including legacy prefixes', async () => {
  for (const legacy of [false, true]) {
    reset();
    const { id, token } = await listedPublish();
    if (legacy) {
      const row = rowOf(id); delete row.gallery.generation;
      stores.get('passports').data.set(id, JSON.stringify(row));
      const meta = metaOf(id); delete meta.gg;
      const card = cardOf(id); delete card.generation;
      stores.get('gallery').data.set(id, JSON.stringify(card));
    }
    await store.castVote(undefined, id, VOTER_A, 'up');
    const votes = stores.get('votes');
    const list = votes.list.bind(votes);
    let fired = false;
    votes.list = async (...args) => {
      if (!fired) {
        fired = true;
        await store.listPassport(undefined, id, token, CAT);
        await store.castVote(undefined, id, VOTER_A, 'down');
      }
      return list(...args);
    };
    await store.unlistPassport(undefined, id, token);
    votes.list = list;
    assert.ok(fired);
    assert.equal(stores.get('votes').data.get(voteKeyFor(id, VOTER_A)), '-1', `legacy=${legacy}: old prefix cleanup deleted new vote`);
    assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 1 });
    await store.recount(undefined);
    assert.equal(cardOf(id).down, 1);
  }
});

test('gallery: legacy listings keep old votes during category edits and retire them on relist', async () => {
  reset();
  const { id, token } = await listedPublish();
  const row = rowOf(id); delete row.gallery.generation;
  stores.get('passports').data.set(id, JSON.stringify(row));
  delete metaOf(id).gg;
  const card = cardOf(id); delete card.generation;
  stores.get('gallery').data.set(id, JSON.stringify(card));
  await store.castVote(undefined, id, VOTER_A, 'up');
  assert.equal(stores.get('votes').data.get(`${id}:${VOTER_A}`), '1');
  await store.listPassport(undefined, id, token, CATEGORIES.find(c => c.slug !== CAT).slug);
  assert.deepEqual(await store.readVotes(undefined, id), { up: 1, down: 0 });
  const votes = stores.get('votes');
  const list = votes.list.bind(votes);
  votes.list = async () => ({ blobs: [] });
  await store.unlistPassport(undefined, id, token);
  votes.list = list;
  await store.listPassport(undefined, id, token, CAT);
  await store.recount(undefined);
  assert.equal(cardOf(id).up, 0, 'legacy vote returned in new generation');
  assert.equal(voteKeysFor(id).length, 0);
});
