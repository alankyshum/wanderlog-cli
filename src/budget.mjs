import { randomInt } from 'node:crypto';
import { createClient } from './client.mjs';
import { loadToken } from './token-store.mjs';
import { applyTripOps } from './trips.mjs';
import { assertTripPlanValid } from './validation.mjs';
import {
  ApiError, AuthExpiredError, AuthRequiredError, ConcurrentChangeError, ConfirmRequiredError, ConflictError,
  NotFoundError, TokenCorruptError, UsageError, VerificationError,
} from './errors.mjs';

// Concurrency contract of POST /api/tripPlans/<key>/applyOps, measured on a
// sandbox trip on 2026-11-16 with throwaway expenses (the official web editor
// does not use this endpoint for edits: it submits over a ShareDB WebSocket,
// /api/tripPlans/wsOverall/<key>, with the document version; this endpoint
// takes only { ops } and ignores v / version / overallVersion in the body):
//   - `ld` deletes whatever sits at the index. The old value is NOT compared:
//     an `ld` carrying expense B aimed at expense A's index deleted A and
//     answered { success: true }. `od` is not compared either.
//   - An `ld` or `li` index past the end answers HTTP 200 { success: false,
//     errTypes: ['unexpectedError'], error: '… out of bounds …' }.
//   - A text0 component { p: [..., field], t: 'text0', o: [{ p: 0, d: TEXT },
//     { p: 0, i: TEXT }] } IS compared: when the string at that path does not
//     start with TEXT the server answers { success: false, error: "… Delete
//     component … does not match deleted text …" }. When it matches, the
//     string is left as it was.
//   - A batch is atomic: one failing component rejects every op in it, also
//     the ones listed before it.
// So an index taken from a fetch is unsafe on its own (the phone app may add
// or remove an expense before the post), and update/remove put text0 compare
// components for the target's string fields in front of the change, in the
// same batch. A mismatch writes nothing and exits 8 (ConcurrentChangeError),
// as does an add whose append index is past a list that got shorter. An add
// cannot delete anything, so it carries no compare components.
// The compare is a prefix compare of strings only: see expenseGuards.

// Wanderlog's own expense category enum, read from its web client bundle
// (itin-compiled.azureedge.net/.../2864.main.*.js, webpack module 549167).
// A value outside this enum can break the Budget widget; never add one that is
// not in the client.
export const EXPENSE_CATEGORIES = Object.freeze([
  'flights', 'lodging', 'carRental', 'publicTransit', 'food', 'drinks',
  'sightseeing', 'activities', 'shopping', 'gas', 'groceries', 'other',
]);

export const DEFAULT_OWNER_TAG = 'tf';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OWNER_TAG_RE = /^[A-Za-z0-9_-]{1,24}$/;
const EXTERNAL_ID_RE = /^[A-Za-z0-9._:/-]{1,80}$/;
const TAG_SUFFIX_RE = / \[([A-Za-z0-9_-]{1,24}):([A-Za-z0-9._:/-]{1,80})\]$/;
const EXPENSES_PATH = ['itinerary', 'budget', 'expenses'];
// String fields the server can compare (description first: it carries the tag).
const GUARD_FIELDS = [['description'], ['category'], ['date'], ['associatedDate'], ['amount', 'currencyCode']];
// Server error texts seen when a compare component meets a different expense,
// no expense or a non-string, and when a list index is past the end.
const GUARD_REFUSAL_RE = /does not match deleted text|out of bounds|Cannot read properties of undefined|is not a function/;

export const BUDGET_USAGE = `Usage: wlog budget <list|add|update|remove> <tripKey> [options]

  list   <tripKey> [--owner-tag TEXT] [--json]
  add    <tripKey> --amount N --currency CODE --category CATEGORY --description TEXT
         [--date YYYY-MM-DD] [--paid-by USERID] [--split-with USERID,USERID]
         [--external-id TEXT] [--owner-tag TEXT] [--dry-run]
  update <tripKey> --id ID (--expect-external-id TEXT | --expect-description TEXT)
         [--amount N] [--currency CODE] [--category CATEGORY] [--description TEXT]
         [--date YYYY-MM-DD] [--paid-by USERID] [--split-with USERID,USERID]
         [--owner-tag TEXT] [--force-unowned] [--dry-run]
  remove <tripKey> --id ID (--expect-external-id TEXT | --expect-description TEXT)
         [--owner-tag TEXT] [--force-unowned] [--dry-run]

Categories: ${EXPENSE_CATEGORIES.join(', ')}.
Ownership is a trailing description tag " [<owner-tag>:<external-id>]" (owner tag
default "${DEFAULT_OWNER_TAG}"). update/remove refuse an expense without the caller's tag unless
--force-unowned is given. Every mutation fetches first, sends one op batch,
re-fetches and verifies; nothing is retried. update/remove make the server
compare the expense's description, category, dates and currency in the same
batch, so an expense that moved or changed since the fetch is never touched.
Exit codes: 2 usage/invalid value, 4 expense not found, 5 guard refused,
6 external id already present, 7 post-write verification failed or write
uncertain (run budget list before retrying), 8 expense changed or moved since
the fetch: nothing written, safe to re-run.`;

export async function runBudgetCommand(opts = {}, subcommand, args = []) {
  const tripKey = args[0];
  switch (subcommand) {
    case 'list':
      return listExpenses(opts, tripKey, { ownerTag: opts.ownerTag });
    case 'add':
      return addExpense(opts, tripKey, {
        amount: opts.amount, currency: opts.currency, category: opts.category, description: opts.description,
        date: opts.date, paidBy: opts.paidBy, splitWith: opts.splitWith,
        externalId: opts.externalId, ownerTag: opts.ownerTag, dryRun: Boolean(opts.dryRun),
      });
    case 'update':
      return updateExpense(opts, tripKey, {
        id: opts.id, expectExternalId: opts.expectExternalId, expectDescription: opts.expectDescription,
        forceUnowned: Boolean(opts.forceUnowned), ownerTag: opts.ownerTag, dryRun: Boolean(opts.dryRun),
        amount: opts.amount, currency: opts.currency, category: opts.category, description: opts.description,
        date: opts.date, paidBy: opts.paidBy, splitWith: opts.splitWith,
      });
    case 'remove':
      return removeExpense(opts, tripKey, {
        id: opts.id, expectExternalId: opts.expectExternalId, expectDescription: opts.expectDescription,
        forceUnowned: Boolean(opts.forceUnowned), ownerTag: opts.ownerTag, dryRun: Boolean(opts.dryRun),
      });
    default:
      throw new UsageError(BUDGET_USAGE);
  }
}

export async function listExpenses(opts = {}, tripKey, { ownerTag } = {}) {
  if (!tripKey) throw new UsageError('Usage: wlog budget list <tripKey> [--owner-tag TEXT] [--json]');
  const tag = normalizeOwnerTag(ownerTag);
  const state = readBudget(await fetchTrip(opts, tripKey));
  return {
    tripKey,
    budget: state.budget.amount ?? null,
    contributors: state.contributorIds,
    editors: state.editorIds,
    payments: state.payments.length,
    count: state.expenses.length,
    expenses: state.expenses.map((expense, index) => normalizeExpense(expense, index, tag)),
  };
}

export async function addExpense(opts = {}, tripKey, input = {}) {
  if (!tripKey) throw new UsageError('Usage: wlog budget add <tripKey> --amount N --currency CODE --category CATEGORY --description TEXT');
  const ownerTag = normalizeOwnerTag(input.ownerTag);
  const externalId = input.externalId == null ? null : parseExternalId(input.externalId);
  const amount = parseAmount(input.amount);
  const currencyCode = parseCurrency(input.currency);
  const category = parseCategory(input.category);
  const text = parseDescriptionText(input.description);
  const today = localToday();
  const associatedDate = input.date == null ? today : parseDate(input.date);

  const before = readBudget(await fetchTrip(opts, tripKey));
  assertCurrencyKnown(before, currencyCode);
  if (externalId) {
    const existing = before.expenses.find(e => {
      const own = parseOwnership(e?.description);
      return own.ownerTag === ownerTag && own.externalId === externalId;
    });
    if (existing) throw new ConflictError(`Expense with external id ${ownerTag}:${externalId} already exists (id ${existing.id}); not added`);
  }
  const paidBy = input.paidBy == null ? await defaultPayer(opts) : parseUserId(input.paidBy, '--paid-by');
  assertMember(before, paidBy, '--paid-by');
  const splitIds = input.splitWith == null ? before.contributorIds : parseUserIds(input.splitWith);
  for (const id of splitIds) assertMember(before, id, '--split-with');

  const expense = buildExpense({
    id: newExpenseId(before.expenses),
    amount, currencyCode, category,
    description: externalId ? `${text}${formatTag(ownerTag, externalId)}` : text,
    date: today, associatedDate, paidBy, splitIds,
  });
  const index = before.expenses.length;
  const ops = [{ p: [...EXPENSES_PATH, index], li: expense }];
  if (input.dryRun) return { dryRun: true, ops };

  const after = await writeAndRefetch(opts, tripKey, ops, `add of expense ${expense.id}`);
  verifyOthersUnchanged(before, after, expense.id);
  const saved = after.expenses.find(e => sameId(e?.id, expense.id));
  if (!saved || !isSubset(expense, saved)) {
    throw new VerificationError(`Post-add verification failed: expense ${expense.id} is ${saved ? 'present with different fields' : 'absent'} after the write; not retried. Inspect with: wlog budget list ${tripKey} --json`);
  }
  return { added: true, ...normalizeExpense(saved, after.expenses.indexOf(saved), ownerTag) };
}

export async function updateExpense(opts = {}, tripKey, input = {}) {
  const usage = 'Usage: wlog budget update <tripKey> --id ID (--expect-external-id TEXT | --expect-description TEXT) [fields]';
  if (!tripKey || input.id == null) throw new UsageError(usage);
  const ownerTag = normalizeOwnerTag(input.ownerTag);
  const changes = {};
  if (input.amount != null) changes.amount = parseAmount(input.amount);
  if (input.currency != null) changes.currencyCode = parseCurrency(input.currency);
  if (input.category != null) changes.category = parseCategory(input.category);
  if (input.description != null) changes.text = parseDescriptionText(input.description);
  if (input.date != null) changes.associatedDate = parseDate(input.date);
  if (input.paidBy != null) changes.paidBy = parseUserId(input.paidBy, '--paid-by');
  if (input.splitWith != null) changes.splitIds = parseUserIds(input.splitWith);
  if (Object.keys(changes).length === 0) throw new UsageError(`${usage}\nNo fields to change were given`);

  const before = readBudget(await fetchTrip(opts, tripKey));
  const { index, expense: old } = locateGuarded(before, input, ownerTag);
  if (changes.currencyCode) assertCurrencyKnown(before, changes.currencyCode);
  if (changes.paidBy != null) assertMember(before, changes.paidBy, '--paid-by');
  for (const id of changes.splitIds ?? []) assertMember(before, id, '--split-with');

  const own = parseOwnership(old.description);
  const next = structuredClone(old);
  if (changes.amount != null || changes.currencyCode) {
    next.amount = { ...(old.amount ?? {}) };
    if (changes.amount != null) next.amount.amount = changes.amount;
    if (changes.currencyCode) next.amount.currencyCode = changes.currencyCode;
  }
  if (changes.category) next.category = changes.category;
  // The ownership tag is preserved: a caller changes the text, never the tag.
  if (changes.text != null) next.description = own.externalId ? `${changes.text}${formatTag(own.ownerTag, own.externalId)}` : changes.text;
  if (changes.associatedDate) next.associatedDate = changes.associatedDate;
  if (changes.paidBy != null) {
    next.paidByUserId = changes.paidBy;
    next.paidByUser = { type: 'registered', id: changes.paidBy };
  }
  if (changes.splitIds) next.splitWith = splitWithUsers(changes.splitIds);

  if (canonical(next) === canonical(old)) {
    return { updated: false, unchanged: true, ...normalizeExpense(old, index, ownerTag) };
  }
  // Field-level replacements keep the expense object (and any field this
  // call does not change) in place; the compare components go first.
  const ops = [...expenseGuards(before, index), ...fieldOps(index, old, next)];
  if (input.dryRun) return { dryRun: true, ops };

  const after = await writeAndRefetch(opts, tripKey, ops, `update of expense ${old.id}`);
  verifyOthersUnchanged(before, after, old.id);
  const saved = after.expenses.find(e => sameId(e?.id, old.id));
  if (!saved || canonical(saved) !== canonical(next)) {
    throw new VerificationError(`Post-update verification failed: expense ${old.id} is ${saved ? 'present but does not match the requested fields' : 'absent'} after the write; not retried. Inspect with: wlog budget list ${tripKey} --json`);
  }
  return { updated: true, ...normalizeExpense(saved, after.expenses.indexOf(saved), ownerTag) };
}

export async function removeExpense(opts = {}, tripKey, input = {}) {
  if (!tripKey || input.id == null) throw new UsageError('Usage: wlog budget remove <tripKey> --id ID (--expect-external-id TEXT | --expect-description TEXT)');
  const ownerTag = normalizeOwnerTag(input.ownerTag);
  const before = readBudget(await fetchTrip(opts, tripKey));
  const { index, expense: old } = locateGuarded(before, input, ownerTag);
  const ops = [...expenseGuards(before, index), { p: [...EXPENSES_PATH, index], ld: old }];
  if (input.dryRun) return { dryRun: true, ops };

  const after = await writeAndRefetch(opts, tripKey, ops, `removal of expense ${old.id}`);
  verifyOthersUnchanged(before, after, old.id);
  if (after.expenses.some(e => sameId(e?.id, old.id))) {
    throw new VerificationError(`Post-remove verification failed: expense ${old.id} is still present after the write; not retried. Inspect with: wlog budget list ${tripKey} --json`);
  }
  return { removed: true, ...normalizeExpense(old, index, ownerTag), index: null };
}

// --- pure helpers (exported for tests) ---

export function parseOwnership(description) {
  const raw = typeof description === 'string' ? description : '';
  const match = TAG_SUFFIX_RE.exec(raw);
  if (!match) return { text: raw, ownerTag: null, externalId: null };
  return { text: raw.slice(0, match.index), ownerTag: match[1], externalId: match[2] };
}

export function formatTag(ownerTag, externalId) {
  return ` [${ownerTag}:${externalId}]`;
}

export function buildExpense({ id, amount, currencyCode, category, description, date, associatedDate, paidBy, splitIds }) {
  // Field set and order follow the manual "add expense" form in Wanderlog's web
  // client: `date` is the creation day, `associatedDate` the day it applies to.
  return {
    id,
    amount: { amount, currencyCode },
    category,
    description,
    date,
    blockId: null,
    paidByUserId: paidBy,
    paidByUser: { type: 'registered', id: paidBy },
    splitWith: splitWithUsers(splitIds),
    associatedDate,
  };
}

export function normalizeExpense(expense = {}, index = null, ownerTag = DEFAULT_OWNER_TAG) {
  const own = parseOwnership(expense.description);
  return {
    id: expense.id ?? null,
    index,
    amount: expense.amount?.amount ?? null,
    currency: expense.amount?.currencyCode ?? null,
    category: expense.category ?? null,
    description: own.text,
    raw_description: typeof expense.description === 'string' ? expense.description : null,
    date: expense.associatedDate ?? expense.date ?? null,
    created_date: expense.date ?? null,
    paid_by: expense.paidByUser?.id ?? expense.paidByUserId ?? null,
    split_with: Array.isArray(expense.splitWith?.users) ? expense.splitWith.users.map(u => u?.id) : [],
    block_id: expense.blockId ?? null,
    owner_tag: own.ownerTag,
    external_id: own.externalId,
    owned: own.externalId != null && own.ownerTag === ownerTag,
  };
}

export function readBudget(data) {
  const tripPlan = data?.tripPlan ?? data?.data?.tripPlan ?? null;
  const budget = tripPlan?.itinerary?.budget;
  if (!budget || typeof budget !== 'object' || !Array.isArray(budget.expenses)) {
    throw new ApiError('Trip has no tripPlan.itinerary.budget.expenses array; refusing to guess the Budget layout');
  }
  return {
    budget,
    expenses: budget.expenses,
    payments: Array.isArray(budget.payments) ? budget.payments : [],
    contributorIds: userIds(tripPlan.contributors),
    editorIds: userIds(tripPlan.editors),
    currencyRates: data?.resources?.currencyRatesUSD ?? null,
  };
}

// --- internals ---

async function fetchTrip(opts, tripKey) {
  return createClient(opts).get(`/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2`);
}

async function writeAndRefetch(opts, tripKey, ops, label) {
  const inspect = `not retried. Before retrying run: wlog budget list ${tripKey} --json`;
  let result;
  try {
    result = await applyTripOps({ ...opts, skipPostValidate: true }, tripKey, ops);
  } catch (err) {
    // Missing or refused credentials, a 404 and a 4xx answer are definite
    // rejections. Anything else (network failure, 5xx, a body that cannot be
    // read or parsed) may or may not have been applied.
    const definite = err instanceof AuthRequiredError || err instanceof AuthExpiredError || err instanceof TokenCorruptError
      || err instanceof NotFoundError || err instanceof UsageError
      || (err instanceof ApiError && err.status >= 400 && err.status < 500);
    if (definite) throw err;
    throw new VerificationError(`Budget write outcome is uncertain for ${label} (${err?.message ?? err}); ${inspect}`);
  }
  if (result?.success === false) {
    // A refused batch is refused as a whole (see the header comment).
    if (GUARD_REFUSAL_RE.test(String(result.error ?? ''))) {
      throw new ConcurrentChangeError(`The Budget changed since it was fetched (an expense changed, moved or was removed), so Wanderlog refused the ${label}; nothing was written. Safe to re-run after: wlog budget list ${tripKey} --json`);
    }
    // The server's error text echoes trip data; report only its type.
    throw new ApiError(`Wanderlog rejected the ${label}; nothing was written (${[].concat(result.errTypes ?? 'no error type').join(', ')})`);
  }
  // From here on the write has been accepted: every failure is exit 7.
  try {
    const data = await fetchTrip(opts, tripKey);
    assertTripPlanValid(data);
    return readBudget(data);
  } catch (err) {
    throw new VerificationError(`Budget write sent for ${label} but it could not be verified (${err?.message ?? err}); ${inspect}`);
  }
}

// text0 compare components for the expense at `index`, to put in front of a
// change in the same batch. The server compares each string from its start,
// so a longer string with the same beginning also passes, and numbers (id,
// amount) cannot be compared at all. To keep that from mattering, refuse an
// expense that has no description or that another expense could pass for.
function expenseGuards(state, index) {
  const expense = state.expenses[index];
  const fields = GUARD_FIELDS.map(path => [path, path.reduce((value, key) => value?.[key], expense)])
    .filter(([, text]) => typeof text === 'string' && text !== '');
  if (fields[0]?.[0] !== GUARD_FIELDS[0]) {
    throw new ConfirmRequiredError(`Expense ${expense.id} has no description, so the server cannot check it is still the same expense at write time; edit it in the Wanderlog app`);
  }
  const twin = state.expenses.find((other, i) => i !== index && fields.every(([path, text]) => {
    const value = path.reduce((v, key) => v?.[key], other);
    return typeof value === 'string' && value.startsWith(text);
  }));
  if (twin) {
    throw new ConfirmRequiredError(`Expense ${expense.id} cannot be told apart from expense ${twin.id} by description, category, dates and currency, so the server cannot check which one it is at write time; edit it in the Wanderlog app`);
  }
  return fields.map(([path, text]) => ({ p: [...EXPENSES_PATH, index, ...path], t: 'text0', o: [{ p: 0, d: text }, { p: 0, i: text }] }));
}

function fieldOps(index, old, next) {
  const ops = [];
  const visit = (path, a, b) => {
    if (canonical(a) === canonical(b)) return;
    const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (path.length === 1 && path[0] === 'amount' && plain(a) && plain(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) visit([...path, key], a[key], b[key]);
      return;
    }
    ops.push({ p: [...EXPENSES_PATH, index, ...path], ...(a === undefined ? {} : { od: a }), oi: b });
  };
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) visit([key], old[key], next[key]);
  return ops;
}

function locateGuarded(state, input, ownerTag) {
  const index = state.expenses.findIndex(e => sameId(e?.id, input.id));
  if (index === -1) throw new NotFoundError(`Expense not found: ${input.id}`);
  if (state.expenses.filter(e => sameId(e?.id, input.id)).length > 1) {
    throw new ConfirmRequiredError(`Expense id ${input.id} is not unique in this trip; refusing to guess`);
  }
  const expense = state.expenses[index];
  const own = parseOwnership(expense.description);
  const hasExternal = input.expectExternalId != null;
  const hasDescription = input.expectDescription != null;
  if (!hasExternal && !hasDescription) {
    throw new ConfirmRequiredError('A guard is required: --expect-external-id <id> or --expect-description <exact current description>');
  }
  if (hasExternal && (own.ownerTag !== ownerTag || own.externalId !== String(input.expectExternalId))) {
    throw new ConfirmRequiredError(`Guard failed: expense ${expense.id} does not carry the tag [${ownerTag}:${input.expectExternalId}]`);
  }
  if (hasDescription && expense.description !== input.expectDescription) {
    throw new ConfirmRequiredError(`Guard failed: expense ${expense.id} description does not match --expect-description exactly`);
  }
  const owned = own.externalId != null && own.ownerTag === ownerTag;
  if (!owned && !input.forceUnowned) {
    throw new ConfirmRequiredError(`Expense ${expense.id} does not carry a [${ownerTag}:...] tag; pass --force-unowned to touch an expense this caller does not own`);
  }
  return { index, expense };
}

function verifyOthersUnchanged(before, after, targetId) {
  const others = list => list.filter(e => !sameId(e?.id, targetId)).map(canonical);
  const a = others(before.expenses);
  const b = others(after.expenses);
  if (a.length !== b.length || a.some((value, i) => value !== b[i])) {
    throw new VerificationError(`Post-write verification failed: other expenses changed (${a.length} before, ${b.length} after); not retried. Inspect the trip before further edits`);
  }
  if (canonical(before.payments) !== canonical(after.payments)) {
    throw new VerificationError('Post-write verification failed: the payments array changed; not retried. Inspect the trip before further edits');
  }
  if (canonical(before.budget.amount) !== canonical(after.budget.amount)) {
    throw new VerificationError('Post-write verification failed: the budget amount changed; not retried. Inspect the trip before further edits');
  }
}

function splitWithUsers(ids) {
  // Wanderlog persists every split as "individuals"; "everyone" is the list of
  // all members and "don't split" is an empty list. The amount is divided
  // equally among the listed users.
  return { type: 'individuals', users: ids.map(id => ({ type: 'registered', id })) };
}

function newExpenseId(expenses) {
  // Same range as the web client's Math.floor(1e9 * Math.random()).
  const taken = new Set(expenses.map(e => String(e?.id)));
  let id;
  do id = randomInt(1, 1000000000); while (taken.has(String(id)));
  return id;
}

async function defaultPayer(opts) {
  const token = await loadToken(opts);
  if (!/^\d+$/.test(String(token?.userId ?? ''))) throw new UsageError('--paid-by <userId> is required (no numeric logged-in user id is stored)');
  return Number(token.userId);
}

function assertMember(state, id, flag) {
  if (!state.contributorIds.includes(id) && !state.editorIds.includes(id)) {
    throw new UsageError(`${flag} user ${id} is not a contributor or editor of this trip`);
  }
}

function assertCurrencyKnown(state, currencyCode) {
  if (state.currencyRates && typeof state.currencyRates === 'object' && !(currencyCode in state.currencyRates)) {
    throw new UsageError(`--currency ${currencyCode} is not in Wanderlog's currency rate table`);
  }
}

function userIds(users) {
  return Array.isArray(users) ? users.map(u => u?.id).filter(id => Number.isInteger(id)) : [];
}

function normalizeOwnerTag(value) {
  if (value == null) return DEFAULT_OWNER_TAG;
  if (!OWNER_TAG_RE.test(String(value))) throw new UsageError('--owner-tag must be 1-24 characters of A-Z, a-z, 0-9, _ or -');
  return String(value);
}

function parseExternalId(value) {
  if (!EXTERNAL_ID_RE.test(String(value))) throw new UsageError('--external-id must be 1-80 characters of A-Z, a-z, 0-9, . _ : / or -');
  return String(value);
}

function parseAmount(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim() || NaN);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError('--amount must be a number greater than 0');
  return n;
}

function parseCurrency(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new UsageError('--currency must be a 3-letter ISO 4217 code');
  return code;
}

function parseCategory(value) {
  if (!EXPENSE_CATEGORIES.includes(value)) {
    throw new UsageError(`--category must be one of: ${EXPENSE_CATEGORIES.join(', ')}`);
  }
  return value;
}

function parseDescriptionText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new UsageError('--description is required');
  if (/[\r\n]/.test(text)) throw new UsageError('--description must be a single line');
  if (TAG_SUFFIX_RE.test(text)) throw new UsageError('--description must not end with an ownership tag; use --external-id');
  return text;
}

function parseDate(value) {
  const text = String(value);
  const time = Date.parse(`${text}T00:00:00Z`);
  if (!DATE_RE.test(text) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== text) {
    throw new UsageError('--date must be a valid YYYY-MM-DD date');
  }
  return text;
}

function parseUserId(value, flag) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new UsageError(`${flag} must be a numeric Wanderlog user id`);
  return Number(text);
}

function parseUserIds(value) {
  const ids = String(value).split(',').map(part => part.trim()).filter(Boolean).map(part => parseUserId(part, '--split-with'));
  if (ids.length === 0) throw new UsageError('--split-with requires at least one user id');
  if (new Set(ids).size !== ids.length) throw new UsageError('--split-with must not repeat a user id');
  return ids;
}

function localToday() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function isSubset(expected, actual) {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (actual === null || typeof actual !== 'object' || Array.isArray(expected) !== Array.isArray(actual)) return false;
  if (Array.isArray(expected)) return expected.length === actual.length && expected.every((value, i) => isSubset(value, actual[i]));
  return Object.keys(expected).every(key => isSubset(expected[key], actual[key]));
}

function canonical(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  }
  return value;
}
