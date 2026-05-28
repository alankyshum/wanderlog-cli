import { randomInt } from 'node:crypto';
import { loadToken } from './token-store.mjs';
import { ConfirmRequiredError, NotFoundError, UsageError } from './errors.mjs';
import { normalizePlaceBlock } from './models.mjs';
import { addAiPrefix, generateAiHash, preserveAiPrefix } from './ai-attribution.mjs';
import { getTrip, searchDestination, applyTripOps } from './trips.mjs';
import { findSectionIndex, parseIndex, rawSections, sectionPath } from './sections.mjs';

const TIME_RE = /^\d{2}:\d{2}$/;

export async function searchPlace(opts = {}, query) {
  return searchDestination(opts, query);
}

export async function listPlaces(opts = {}, tripKey) {
  if (!tripKey) throw new UsageError('Usage: wlog places list <tripKey>');
  const trip = await getTrip(opts, tripKey);
  return rawSections(trip).flatMap(section => {
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    return blocks.map((block, blockIndex) => ({
      sectionId: section.id ?? null,
      sectionHeading: section.heading ?? null,
      ...normalizePlaceBlock(block, blockIndex),
    }));
  });
}

export async function addPlace(opts = {}, tripKey, sectionId, details = {}) {
  if (!tripKey || !sectionId) throw new UsageError('Usage: wlog places add <tripKey> <sectionId> --name --lat --lng --address [--notes --start --end --no-ai]');
  const { name, address, notes, startTime, endTime, ai = true } = details;
  if (!name) throw new UsageError('--name is required');
  if (!address) throw new UsageError('--address is required');
  const lat = parseCoordinate(details.lat, 'lat');
  const lng = parseCoordinate(details.lng, 'lng');
  validateOptionalTime(startTime, 'startTime');
  validateOptionalTime(endTime, 'endTime');

  const token = await loadToken(opts);
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const secIdx = findSectionIndex(sections, sectionId);
  const blocks = Array.isArray(sections[secIdx].blocks) ? sections[secIdx].blocks : [];
  const block = buildPlaceBlock({ name, lat, lng, address, notes, startTime, endTime, ai, userId: token?.userId });

  await applyTripOps(opts, tripKey, [{ p: sectionPath(secIdx, 'blocks', blocks.length), li: block }]);
  return { sectionId: String(sectionId), blockIndex: blocks.length, ...normalizePlaceBlock(block, blocks.length) };
}

export async function updatePlace(opts = {}, tripKey, sectionId, blockIndex, updates = {}) {
  if (!tripKey || !sectionId || blockIndex == null) throw new UsageError('Usage: wlog places update <tripKey> <sectionId> <blockIndex> [--name --address --notes --start --end --lat --lng]');
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const secIdx = findSectionIndex(sections, sectionId);
  const blocks = Array.isArray(sections[secIdx].blocks) ? sections[secIdx].blocks : [];
  const idx = parseIndex(blockIndex, 0, blocks.length - 1, 'blockIndex');
  const block = blocks[idx];
  if (!block || block.type !== 'place') throw new NotFoundError(`Place block not found at index: ${blockIndex}`);

  const ops = [];
  addNameOp(ops, secIdx, idx, block, updates);
  addSimplePlaceOp(ops, secIdx, idx, block, updates, 'address', ['place', 'formatted_address']);
  addNotesOp(ops, secIdx, idx, block, updates);
  addTimeOp(ops, secIdx, idx, block, updates, 'startTime');
  addTimeOp(ops, secIdx, idx, block, updates, 'endTime');
  addCoordinateOp(ops, secIdx, idx, block, updates, 'lat');
  addCoordinateOp(ops, secIdx, idx, block, updates, 'lng');

  if (ops.length > 0) await applyTripOps(opts, tripKey, ops);
  return { sectionId: String(sectionId), blockIndex: idx, changed: ops.length };
}

export async function deletePlace(opts = {}, tripKey, sectionId, blockIndex, { confirm } = {}) {
  if (!tripKey || !sectionId || blockIndex == null) throw new UsageError('Usage: wlog places delete <tripKey> <sectionId> <blockIndex> --confirm <blockIndex>');
  if (confirm !== String(blockIndex)) throw new ConfirmRequiredError(`Deletion requires --confirm ${blockIndex}`);
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const secIdx = findSectionIndex(sections, sectionId);
  const blocks = Array.isArray(sections[secIdx].blocks) ? sections[secIdx].blocks : [];
  const idx = parseIndex(blockIndex, 0, blocks.length - 1, 'blockIndex');
  await applyTripOps(opts, tripKey, [{ p: sectionPath(secIdx, 'blocks', idx), ld: blocks[idx] }]);
  return { deleted: true, sectionId: String(sectionId), blockIndex: idx };
}

export async function movePlace(opts = {}, tripKey, fromSectionId, blockIndex, toSectionId, toIndex) {
  if (!tripKey || !fromSectionId || blockIndex == null || !toSectionId) throw new UsageError('Usage: wlog places move <tripKey> <fromSectionId> <blockIndex> <toSectionId> [--to-index <n>]');
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const fromSecIdx = findSectionIndex(sections, fromSectionId);
  const toSecIdx = findSectionIndex(sections, toSectionId);
  const fromBlocks = Array.isArray(sections[fromSecIdx].blocks) ? sections[fromSecIdx].blocks : [];
  const toBlocks = Array.isArray(sections[toSecIdx].blocks) ? sections[toSecIdx].blocks : [];
  const fromIdx = parseIndex(blockIndex, 0, fromBlocks.length - 1, 'blockIndex');
  const insertionMax = fromSecIdx === toSecIdx ? Math.max(0, toBlocks.length - 1) : toBlocks.length;
  const targetIdx = toIndex == null ? insertionMax : parseIndex(toIndex, 0, insertionMax, 'toIndex');
  const block = fromBlocks[fromIdx];
  const ops = fromSecIdx === toSecIdx && fromIdx === targetIdx ? [] : [
    { p: sectionPath(fromSecIdx, 'blocks', fromIdx), ld: block },
    { p: sectionPath(toSecIdx, 'blocks', targetIdx), li: block },
  ];
  if (ops.length > 0) await applyTripOps(opts, tripKey, ops);
  return { fromSectionId: String(fromSectionId), toSectionId: String(toSectionId), fromIndex: fromIdx, toIndex: targetIdx };
}

function buildPlaceBlock({ name, lat, lng, address, notes, startTime, endTime, ai, userId }) {
  return {
    id: randomInt(100000000, 999999999),
    type: 'place',
    place: {
      name: ai ? addAiPrefix(name, generateAiHash()) : name,
      place_id: null,
      geometry: { location: { lat, lng } },
      formatted_address: address,
      types: ['point_of_interest'],
    },
    text: { ops: [{ insert: `${notes || ''}\n` }] },
    addedBy: { type: 'user', userId },
    imageSize: 'small',
    upvotedBy: [],
    travelMode: null,
    attachments: [],
    startTime: startTime || null,
    endTime: endTime || null,
  };
}

function addNameOp(ops, secIdx, blockIdx, block, updates) {
  if (updates.name == null) return;
  const oldName = block.place?.name ?? '';
  const nextName = preserveAiPrefix(oldName, updates.name);
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, 'place', 'name'), nextName, oldName);
}

function addSimplePlaceOp(ops, secIdx, blockIdx, block, updates, key, pathTail) {
  if (updates[key] == null) return;
  const oldValue = block.place?.formatted_address ?? null;
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, ...pathTail), updates[key], oldValue);
}

function addNotesOp(ops, secIdx, blockIdx, block, updates) {
  if (updates.notes == null) return;
  const oldText = block.text ?? { ops: [{ insert: '\n' }] };
  const newText = { ops: [{ insert: `${updates.notes || ''}\n` }] };
  if (JSON.stringify(oldText) !== JSON.stringify(newText)) {
    ops.push({ p: sectionPath(secIdx, 'blocks', blockIdx, 'text'), oi: newText, od: oldText });
  }
}

function addTimeOp(ops, secIdx, blockIdx, block, updates, key) {
  if (updates[key] == null) return;
  validateOptionalTime(updates[key], key);
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, key), updates[key] || null, block[key] ?? null);
}

function addCoordinateOp(ops, secIdx, blockIdx, block, updates, key) {
  if (updates[key] == null) return;
  const value = parseCoordinate(updates[key], key);
  const oldValue = block.place?.geometry?.location?.[key] ?? null;
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, 'place', 'geometry', 'location', key), value, oldValue);
}

function addReplaceOp(ops, path, oi, od) {
  if (oi !== od) ops.push({ p: path, oi, od });
}

function parseCoordinate(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new UsageError(`${label} must be numeric`);
  return number;
}

function validateOptionalTime(value, label) {
  if (value == null || value === '') return;
  if (!TIME_RE.test(String(value))) throw new UsageError(`${label} must match HH:MM`);
}
