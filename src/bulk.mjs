import { ConfirmRequiredError, UsageError } from './errors.mjs';
import { parseAiPrefix } from './ai-attribution.mjs';
import { normalizePlaceBlock } from './models.mjs';
import { getTrip, applyTripOps } from './trips.mjs';
import { rawSections, sectionPath } from './sections.mjs';

export function dryRunOps(ops = []) {
  const counts = { added: 0, removed: 0, modified: 0 };
  const operations = ops.map((op, index) => {
    const action = op.li !== undefined ? 'added' : op.ld !== undefined ? 'removed' : 'modified';
    counts[action] += 1;
    return { index, action, path: op.p.join('.'), summary: summarizeOp(op) };
  });
  return { dryRun: true, ...counts, operations };
}

export async function applyOpsBatch(opts = {}, tripKey, ops = [], { dryRun = false } = {}) {
  if (!tripKey) throw new UsageError('Missing tripKey');
  if (dryRun) return dryRunOps(ops);
  if (ops.length === 0) return { applied: 0 };
  await applyTripOps(opts, tripKey, ops);
  return { applied: ops.length };
}

export async function cleanupAiItems(opts = {}, tripKey, { hashPrefix, all = false, dryRun = false, confirm } = {}) {
  if (!tripKey) throw new UsageError('Usage: wlog debug cleanup-ai <tripKey> [--dry-run] [--hash <prefix>] --confirm <tripKey>');
  void all;
  if (!dryRun && confirm !== tripKey) {
    throw new ConfirmRequiredError(`Cleanup requires --confirm ${tripKey}`);
  }

  const trip = await getTrip(opts, tripKey);
  const matches = collectAiMatches(trip, hashPrefix);
  const ops = buildDeleteOps(matches);
  if (dryRun) return { ...dryRunOps(ops), items: matches.map(match => match.item) };

  await applyOpsBatch(opts, tripKey, ops, { dryRun: false });
  return { deleted: ops.length, tripKey };
}

function collectAiMatches(trip, hashPrefix) {
  const matches = [];
  rawSections(trip).forEach((section, secIdx) => {
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    blocks.forEach((block, blockIndex) => {
      const parsed = parseAiPrefix(block.place?.name ?? block.name);
      const hash = parsed?.hash ?? null;
      if (!parsed) return;
      if (hashPrefix && !hash?.startsWith(hashPrefix)) return;
      matches.push({
        secIdx,
        blockIndex,
        block,
        item: {
          sectionId: section.id ?? null,
          sectionHeading: section.heading ?? null,
          aiHash: hash,
          ...normalizePlaceBlock(block, blockIndex),
        },
      });
    });
  });
  return matches;
}

function buildDeleteOps(matches) {
  return [...matches]
    .sort((a, b) => (b.secIdx - a.secIdx) || (b.blockIndex - a.blockIndex))
    .map(match => ({ p: sectionPath(match.secIdx, 'blocks', match.blockIndex), ld: match.block }));
}

function summarizeOp(op) {
  if (op.li !== undefined) return `add ${describeValue(op.li)}`;
  if (op.ld !== undefined) return `remove ${describeValue(op.ld)}`;
  return `modify ${JSON.stringify(op.od)} -> ${JSON.stringify(op.oi)}`;
}

function describeValue(value) {
  return value?.place?.name ?? value?.heading ?? value?.name ?? value?.id ?? '(object)';
}
