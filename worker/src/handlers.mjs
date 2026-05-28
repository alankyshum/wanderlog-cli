import { fetchTrip } from './client.mjs';
import { generateIcs, computeContentHash } from './ics-generator.mjs';
import { normalizeTrip } from './models.mjs';
import {
  ICS_CACHE_KEY,
  ICS_ETAG_KEY,
  addSubscription,
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

export async function handleRefresh(_request, env) {
  await invalidateCache(env);
  const feed = await buildAndCacheFeed(env);
  return jsonResponse({ refreshed: true, etag: feed.etag, version: feed.version, bytes: feed.ics.length, failures: feed.failures ?? [] });
}

export async function handlePreviewIcs(request, env) {
  const planId = new URL(request.url).searchParams.get('planId');
  if (!planId) return jsonResponse({ error: 'planId is required' }, { status: 400 });
  const raw = await fetchTrip(env, planId);
  const trip = normalizeTrip(raw);
  const ics = generateIcs({ trips: [trip], calendarVersion: env.CALENDAR_VERSION || '0.1.0', subscriptionVersion: await getVersion(env) });
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
  const failures = [];
  for (const subscription of subscriptions) {
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
  const ics = generateIcs({ trips, calendarVersion: env.CALENDAR_VERSION || '0.1.0', subscriptionVersion: version });
  const etag = `"v${version}-${await computeContentHash(ics)}"`;
  await env.WANDERLOG_KV.put(ICS_CACHE_KEY, ics, { expirationTtl: CACHE_TTL_SECONDS });
  await env.WANDERLOG_KV.put(ICS_ETAG_KEY, etag, { expirationTtl: CACHE_TTL_SECONDS });
  return { ics, etag, version, failures };
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
