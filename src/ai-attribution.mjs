import { createHash, randomBytes } from 'node:crypto';

const AI_PREFIX_RE = /^\[🤵‍♂️ - ([a-f0-9]{8,})\]\s*(.*)$/;

export function generateAiHash(input) {
  const seed = input || randomBytes(8).toString('hex');
  return createHash('sha256').update(String(seed)).digest('hex').slice(0, 8);
}

export function formatAiPrefix(hash) {
  return `[🤵‍♂️ - ${hash}]`;
}

export function addAiPrefix(name, hash) {
  if (parseAiPrefix(name)) return name;
  return `${formatAiPrefix(hash)} ${name}`;
}

export function parseAiPrefix(name) {
  if (typeof name !== 'string') return null;
  const match = name.match(AI_PREFIX_RE);
  if (!match) return null;
  return { hash: match[1], baseName: match[2] };
}

export function preserveAiPrefix(oldName, newName) {
  const parsed = parseAiPrefix(oldName) ?? parseAiPrefix(newName);
  const stripped = parseAiPrefix(newName)?.baseName ?? newName;
  const hash = parsed?.hash ?? generateAiHash(`${oldName ?? ''}:${newName ?? ''}`);
  return `${formatAiPrefix(hash)} ${stripped}`;
}
