import { randomInt } from 'node:crypto';
import { ApiError, ConfirmRequiredError, NotFoundError, UsageError, VerificationError } from './errors.mjs';
import { normalizeSection } from './models.mjs';
import { getTrip, applyTripOps, applyGuardedOps, textCompare } from './trips.mjs';
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

export async function updateNote(opts = {}, tripKey, sectionId, blockIndex, text, { confirm, expectedNotes } = {}) {
  if (!tripKey || !sectionId || blockIndex == null || typeof text !== 'string' || !text.trim() || typeof expectedNotes !== 'string' || !expectedNotes.trim()) {
    throw new UsageError('Usage: wlog sections update-note <tripKey> <sectionId> <blockIndex> --notes <text> --expected-notes <old text> --confirm <blockId>');
  }
  const sections = rawSections(await getTrip(opts, tripKey));
  const idx = findSectionIndex(sections, sectionId);
  const blocks = sections[idx].blocks;
  if (!Array.isArray(blocks)) throw new UsageError('Section has no blocks');
  const pos = parseIndex(blockIndex, 0, blocks.length - 1, 'blockIndex');
  const block = blocks[pos];
  if (block?.type !== 'note') throw new UsageError('Target block is not a note');
  if (confirm !== String(block.id)) throw new ConfirmRequiredError(`Update requires --confirm ${block.id}`);
  const old = block.text;
  if (!old || Object.keys(old).length !== 1 || !Array.isArray(old.ops) || old.ops.length !== 1 || Object.keys(old.ops[0]).length !== 1 || typeof old.ops[0].insert !== 'string') {
    throw new UsageError('Refusing to overwrite formatted or unsupported note text');
  }
  if (old.ops[0].insert !== `${expectedNotes.trim()}\n`) throw new UsageError('Expected note text does not match current text');
  const replacement = { ops: [{ insert: `${text.trim()}\n` }] };
  // applyOps does not compare `od`/`ld` values (see the header of
  // src/budget.mjs), so an object replace at an index taken from the fetch
  // could land on a neighbour after a phone edit. The note text is a plain
  // string at text.ops[0].insert: the update is a text0 delete-old-insert-new
  // on that string, which the server refuses unless the string still starts
  // with the old text, with compares on the section and block type in front.
  const inspect = `wlog sections list ${tripKey} --json`;
  const ops = [
    ...noteGuards(sections, idx, pos),
    { p: sectionPath(idx, 'blocks', pos, 'text', 'ops', 0, 'insert'), t: 'text0', o: [{ p: 0, d: old.ops[0].insert }, { p: 0, i: replacement.ops[0].insert }] },
  ];
  const after = await applyGuardedOps(opts, tripKey, ops, {
    label: `update of note ${block.id}`,
    subject: 'Note',
    changed: 'The trip changed since it was fetched (a section or block was added, moved, removed or edited)',
    inspect,
    read: data => rawSections({ raw: data }),
  });
  const saved = after.find(s => String(s.id) === String(sectionId))?.blocks?.find(b => String(b.id) === String(block.id));
  if (saved?.type !== 'note' || JSON.stringify(saved.text) !== JSON.stringify(replacement)) {
    throw new VerificationError(`Post-update verification failed for note ${block.id}: the write was accepted but the note ${saved ? 'does not hold the requested text' : 'is no longer in the section'}; not retried. Before retrying run: ${inspect}`);
  }
  return { sectionId: String(sectionId), blockId: block.id, text: text.trim() };
}

// text0 compare components for the note at sections[idx].blocks[pos], to put
// in front of its text change in the same batch: the section's heading and
// date (when non-empty strings) and the block's type. Together with the text
// change itself they tie the batch to this note; ids are numbers, which the
// server cannot compare. Each compare is a prefix compare, so refuse a note
// that another block of the trip could pass for: after a concurrent insert or
// removal that other block could sit at this index.
function noteGuards(sections, idx, pos) {
  const section = sections[idx];
  const block = section.blocks[pos];
  const oldText = block.text.ops[0].insert;
  const sectionFields = ['heading', 'date'].filter(key => typeof section[key] === 'string' && section[key] !== '');
  const passes = (otherSection, other) => sectionFields.every(key => typeof otherSection[key] === 'string' && otherSection[key].startsWith(section[key]))
    && typeof other?.type === 'string' && other.type.startsWith(block.type)
    && typeof other.text?.ops?.[0]?.insert === 'string' && other.text.ops[0].insert.startsWith(oldText);
  for (const [si, otherSection] of sections.entries()) {
    for (const [bi, other] of (Array.isArray(otherSection?.blocks) ? otherSection.blocks : []).entries()) {
      if ((si !== idx || bi !== pos) && passes(otherSection, other)) {
        throw new ConfirmRequiredError(`Note ${block.id} cannot be told apart from block ${other.id} by section heading, date, block type and text, so the server cannot check which one it is at write time; edit it in the Wanderlog app`);
      }
    }
  }
  return [
    ...sectionFields.map(key => textCompare(sectionPath(idx, key), section[key])),
    textCompare(sectionPath(idx, 'blocks', pos, 'type'), block.type),
  ];
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
