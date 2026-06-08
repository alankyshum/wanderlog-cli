import test from 'node:test';
import assert from 'node:assert/strict';

import {
  noteUrl,
  extractTitleFromHtml,
  clampWords,
  enrichTripsWithLinkTitles,
} from '../src/link-title.mjs';

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
}

test('noteUrl returns the URL only when the note is URL-only (no human line)', () => {
  assert.equal(noteUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(noteUrl('  https://example.com/x  '), 'https://example.com/x');
  // URL followed by a human line -> deriveSummary handles it, no fetch.
  assert.equal(noteUrl('https://example.com/x\nCandlelight concert'), null);
  assert.equal(noteUrl('Gym with SKY\nhttps://example.com'), null);
  assert.equal(noteUrl('see https://example.com'), null);
  assert.equal(noteUrl(''), null);
  assert.equal(noteUrl(null), null);
});

test('extractTitleFromHtml prefers og:title, then twitter, then <title>', () => {
  assert.equal(
    extractTitleFromHtml('<meta property="og:title" content="OG Wins">'),
    'OG Wins',
  );
  assert.equal(
    extractTitleFromHtml('<meta content="Reversed OG" property="og:title">'),
    'Reversed OG',
  );
  assert.equal(
    extractTitleFromHtml('<meta name="twitter:title" content="TW Title">'),
    'TW Title',
  );
  assert.equal(
    extractTitleFromHtml('<title>Doc &amp; Title</title>'),
    'Doc & Title',
  );
  assert.equal(extractTitleFromHtml('<html>no title here</html>'), null);
});

test('clampWords caps to 12 words with an ellipsis', () => {
  const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
  const out = clampWords(long);
  assert.equal(out.split(' ').length, 12);
  assert.ok(out.endsWith('\u2026'));
  assert.equal(clampWords('short title'), 'short title');
});

test('enrichTripsWithLinkTitles sets titleOverride from fetched OG title and caches it', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response('<meta property="og:title" content="Love & Romance Reimagined">', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
  try {
    const env = { WANDERLOG_KV: fakeKv() };
    const trips = [{
      sections: [{
        blocks: [
          { id: 'a', notes: 'https://egatix.com/products/love' },
          { id: 'b', notes: 'Gym with SKY' },
        ],
      }],
    }];
    await enrichTripsWithLinkTitles(env, trips);
    assert.equal(trips[0].sections[0].blocks[0].titleOverride, 'Love & Romance Reimagined');
    assert.equal(trips[0].sections[0].blocks[1].titleOverride, undefined);
    assert.equal(calls.length, 1);

    // Second run hits the KV cache, no new fetch.
    await enrichTripsWithLinkTitles(env, trips);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('enrichTripsWithLinkTitles leaves blocks untouched on fetch failure (negative cache)', async () => {
  const realFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount += 1; throw new Error('boom'); };
  try {
    const env = { WANDERLOG_KV: fakeKv() };
    const trips = [{ sections: [{ blocks: [{ id: 'a', notes: 'https://down.example' }] }] }];
    await enrichTripsWithLinkTitles(env, trips);
    assert.equal(trips[0].sections[0].blocks[0].titleOverride, undefined);
    assert.equal(env.WANDERLOG_KV.store.get('linktitle:https://down.example'), '');
    // negative cached -> no second fetch
    await enrichTripsWithLinkTitles(env, trips);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
