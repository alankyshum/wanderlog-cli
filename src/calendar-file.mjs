// `wlog calendar render|publish`: calendar events built from the trip files
// (docs/calendar-events.md). Validation and ICS serialisation come from the
// Worker's own modules, so a local render is byte-for-byte what the feed serves
// (DTSTAMP aside). No Wanderlog request is made here.
import fs from 'node:fs/promises';

import { fileEventBlocks, renderEventsIcs, validateEventsDocument } from '../worker/src/file-events.mjs';
import { adminRequest, resolveSubscriptionPlanId } from './calendar.mjs';
import { CLIError, UsageError } from './errors.mjs';

const DEFAULT_BASE_URL = 'https://calendar.alanshum.dev';

export async function readEventsFile(file) {
  if (!file) throw new UsageError('--events <file> is required');
  let input;
  try {
    input = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`Cannot read events file ${file}: ${err.message}`);
  }
  const result = validateEventsDocument(input);
  if (!result.ok) throw new UsageError(`Invalid events file ${file}:\n  ${result.errors.join('\n  ')}`);
  return result.doc;
}

export async function render(opts = {}) {
  const doc = await readEventsFile(opts.events);
  return renderEventsIcs(doc);
}

// PUT the events, then GET the public feed and require that this trip's VEVENTs
// equal the local render except DTSTAMP. A mismatch exits 7 (published but not verified).
export async function publish(opts = {}, tripInput) {
  if (!tripInput) throw new UsageError('Usage: wlog calendar publish <tripKey|alias> --events <file> [--json]');
  const doc = await readEventsFile(opts.events);
  const planId = await resolveSubscriptionPlanId(opts, tripInput);
  if (planId !== doc.trip_key) {
    throw new UsageError(`Trip ${tripInput} resolves to ${planId}, but the events file is for ${doc.trip_key}`);
  }

  const put = await adminRequest(opts, `/subscriptions/${encodeURIComponent(planId)}/events`, { method: 'PUT', body: doc });

  const expected = fileEventBlocks(renderEventsIcs(doc), planId);
  const feedUrl = `${calendarBase(opts)}/wanderlog.ics`;
  const response = await fetch(feedUrl, { headers: { Accept: 'text/calendar', 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new CLIError(`Published, but the feed read failed (${response.status}); not verified`, 7);
  const actual = fileEventBlocks(await response.text(), planId);
  const mismatch = firstMismatch(expected, actual);
  if (mismatch) throw new CLIError(`Published, but the feed differs from the local render: ${mismatch}`, 7);

  return { planId, source: put.source ?? 'file', events: doc.events.length, sha256: put.sha256 ?? null, version: put.version ?? null, verified: true, feedUrl };
}

function firstMismatch(expected, actual) {
  if (expected.length !== actual.length) return `expected ${expected.length} events, feed has ${actual.length}`;
  const index = expected.findIndex((block, i) => block !== actual[i]);
  if (index === -1) return null;
  const uid = expected[index].replace(/\r\n[ \t]/g, '').split('\r\n').find(line => line.startsWith('UID:'));
  return `event ${index} (${uid}) differs`;
}

function calendarBase(opts) {
  return (process.env.WANDERLOG_CALENDAR_URL || opts.calendarUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}
