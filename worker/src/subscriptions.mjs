export const OWNER_KEY = 'owner:default:subscriptions';
export const VERSION_KEY = 'owner:default:version';
export const ICS_CACHE_KEY = 'ics:owner:default:latest';
export const ICS_ETAG_KEY = 'ics:owner:default:etag';

export function tripMetaKey(planId) {
  return `trip:${planId}:meta`;
}

export function tripLastFetchKey(planId) {
  return `trip:${planId}:lastFetch`;
}

export async function listSubscriptions(env) {
  const list = await env.WANDERLOG_KV.get(OWNER_KEY, { type: 'json' });
  return Array.isArray(list) ? list : [];
}

export async function addSubscription(env, { planId, title = null, alias = null, timezone = null } = {}) {
  if (!planId) throw new Error('planId is required');
  const now = new Date().toISOString();
  const current = await listSubscriptions(env);
  const existing = current.find(entry => entry.planId === planId);
  const entry = {
    planId,
    title: title ?? existing?.title ?? null,
    alias: alias ?? existing?.alias ?? null,
    enabled: true,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
    timezone: timezone ?? existing?.timezone ?? null,
    includeAiPrefixes: existing?.includeAiPrefixes ?? true,
    source: existing?.source ?? 'cli',
  };
  const next = existing ? current.map(item => (item.planId === planId ? entry : item)) : [...current, entry];
  await env.WANDERLOG_KV.put(OWNER_KEY, JSON.stringify(next));
  await env.WANDERLOG_KV.put(tripMetaKey(planId), JSON.stringify(entry));
  await bumpVersion(env);
  await invalidateCache(env);
  return entry;
}

export async function removeSubscription(env, planId) {
  const current = await listSubscriptions(env);
  const next = current.filter(entry => entry.planId !== planId);
  await env.WANDERLOG_KV.put(OWNER_KEY, JSON.stringify(next));
  await env.WANDERLOG_KV.delete(tripMetaKey(planId));
  await env.WANDERLOG_KV.delete(tripLastFetchKey(planId));
  await bumpVersion(env);
  await invalidateCache(env);
  return { removed: current.length !== next.length, planId };
}

export async function patchSubscription(env, planId, patch = {}) {
  const allowed = new Set(['enabled', 'alias', 'title', 'timezone', 'includeAiPrefixes']);
  const current = await listSubscriptions(env);
  const existing = current.find(entry => entry.planId === planId);
  if (!existing) throw new Error('subscription not found');
  const updates = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key)));
  const entry = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  await env.WANDERLOG_KV.put(OWNER_KEY, JSON.stringify(current.map(item => (item.planId === planId ? entry : item))));
  await env.WANDERLOG_KV.put(tripMetaKey(planId), JSON.stringify(entry));
  await bumpVersion(env);
  await invalidateCache(env);
  return entry;
}

export async function getVersion(env) {
  const value = await env.WANDERLOG_KV.get(VERSION_KEY);
  const version = Number(value ?? 0);
  return Number.isFinite(version) ? version : 0;
}

export async function bumpVersion(env) {
  const next = (await getVersion(env)) + 1;
  await env.WANDERLOG_KV.put(VERSION_KEY, String(next));
  return next;
}

export async function invalidateCache(env) {
  await env.WANDERLOG_KV.delete(ICS_CACHE_KEY);
  await env.WANDERLOG_KV.delete(ICS_ETAG_KEY);
}
