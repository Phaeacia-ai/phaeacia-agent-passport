/* the gallery: listing and unlisting, cards, categories, copies counts, and what the listing page reads.

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/gallery.test.mjs */

import { test } from 'node:test';
import { CATEGORIES } from '../lib/_categories.mjs';
import assert from 'node:assert/strict';
import {
  CAT,
  DAY_MS,
  GOOD,
  NOBODY,
  VOTER_A,
  VOTER_B,
  assertUnlistedShape,
  cardOf,
  expireNow,
  expiryKeysFor,
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

function assertListedShape(id, category = CAT) {
  const row = rowOf(id);
  assert.ok(row.gallery && row.gallery.category === category, 'row.gallery is missing or carries the wrong category');
  assert.ok(Number.isFinite(Date.parse(row.gallery.listed_at)), 'listed_at is not a timestamp');
  assert.equal(row.expires_at, null, 'a listed row must carry expires_at: null');
  assert.deepEqual(metaOf(id), { h: row.delete_token_hash, x: 0, g: 1, gg: row.gallery.generation }, 'listed metadata must carry the row generation');
  assert.deepEqual(expiryKeysFor(id), [], 'a listed row must have no expiry index entry');
  const card = cardOf(id);
  assert.ok(card, 'a listed row must have a gallery card');
  assert.equal(card.id, id);
  assert.equal(card.category, category);
  assert.equal(card.title, row.title);
  assert.equal(card.listed_at, row.gallery.listed_at);
}

test('gallery: publishing listed flags the row, drops the expiry and writes a card; unlisted is the other way round', async () => {
  reset();
  const pub = await listedPublish();
  assert.equal(pub.listed, true);
  assert.equal(pub.expires_at, null);
  assertListedShape(pub.id);

  const plain = await store.createPassport(undefined, parsed(), GOOD);
  assert.equal(plain.listed, false);
  assertUnlistedShape(plain.id);

  const card = cardOf(pub.id);
  assert.deepEqual([card.up, card.down, card.views, card.copies], [0, 0, 0, 0]);
  assert.equal(card.installable + card.declared_only, parsed().needs.length);
  assert.equal(card.owner_confirmed, true);
  assert.equal(typeof card.summary, 'string');
  assert.ok(!('body' in card) && !('delete_token_hash' in card), 'the card must carry neither the body nor the token hash');
});

test('gallery: a category the list does not carry cannot be written by the store', async () => {
  reset();
  await assert.rejects(
    () => store.createPassport(undefined, parsed(), GOOD, { gallery: { category: 'Research and monitoring' } }),
    TypeError);
  assert.equal(stores.has('gallery'), false, 'a refused listing opened the gallery store');
  assert.equal(stores.has('passports'), false, 'a refused listing wrote a row');
});

test('gallery: the card is written before the row, and the listing page repairs a card with no row', async () => {
  reset();
  await store.createPassport(undefined, parsed(), GOOD);          // opens the passports store
  stores.get('passports').failWrites = true;
  await assert.rejects(() => listedPublish(), /simulated blob outage/);
  stores.get('passports').failWrites = false;

  const cards = [...stores.get('gallery').data.keys()];
  assert.equal(cards.length, 1, 'the card should have been written before the row write failed');
  assert.equal(stores.get('passports').data.has(cards[0]), false, 'a row exists for a publish that reported failure');

  const { cards: live, repaired } = await store.listGallery(undefined);
  assert.equal(live.length, 0);
  assert.equal(repaired, 1);
  assert.equal(stores.get('gallery').data.size, 0, 'the orphan card was not repaired');
});

test('gallery: every read path treats a listed row as live, and renew refuses to touch it', async () => {
  reset();
  const { id, token } = await listedPublish();

  const meta = await store.authorise(undefined, id, token);
  assert.ok(meta, 'authorise must accept a listed row');
  assert.equal(meta.expiresMs, 0);
  assert.ok(await store.readPassport(undefined, id), 'readPassport must return a listed row');
  assert.deepEqual(await store.listedMeta(undefined, id), { listed: true, hash: rowOf(id).delete_token_hash, generation: rowOf(id).gallery.generation });

  const century = Date.now() + 100 * 365 * DAY_MS;
  const removed = await store.sweep(undefined, { now: century });
  assert.equal(removed.passports, 0);
  assert.ok(stores.get('passports').data.has(id), 'the sweeper reached a listed row');
  assert.ok(cardOf(id), 'the sweeper took the card');

  const before = JSON.stringify([rowOf(id), metaOf(id), expiryKeysFor(id)]);
  assert.equal(await store.renewPassport(undefined, id, token), null, 'renewPassport must return null for a listed row');
  assert.equal(JSON.stringify([rowOf(id), metaOf(id), expiryKeysFor(id)]), before, 'renewPassport changed a listed row');

  const status = await store.statusOf(undefined, id, token);
  assert.equal(status.listed, true);
  assert.equal(status.category, CAT);
  assert.equal(status.listed_at, rowOf(id).gallery.listed_at);
  assert.equal(status.expires_at, null);
  assert.deepEqual(status.votes, { up: 0, down: 0 });
  assert.equal(status.copies, 0);
});

test('gallery: a listed row written by hand, with no card, is live and unrenewable too', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  const row = rowOf(id);
  const passports = stores.get('passports');
  passports.data.set(id, JSON.stringify({ ...row, expires_at: null,
    gallery: { category: CAT, listed_at: new Date().toISOString() } }));
  passports.meta.set(id, { h: row.delete_token_hash, x: 0, g: 1 });
  for (const k of expiryKeysFor(id)) stores.get('expiry').data.delete(k);

  assert.ok(await store.authorise(undefined, id, token));
  assert.ok(await store.readPassport(undefined, id));
  await store.sweep(undefined, { now: Date.now() + 100 * 365 * DAY_MS });
  assert.ok(passports.data.has(id), 'the sweeper reached a listed row');
  assert.equal(await store.renewPassport(undefined, id, token), null);
  assert.deepEqual(expiryKeysFor(id), [], 'renewPassport wrote an expiry key onto a listed row');
});

test('gallery: listing and unlisting are the only transitions, and each leaves the invariant-1 shape', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  assertUnlistedShape(id);

  assert.equal(await store.listPassport(undefined, id, 'f'.repeat(40), CAT), null, 'a wrong token listed a passport');
  assert.equal(await store.listPassport(undefined, id, token, 'not-a-category'), null, 'an unknown category listed a passport');
  assertUnlistedShape(id);

  const listed = await store.listPassport(undefined, id, token, CAT);
  assert.ok(listed && Number.isFinite(Date.parse(listed.listed_at)));
  assertListedShape(id);

  await store.castVote(undefined, id, VOTER_A, 'up');
  assert.equal(voteKeysFor(id).length, 1);

  const un = await store.unlistPassport(undefined, id, token);
  assert.ok(un && Number.isFinite(Date.parse(un.expires_at)));
  assert.ok(Date.parse(un.expires_at) > Date.now() + 29 * DAY_MS, 'unlisting must put the passport on a fresh thirty-day clock');
  assertUnlistedShape(id);
  assert.equal(voteKeysFor(id).length, 0, 'votes must go with the listing');
  assert.equal(tallyKeysFor(id).length, 0, 'the tally must go with the listing');

  assert.equal(await store.unlistPassport(undefined, id, 'f'.repeat(40)), null);
  assertUnlistedShape(id);

  /* Listed twice starts from zero: the votes were for the earlier listing. */
  await store.listPassport(undefined, id, token, 'other');
  assertListedShape(id, 'other');
  assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 0 });
});

test('gallery: deleting a listed passport takes the card, the tally and every vote with it', async () => {
  reset();
  const { id, token } = await listedPublish();
  await store.castVote(undefined, id, VOTER_A, 'up');
  await store.castVote(undefined, id, VOTER_B, 'down');
  await store.bumpCopies(undefined, id);
  await store.bumpViews(undefined, id);

  assert.equal(await store.deletePassport(undefined, id, token), true);
  assert.equal(stores.get('passports').data.has(id), false);
  assert.equal(cardOf(id), null, 'the card outlived the passport');
  assert.equal(tallyKeysFor(id).length, 0, 'the tally outlived the passport');
  assert.equal(voteKeysFor(id).length, 0, 'a vote outlived the passport');
  assert.equal(stores.get('copies').data.has(id), false, 'the copy counter outlived the passport');
  assert.equal(stores.get('views').data.has(id), false, 'the view counter outlived the passport');
});

test('gallery: purging an unlisted row never opens the gallery, votes or tally stores', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  assert.equal(await store.deletePassport(undefined, id, token), true);
  for (const name of ['gallery', 'votes', 'votes-count']) {
    assert.equal(stores.has(name), false, 'purge opened the ' + name + ' store for a row that was never listed');
  }
});

test('gallery: the sweeper never reaches a listed row, whatever is dead around it', async () => {
  reset();
  const { id } = await listedPublish();
  for (let i = 0; i < 5; i++) {
    const p = await store.createPassport(undefined, parsed(), GOOD);
    expireNow(p.id);
  }
  const removed = await store.sweep(undefined, { now: Date.now() + 100 * 365 * DAY_MS });
  assert.equal(removed.passports, 5);
  assert.ok(stores.get('passports').data.has(id), 'the sweeper deleted a listed row');
  assert.ok(cardOf(id), 'the sweeper took a listed row\'s card');
});

test('gallery: copies count for any live passport, listed or not, and deletion takes the counter with it', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  await store.bumpCopies(undefined, id);
  await store.bumpCopies(undefined, id);
  assert.equal(await store.readCopies(undefined, id), 2);
  assert.equal((await store.statusOf(undefined, id, token)).copies, 2);
  /* Listing later brings the count with it. */
  await store.listPassport(undefined, id, token, CAT);
  assert.equal(cardOf(id).copies, 2);
  await store.deletePassport(undefined, id, token);
  assert.equal(await store.readCopies(undefined, id), 0);
  assert.equal(stores.get('copies').data.has(id), false);
});

test('gallery: bumpCopies on an id that never existed writes nothing', async () => {
  reset();
  await store.bumpCopies(undefined, NOBODY);
  assert.equal(stores.has('copies'), false, 'bumpCopies opened the copies store for a dead id');
});

test('gallery: the listing reads cards and metadata only, keeps the listed ones, and repairs the rest', async () => {
  reset();
  const a = await listedPublish();
  const b = await listedPublish('other');
  /* c: unlisted underneath its card, the state a failed unlist step 3 leaves. */
  const c = await listedPublish();
  const cRow = rowOf(c.id);
  const expires_at = store.expiryFrom(Date.now(), 30);
  stores.get('passports').data.set(c.id, JSON.stringify({ ...cRow, gallery: null, expires_at }));
  stores.get('passports').meta.set(c.id, { h: cRow.delete_token_hash, x: Date.parse(expires_at) });
  /* d: deleted underneath its card. */
  const d = await listedPublish();
  stores.get('passports').data.delete(d.id);
  stores.get('passports').meta.delete(d.id);

  let bodyReads = 0;
  const passports = stores.get('passports');
  const realGet = passports.get.bind(passports);
  passports.get = async (...args) => { bodyReads++; return realGet(...args); };
  const { cards, repaired, listed } = await store.listGallery(undefined);
  passports.get = realGet;

  assert.equal(listed, true);
  assert.equal(bodyReads, 0, 'the listing read a passport body');
  assert.deepEqual(cards.map(x => x.id).sort(), [a.id, b.id].sort());
  assert.equal(repaired, 2);
  assert.equal(cardOf(c.id), null, 'a card whose row was unlisted underneath it survived');
  assert.equal(cardOf(d.id), null, 'a card whose row was deleted underneath it survived');
  assert.ok(cardOf(a.id) && cardOf(b.id));
});

test('gallery: a card whose row cannot be read is kept, because unknown is not gone', async () => {
  reset();
  const a = await listedPublish();
  const passports = stores.get('passports');
  passports.getMetadata = async () => { throw new Error('simulated blob read failure'); };
  const { cards, repaired } = await store.listGallery(undefined);
  assert.equal(cards.length, 0, 'a card whose listing could not be verified was served');
  assert.equal(repaired, 0, 'a read failure was treated as an absent row');
  assert.ok(cardOf(a.id), 'a read failure deleted a live card');
});

test('gallery: dropListing and the gallery repair stop at the request budget and leave the rest to the recount', async () => {
  reset();
  const { id, token } = await listedPublish();
  for (let i = 0; i < 60; i++) await store.castVote(undefined, id, i.toString(16).padStart(32, '0'), 'up');
  assert.equal(voteKeysFor(id).length, 60);
  /* Jump the clock past the budget the moment the first vote key is deleted:
     Date.now is what requestBudget() reads, and the first batch's deletes are
     the first thing that happens after the budget is opened. */
  const realNow = Date.now;
  const votesStore = stores.get('votes');
  const realDelete = votesStore.delete.bind(votesStore);
  let jumped = false;
  votesStore.delete = async (k) => { jumped = true; return realDelete(k); };
  Date.now = () => realNow() + (jumped ? 10 * 60e3 : 0);
  let un;
  try { un = await store.unlistPassport(undefined, id, token); }
  finally { Date.now = realNow; votesStore.delete = realDelete; }
  assert.ok(un && un.expires_at, 'the unlist itself must not fail on a budget');
  assert.equal(cardOf(id), null);
  const left = voteKeysFor(id).length;
  assert.ok(left > 0 && left < 60, `expected a partial drop, got ${left} of 60 keys left`);
  const out = await store.recount(undefined);
  assert.equal(out.orphanVotes, left, 'the recount must reclaim what the budget left');
  assert.deepEqual(voteKeysFor(id), []);
});

test('gallery: category edits preserve listing generation, date and votes', async () => {
  reset();
  const { id, token } = await listedPublish();
  await store.castVote(undefined, id, VOTER_A, 'up');
  const before = rowOf(id).gallery;
  const nextCategory = CATEGORIES.find(c => c.slug !== CAT).slug;
  await store.listPassport(undefined, id, token, nextCategory);
  assert.equal(rowOf(id).gallery.generation, before.generation);
  assert.equal(rowOf(id).gallery.listed_at, before.listed_at);
  assert.deepEqual(await store.readVotes(undefined, id), { up: 1, down: 0 });
  assert.equal(cardOf(id).up, 1);
});

test('gallery: delayed category edits cannot restore a retired generation or discard the new votes', async () => {
  for (const point of ['views', 'category', 'card']) {
    reset();
    const { id, token } = await listedPublish();
    await store.castVote(undefined, id, VOTER_A, 'up');
    await store.bumpViews(undefined, id);
    await store.statusOf(undefined, id, token); // opens the category store
    const oldGeneration = rowOf(id).gallery.generation;
    const target = stores.get(point === 'views' ? 'views' : point === 'category' ? 'gallery-categories' : 'gallery');
    const method = point === 'views' ? 'get' : 'setJSON';
    const original = target[method].bind(target);
    const votes = stores.get('votes');
    const list = votes.list.bind(votes);
    let fired = false, newGeneration;
    target[method] = async (...args) => {
      if (!fired) {
        fired = true;
        votes.list = async () => ({ blobs: [] });
        await store.unlistPassport(undefined, id, token);
        votes.list = list;
        await store.listPassport(undefined, id, token, CAT);
        newGeneration = rowOf(id).gallery.generation;
        await store.castVote(undefined, id, VOTER_B, 'down');
      }
      return original(...args);
    };
    const changed = await store.listPassport(undefined, id, token, 'other');
    target[method] = original;
    assert.ok(fired, `${point}: the interleaving did not run`);
    assert.notEqual(newGeneration, oldGeneration);
    assert.equal(rowOf(id).gallery.generation, newGeneration, `${point}: category edit restored the retired generation`);
    if (point !== 'card') assert.equal(changed, null, 'an observed superseded category edit must be refused');
    assert.equal((await store.statusOf(undefined, id, token)).category, CAT, 'old category leaked into new listing');
    await store.recount(undefined);
    assert.deepEqual(await store.readVotes(undefined, id), { up: 0, down: 1 }, `${point}: old votes returned or new vote was discarded`);
    assert.equal(cardOf(id).up, 0);
    assert.equal(cardOf(id).down, 1);
    assert.equal(cardOf(id).category, CAT);
    assert.equal(stores.get('gallery-categories').data.has(`${id}:${oldGeneration}`), false, 'recount retained old category override');
  }
});

test('gallery: category overrides survive card loss and recount without rewriting the passport', async () => {
  reset();
  const { id, token } = await listedPublish();
  await store.castVote(undefined, id, VOTER_A, 'up');
  const passportBefore = stores.get('passports').data.get(id);
  const metadataBefore = JSON.stringify(metaOf(id));
  await store.listPassport(undefined, id, token, 'other');
  assert.equal(stores.get('passports').data.get(id), passportBefore, 'category editing rewrote the lifecycle row');
  assert.equal(JSON.stringify(metaOf(id)), metadataBefore);
  assert.equal((await store.statusOf(undefined, id, token)).category, 'other');
  await stores.get('gallery').delete(id);
  await store.recount(undefined);
  assert.equal(cardOf(id).category, 'other', 'recount lost the saved category when rebuilding the card');
  assert.equal(cardOf(id).up, 1);
  assert.equal((await store.listGallery(undefined)).cards[0].category, 'other');
  const scope = tallyKeyFor(id);
  await store.unlistPassport(undefined, id, token);
  assert.equal(stores.get('gallery-categories').data.has(scope), false, 'unlist retained its category override');
});

test('gallery: failed category writes are refused and failed reads are not reported as saved state', async () => {
  reset();
  const { id, token } = await listedPublish();
  await store.statusOf(undefined, id, token);
  const categories = stores.get('gallery-categories');
  categories.failWrites = true;
  await assert.rejects(() => store.listPassport(undefined, id, token, 'other'), /simulated blob outage/);
  categories.failWrites = false;
  assert.equal(cardOf(id).category, CAT, 'a failed category write changed the card');
  assert.equal((await store.statusOf(undefined, id, token)).category, CAT);
  await store.listPassport(undefined, id, token, 'other');
  const get = categories.get.bind(categories);
  categories.get = async () => { throw new Error('category read unavailable'); };
  assert.equal(await store.statusOf(undefined, id, token), null, 'failed override read claimed an old category was current');
  assert.equal(await store.readPassport(undefined, id), null, 'public read presented an old category after override read failed');
  const out = await store.recount(undefined);
  assert.equal(out.cards, 0, 'recount overwrote a category it could not read');
  assert.equal(cardOf(id).category, 'other');
  categories.get = get;
  assert.equal((await store.statusOf(undefined, id, token)).category, 'other');
});

test('gallery: recount reclaims failed category cleanup but preserves the new override', async () => {
  reset();
  const { id, token } = await listedPublish();
  await store.listPassport(undefined, id, token, 'other');
  const oldScope = tallyKeyFor(id);
  const categories = stores.get('gallery-categories');
  const del = categories.delete.bind(categories);
  categories.delete = async () => { throw new Error('category cleanup unavailable'); };
  await store.unlistPassport(undefined, id, token);
  categories.delete = del;
  await store.listPassport(undefined, id, token, CAT);
  await store.listPassport(undefined, id, token, 'other');
  const newScope = tallyKeyFor(id);
  assert.ok(categories.data.has(oldScope), 'fixture must retain retired override');
  const out = await store.recount(undefined);
  assert.equal(out.orphanCategories, 1);
  assert.equal(categories.data.has(oldScope), false);
  assert.equal(JSON.parse(categories.data.get(newScope)).category, 'other');
  assert.equal((await store.statusOf(undefined, id, token)).category, 'other');
});
