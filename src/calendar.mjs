import { getTrip, listTrips } from './trips.mjs';
import { generateIcs } from './ics-generator.mjs';
import { NotFoundError, UsageError } from './errors.mjs';

const PUBLIC_CALENDAR_URL = 'https://calendar.alanshum.org/wanderlog';
const DEFAULT_BASE_URL = 'https://calendar.alanshum.org';

export async function subscribe(opts = {}, { tripKey, title = null, alias = null, timezone = null } = {}) {
  if (!tripKey) throw new Error('Usage: wlog calendar subscribe <tripKey> [--alias <name>] [--timezone <tz>]');
  const trip = await resolveTrip(opts, tripKey);
  const data = await adminRequest(opts, '/subscriptions', {
    method: 'POST',
    body: { planId: trip.planId, title: title ?? trip.title, alias, timezone },
  });
  return { planId: data.planId ?? trip.planId, alias: data.alias ?? alias ?? null, url: getCalendarUrl() };
}

export async function unsubscribe(opts = {}, tripKey) {
  if (!tripKey) throw new Error('Usage: wlog calendar unsubscribe <tripKey>');
  const planId = await resolveSubscriptionPlanId(opts, tripKey);
  await adminRequest(opts, `/subscriptions/${encodeURIComponent(planId)}`, { method: 'DELETE' });
  return { planId, unsubscribed: true, url: getCalendarUrl() };
}

export async function listSubscriptions(opts = {}) {
  return adminRequest(opts, '/subscriptions');
}

export function getCalendarUrl() {
  return PUBLIC_CALENDAR_URL;
}

export async function previewLocal(opts = {}, tripKey) {
  if (!tripKey) throw new Error('Usage: wlog calendar preview <tripKey>');
  const trip = await getTrip(opts, tripKey);
  if (opts.timezone) trip.timezone = opts.timezone;
  return generateIcs({
    trips: [trip],
    calendarVersion: '0.1.0',
    subscriptionVersion: 0,
  });
}

export async function refresh(opts = {}) {
  return adminRequest(opts, '/refresh', { method: 'POST' });
}

async function adminRequest(opts = {}, path, { method = 'GET', body } = {}) {
  const token = process.env.WANDERLOG_CALENDAR_ADMIN_TOKEN;
  if (!token) throw new Error('Set WANDERLOG_CALENDAR_ADMIN_TOKEN env var (matches Worker secret ADMIN_TOKEN)');

  const base = (process.env.WANDERLOG_CALENDAR_URL || opts.calendarUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const response = await fetch(`${base}/wanderlog/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const data = parseMaybeJson(text);
  if (!response.ok) {
    const detail = data?.error || data?.message || text.slice(0, 200) || response.statusText;
    throw new Error(`Calendar admin API error (${response.status}): ${detail}`);
  }
  return data ?? { ok: true };
}

async function resolveTrip(opts, input) {
  const direct = await tryGetTrip(opts, input);
  if (direct) return direct;

  const matches = (await listTrips(opts)).filter(trip => tripMatches(trip, input));
  if (matches.length === 0) throw new NotFoundError(`Trip not found: ${input}`);
  if (matches.length > 1) throw new UsageError(`Multiple trips match ${input}; use the exact trip key`);

  const planId = matches[0].key ?? matches[0].id;
  if (!planId) throw new NotFoundError(`Trip is missing a plan key: ${input}`);
  return (await tryGetTrip(opts, planId)) ?? { planId, title: matches[0].title ?? null };
}

async function tryGetTrip(opts, tripKey) {
  try {
    const trip = await getTrip(opts, tripKey);
    return { planId: trip.key ?? trip.id ?? tripKey, title: trip.title ?? null };
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

async function resolveSubscriptionPlanId(opts, input) {
  const data = await listSubscriptions(opts);
  const subscriptions = Array.isArray(data?.subscriptions) ? data.subscriptions : [];
  const matches = subscriptions.filter(subscription => subscriptionMatches(subscription, input));
  if (matches.length === 0) return input;
  if (matches.length > 1) throw new UsageError(`Multiple calendar subscriptions match ${input}; use the exact trip key`);
  return matches[0].planId;
}

function tripMatches(trip, input) {
  const wanted = String(input);
  const wantedLower = wanted.toLowerCase();
  return [trip.key, trip.id].some(value => value != null && String(value) === wanted)
    || (trip.title != null && String(trip.title).toLowerCase() === wantedLower);
}

function subscriptionMatches(subscription, input) {
  const wanted = String(input);
  const wantedLower = wanted.toLowerCase();
  return [subscription.planId, subscription.alias, subscription.title].some(value => (
    value != null && (String(value) === wanted || String(value).toLowerCase() === wantedLower)
  ));
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
