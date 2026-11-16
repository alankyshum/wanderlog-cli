import { randomInt } from 'node:crypto';
import { ApiError, ConfirmRequiredError, NotFoundError, UsageError } from './errors.mjs';
import { normalizeSection } from './models.mjs';
import { getTrip, applyTripOps } from './trips.mjs';
import { loadToken } from './token-store.mjs';

export async function listSections(opts = {}, tripKey) {
  if (!tripKey) throw new UsageError('Usage: wlog sections list <tripKey>');
  const trip = await getTrip(opts, tripKey);
  return trip.sections.map(normalizeSection);
}

export async function addSection(opts = {}, tripKey, heading, { mode = 'dayPlan', index } = {}) {
  if (!tripKey || !heading) throw new UsageError('Usage: wlog sections add <tripKey> <heading> [--mode dayPlan|placeList|textOnly] [--index <n>]');
  validateMode(mode);
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const insertIndex = index == null ? sections.length : parseIndex(index, 0, sections.length, 'index');
  const newSection = buildSection(heading, mode);

  await applyTripOps(opts, tripKey, [{ p: sectionPath(insertIndex), li: newSection }]);
  return { sectionId: newSection.id, heading, index: insertIndex };
}

export async function renameSection(opts = {}, tripKey, sectionId, newHeading) {
  if (!tripKey || !sectionId || !newHeading) throw new UsageError('Usage: wlog sections rename <tripKey> <sectionId> <heading>');
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const idx = findSectionIndex(sections, sectionId);
  const oldHeading = sections[idx].heading ?? null;
  await applyTripOps(opts, tripKey, [{ p: sectionPath(idx, 'heading'), oi: newHeading, od: oldHeading }]);
  return { sectionId: String(sectionId), heading: newHeading };
}

export async function addNote(opts = {}, tripKey, sectionId, text) {
  if (!tripKey || !sectionId || typeof text !== 'string' || !text.trim()) {
    throw new UsageError('Usage: wlog sections add-note <tripKey> <sectionId> --notes <text>');
  }
  const token = await loadToken(opts);
  if (!token?.userId) throw new UsageError('A logged-in user ID is required');
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const idx = findSectionIndex(sections, sectionId);
  const section = sections[idx];
  if (section.type !== 'normal' || !['dayPlan', 'placeList'].includes(section.mode) || !Array.isArray(section.blocks)) {
    throw new UsageError('Notes require a normal dayPlan or placeList section');
  }
  const ids = new Set(sections.flatMap(s => [String(s.id), ...(s.blocks || []).map(b => String(b.id))]));
  let id;
  do id = randomInt(100000000, 999999999); while (ids.has(String(id)));
  const block = { id, type: 'note', text: { ops: [{ insert: `${text.trim()}\n` }] }, addedBy: { type: 'user', userId: token.userId }, attachments: [] };
  await applyTripOps(opts, tripKey, [{ p: sectionPath(idx, 'blocks', section.blocks.length), li: block }]);
  const after = rawSections(await getTrip(opts, tripKey));
  const saved = after[findSectionIndex(after, sectionId)].blocks?.find(b => b.id === id);
  if (saved?.type !== 'note' || saved.text?.ops?.[0]?.insert !== block.text.ops[0].insert) {
    throw new ApiError(`Post-insert verification failed for note ${id}`);
  }
  return { sectionId: String(sectionId), blockId: id, text: text.trim() };
}

export async function deleteSection(opts = {}, tripKey, sectionId, { confirm } = {}) {
  if (!tripKey || !sectionId) throw new UsageError('Usage: wlog sections delete <tripKey> <sectionId> --confirm <sectionId>');
  if (confirm !== String(sectionId)) throw new ConfirmRequiredError(`Deletion requires --confirm ${sectionId}`);
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const idx = findSectionIndex(sections, sectionId);
  const section = sections[idx];
  await applyTripOps(opts, tripKey, [{ p: sectionPath(idx), ld: section }]);
  return { deleted: true, sectionId: String(sectionId), index: idx };
}

export async function moveSection(opts = {}, tripKey, sectionId, toIndex) {
  if (!tripKey || !sectionId || toIndex == null) throw new UsageError('Usage: wlog sections move <tripKey> <sectionId> <toIndex>');
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const fromIdx = findSectionIndex(sections, sectionId);
  const targetIdx = parseIndex(toIndex, 0, sections.length - 1, 'toIndex');
  const section = sections[fromIdx];
  const ops = buildMoveOps(sectionPath, fromIdx, targetIdx, section);
  if (ops.length > 0) await applyTripOps(opts, tripKey, ops);
  return { sectionId: String(sectionId), fromIndex: fromIdx, toIndex: targetIdx };
}

export function rawSections(trip) {
  return trip?.raw?.tripPlan?.itinerary?.sections
    ?? trip?.raw?.tripPlan?.sections
    ?? trip?.raw?.data?.tripPlan?.itinerary?.sections
    ?? trip?.raw?.data?.tripPlan?.sections
    ?? trip?.raw?.data?.itinerary?.sections
    ?? trip?.raw?.data?.sections
    ?? trip?.raw?.itinerary?.sections
    ?? trip?.raw?.sections
    ?? [];
}

export function findSectionIndex(sections, sectionId) {
  const wanted = String(sectionId);
  const idx = sections.findIndex(section => String(section.id) === wanted);
  if (idx === -1) throw new NotFoundError(`Section not found: ${sectionId}`);
  return idx;
}

export function sectionPath(index, ...tail) {
  return ['itinerary', 'sections', index, ...tail];
}

export function parseIndex(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new UsageError(`${label} must be an integer`);
  if (n < min || n > max) throw new UsageError(`${label} must be in range ${min}-${max}`);
  return n;
}

function buildSection(heading, mode) {
  return {
    id: randomInt(100000000, 999999999),
    heading,
    type: mode === 'textOnly' ? 'textOnly' : 'normal',
    mode,
    blocks: [],
    text: { ops: [{ insert: '\n' }] },
    placeMarkerColor: '#3f52e3',
    placeMarkerIcon: 'map-marker',
  };
}

function validateMode(mode) {
  if (!['dayPlan', 'placeList', 'textOnly'].includes(mode)) throw new UsageError('--mode must be dayPlan, placeList or textOnly');
}

function buildMoveOps(pathBuilder, fromIdx, toIdx, value) {
  if (fromIdx === toIdx) return [];
  return fromIdx < toIdx
    ? [{ p: pathBuilder(fromIdx), ld: value }, { p: pathBuilder(toIdx), li: value }]
    : [{ p: pathBuilder(fromIdx), ld: value }, { p: pathBuilder(toIdx), li: value }];
}
