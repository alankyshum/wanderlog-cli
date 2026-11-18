import { fetchTrip } from './client.mjs';
import { generateIcs, computeContentHash } from './ics-generator.mjs';
import { normalizeTrip } from './models.mjs';
import { enrichTripsWithLinkTitles } from './link-title.mjs';
import { MAX_BODY_BYTES, fileEventsToIcsEvents, validateEventsDocument } from './file-events.mjs';
import {
  ICS_CACHE_KEY,
  ICS_ETAG_KEY,
  addSubscription,
  getFileEvents,
  putFileEvents,
  getVersion,
  invalidateCache,
  listSubscriptions,
  patchSubscription,
  removeSubscription,
  tripLastFetchKey,
} from './subscriptions.mjs';

const CACHE_TTL_SECONDS = 300;

export async function handlePublicIcs(request, env) {
  const cachedIcs = await env.WANDERLOG_KV.get(ICS_CACHE_KEY);
  const cachedEtag = await env.WANDERLOG_KV.get(ICS_ETAG_KEY);
  if (cachedIcs && cachedEtag && request.headers.get('If-None-Match') === cachedEtag) {
    return new Response(null, { status: 304, headers: calendarHeaders(env, cachedEtag, await getVersion(env)) });
  }
  const feed = cachedIcs && cachedEtag ? { ics: cachedIcs, etag: cachedEtag, version: await getVersion(env) } : await buildAndCacheFeed(env);
  return new Response(request.method === 'HEAD' ? null : feed.ics, {
    status: 200,
    headers: calendarHeaders(env, feed.etag, feed.version),
  });
}

export async function handleListSubscriptions(_request, env) {
  return jsonResponse({ subscriptions: await listSubscriptions(env), version: await getVersion(env) });
}

export async function handleAddSubscription(request, env) {
  const body = await readJson(request);
  if (!body.planId) return jsonResponse({ error: 'planId is required' }, { status: 400 });
  return jsonResponse(await addSubscription(env, body), { status: 201 });
}

export async function handleDeleteSubscription(_request, env, planId) {
  return jsonResponse(await removeSubscription(env, planId));
}

export async function handlePatchSubscription(request, env, planId) {
  try {
    return jsonResponse(await patchSubscription(env, planId, await readJson(request)));
  } catch (err) {
    if (err.message === 'subscription not found') return jsonResponse({ error: err.message }, { status: 404 });
    throw err;
  }
}

// PUT /wanderlog/api/v1/subscriptions/:planId/events — store file-built events
// (schema-checked, size-capped) and switch the subscription to source: 'file'.
export async function handlePutEvents(request, env, planId) {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) return jsonResponse({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return jsonResponse({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, { status: 413 });
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, { status: 400 });
  }
  const result = validateEventsDocument(body, { planId });
  if (!result.ok) return jsonResponse({ error: 'invalid events document', details: result.errors.slice(0, 50) }, { status: 400 });
  const sha256 = await sha256Hex(JSON.stringify(result.doc));
  const entry = await putFileEvents(env, planId, result.doc, { sha256 });
  return jsonResponse({ planId, source: entry.source, events: entry.eventsCount, sha256, version: await getVersion(env) });
}

export async function handleRefresh(_request, env) {
  await invalidateCache(env);
  const feed = await buildAndCacheFeed(env);
  return jsonResponse({ refreshed: true, etag: feed.etag, version: feed.version, bytes: feed.ics.length, failures: feed.failures ?? [] });
}

export async function handlePreviewIcs(request, env) {
  const planId = new URL(request.url).searchParams.get('planId');
  if (!planId) return jsonResponse({ error: 'planId is required' }, { status: 400 });
  const subscription = (await listSubscriptions(env)).find(entry => entry.planId === planId);
  let ics;
  if (subscription?.source === 'file') {
    const doc = await getFileEvents(env, planId);
    if (!doc) return jsonResponse({ error: 'no file events published' }, { status: 404 });
    ics = generateIcs({ extraEvents: fileEventsToIcsEvents(doc), calendarVersion: env.CALENDAR_VERSION || '0.1.0', subscriptionVersion: await getVersion(env) });
  } else {
    const raw = await fetchTrip(env, planId);
    const trip = normalizeTrip(raw);
    await enrichTripsWithLinkTitles(env, [trip]);
    ics = generateIcs({ trips: [trip], calendarVersion: env.CALENDAR_VERSION || '0.1.0', subscriptionVersion: await getVersion(env) });
  }
  return new Response(ics, { status: 200, headers: calendarHeaders(env, `"preview-${await computeContentHash(ics)}"`, await getVersion(env)) });
}

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

async function buildAndCacheFeed(env) {
  const version = await getVersion(env);
  const subscriptions = (await listSubscriptions(env)).filter(entry => entry.enabled !== false);
  const trips = [];
  const fileEvents = [];
  const failures = [];
  for (const subscription of subscriptions) {
    if (subscription.source === 'file') {
      // File-sourced: serve the published events; never fetch Wanderlog.
      const doc = await getFileEvents(env, subscription.planId);
      if (doc) fileEvents.push(...fileEventsToIcsEvents(doc));
      else failures.push({ planId: subscription.planId, error: 'no file events published' });
      continue;
    }
    try {
      const raw = await fetchTrip(env, subscription.planId);
      const trip = normalizeTrip(raw);
      trip.timezone = subscription.timezone ?? trip.timezone ?? null;
      trips.push(trip);
      await env.WANDERLOG_KV.put(tripLastFetchKey(subscription.planId), JSON.stringify({ fetchedAt: new Date().toISOString(), ok: true }));
    } catch (err) {
      const failure = { planId: subscription.planId, error: safeErrorMessage(err) };
      failures.push(failure);
      await env.WANDERLOG_KV.put(tripLastFetchKey(subscription.planId), JSON.stringify({ fetchedAt: new Date().toISOString(), ok: false, error: failure.error }));
    }
  }
  // Replace bare-URL note titles with the link's OG/document title (KV-cached).
  await enrichTripsWithLinkTitles(env, trips);
  const ics = generateIcs({ trips, extraEvents: fileEvents, calendarVersion: env.CALENDAR_VERSION || '0.1.0', subscriptionVersion: version });
  const etag = `"v${version}-${await computeContentHash(ics)}"`;
  await env.WANDERLOG_KV.put(ICS_CACHE_KEY, ics, { expirationTtl: CACHE_TTL_SECONDS });
  await env.WANDERLOG_KV.put(ICS_ETAG_KEY, etag, { expirationTtl: CACHE_TTL_SECONDS });
  return { ics, etag, version, failures };
}

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function safeErrorMessage(err) {
  return String(err?.message || err || 'unknown error').slice(0, 200);
}

function calendarHeaders(env, etag, version) {
  return {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="wanderlog.ics"',
    ETag: etag,
    'Last-Modified': new Date().toUTCString(),
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    'X-Wanderlog-Calendar-Version': env.CALENDAR_VERSION || '0.1.0',
    'X-Wanderlog-Subscription-Version': String(version),
  };
}

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid JSON body');
  }
}
