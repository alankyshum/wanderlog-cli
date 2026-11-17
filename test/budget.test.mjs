import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../bin/args.mjs';
import { createCommandDispatcher } from '../src/commands.mjs';
import { saveToken, TOKEN_VERSION } from '../src/token-store.mjs';
import { ConfirmRequiredError, ConflictError, NotFoundError, UsageError, VerificationError } from '../src/errors.mjs';
import {
  EXPENSE_CATEGORIES, addExpense, buildExpense, listExpenses, normalizeExpense, parseOwnership, removeExpense, updateExpense,
} from '../src/budget.mjs';

const ALICE = 1001;
const BOB = 1002;

function fixtureExpense(id, description, overrides = {}) {
  return {
    id,
    amount: { amount: 10, currencyCode: 'USD' },
    category: 'food',
    description,
    date: '2026-01-01',
    blockId: null,
    paidByUserId: ALICE,
    paidByUser: { type: 'registered', id: ALICE },
    splitWith: { type: 'individuals', users: [{ type: 'registered', id: ALICE }, { type: 'registered', id: BOB }] },
    associatedDate: '2026-01-02',
    ...overrides,
  };
}

function fixtureTrip(expenses = []) {
  return {
    tripPlan: {
      contributors: [{ id: ALICE, username: 'fixture-a' }, { id: BOB, username: 'fixture-b' }],
      editors: [{ id: ALICE, username: 'fixture-a' }],
      itinerary: {
        sections: [{ id: 100, heading: 'Day', type: 'normal', mode: 'dayPlan', blocks: [] }],
        budget: {
          amount: { amount: 500, currencyCode: 'USD' },
          expenses,
          payments: [{ id: 9, amount: { amount: 5, currencyCode: 'USD' }, fromUser: { type: 'registered', id: BOB }, toUser: { type: 'registered', id: ALICE } }],
          simplifyDebt: true,
        },
      },
    },
    resources: { currencyRatesUSD: { USD: 1, KRW: 0.0007, HKD: 0.128 } },
  };
}

// Mock Wanderlog: serves the trip and applies JSON0 list ops with exact
// old-value checks, like the real server. `hooks` lets a test sabotage a write.
async function harness(t, trip, hooks = {}) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-budget-test-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  await saveToken({ configDir }, { version: TOKEN_VERSION, baseUrl: 'https://example.test', userId: String(ALICE), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', cookies: [{ name: 'connect.sid', value: 'FAKE', domain: 'example.test', path: '/' }] });
  const calls = { get: 0, post: 0, ops: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/tripPlans/fixture/applyOps')) {
      calls.post += 1;
      const { ops } = JSON.parse(init.body);
      calls.ops.push(ops);
      if (hooks.postResponse) return hooks.postResponse();
      if (!hooks.dropWrite) {
        for (const op of ops) {
          assert.deepEqual(op.p.slice(0, 3), ['itinerary', 'budget', 'expenses']);
          const list = trip.tripPlan.itinerary.budget.expenses;
          const index = op.p[3];
          if ('ld' in op) {
            assert.deepEqual(list[index], op.ld, 'ld must be the exact current object');
            list.splice(index, 1);
          }
          if ('li' in op) list.splice(index, 0, hooks.mutateInsert ? hooks.mutateInsert(structuredClone(op.li)) : op.li);
        }
      }
      hooks.afterWrite?.(trip);
      return Response.json({ success: true });
    }
    if (u.includes('/api/tripPlans/fixture?')) {
      calls.get += 1;
      return Response.json(trip);
    }
    throw new Error(`unexpected network request: ${u}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { opts: { configDir }, calls };
}

const baseAdd = { amount: '1.23', currency: 'usd', category: 'food', description: 'AI test expense', date: '2026-02-03', paidBy: String(ALICE), externalId: 'ai-test-1' };

test('category vocabulary is the web client enum', () => {
  assert.deepEqual([...EXPENSE_CATEGORIES], ['flights', 'lodging', 'carRental', 'publicTransit', 'food', 'drinks', 'sightseeing', 'activities', 'shopping', 'gas', 'groceries', 'other']);
  assert.ok(!EXPENSE_CATEGORIES.includes('transit'));
});

test('ownership tag parsing and list normalization', () => {
  assert.deepEqual(parseOwnership('Dinner [tf:2026-12/row-7]'), { text: 'Dinner', ownerTag: 'tf', externalId: '2026-12/row-7' });
  assert.deepEqual(parseOwnership('Dinner [not a tag]'), { text: 'Dinner [not a tag]', ownerTag: null, externalId: null });
  assert.deepEqual(parseOwnership('[tf:x] in the middle'), { text: '[tf:x] in the middle', ownerTag: null, externalId: null });
  assert.deepEqual(parseOwnership(undefined), { text: '', ownerTag: null, externalId: null });
  const row = normalizeExpense(fixtureExpense(7, 'Dinner [tf:a1]'), 2);
  assert.deepEqual(row, {
    id: 7, index: 2, amount: 10, currency: 'USD', category: 'food', description: 'Dinner', raw_description: 'Dinner [tf:a1]',
    date: '2026-01-02', created_date: '2026-01-01', paid_by: ALICE, split_with: [ALICE, BOB], block_id: null,
    owner_tag: 'tf', external_id: 'a1', owned: true,
  });
  assert.equal(normalizeExpense(fixtureExpense(7, 'Dinner [other:a1]'), 0).owned, false);
  assert.equal(normalizeExpense(fixtureExpense(7, 'Dinner [other:a1]'), 0, 'other').owned, true);
});

test('buildExpense produces the web client object shape', () => {
  assert.deepEqual(buildExpense({ id: 5, amount: 1.5, currencyCode: 'USD', category: 'lodging', description: 'x', date: '2026-01-01', associatedDate: '2026-01-02', paidBy: ALICE, splitIds: [ALICE, BOB] }), {
    id: 5,
    amount: { amount: 1.5, currencyCode: 'USD' },
    category: 'lodging',
    description: 'x',
    date: '2026-01-01',
    blockId: null,
    paidByUserId: ALICE,
    paidByUser: { type: 'registered', id: ALICE },
    splitWith: { type: 'individuals', users: [{ type: 'registered', id: ALICE }, { type: 'registered', id: BOB }] },
    associatedDate: '2026-01-02',
  });
});

test('list reports members, ownership and counts without writing', async t => {
  const trip = fixtureTrip([fixtureExpense(1, 'Mine [tf:a]'), fixtureExpense(2, 'Hand typed')]);
  const { opts, calls } = await harness(t, trip);
  const out = await listExpenses(opts, 'fixture');
  assert.deepEqual(out.contributors, [ALICE, BOB]);
  assert.deepEqual(out.editors, [ALICE]);
  assert.deepEqual(out.budget, { amount: 500, currencyCode: 'USD' });
  assert.equal(out.payments, 1);
  assert.equal(out.count, 2);
  assert.deepEqual(out.expenses.map(e => [e.id, e.index, e.external_id, e.owned]), [[1, 0, 'a', true], [2, 1, null, false]]);
  assert.equal(calls.post, 0);
  await assert.rejects(() => listExpenses(opts, 'fixture', { ownerTag: 'bad tag' }), UsageError);
});

test('list refuses a trip without a budget.expenses array', async t => {
  const trip = fixtureTrip();
  delete trip.tripPlan.itinerary.budget;
  const { opts } = await harness(t, trip);
  await assert.rejects(() => listExpenses(opts, 'fixture'), /budget\.expenses/);
});

test('add appends at the fresh array length, tags the description and verifies', async t => {
  const trip = fixtureTrip([fixtureExpense(1, 'Hand typed')]);
  const { opts, calls } = await harness(t, trip);
  const out = await addExpense(opts, 'fixture', baseAdd);
  assert.equal(calls.post, 1);
  assert.equal(calls.ops[0].length, 1);
  const op = calls.ops[0][0];
  assert.deepEqual(op.p, ['itinerary', 'budget', 'expenses', 1]);
  assert.deepEqual(Object.keys(op), ['p', 'li']);
  assert.deepEqual(Object.keys(op.li), ['id', 'amount', 'category', 'description', 'date', 'blockId', 'paidByUserId', 'paidByUser', 'splitWith', 'associatedDate']);
  assert.ok(Number.isInteger(op.li.id) && op.li.id > 0 && op.li.id < 1e9);
  assert.deepEqual(op.li.amount, { amount: 1.23, currencyCode: 'USD' });
  assert.equal(op.li.description, 'AI test expense [tf:ai-test-1]');
  assert.equal(op.li.associatedDate, '2026-02-03');
  assert.match(op.li.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(op.li.blockId, null);
  assert.deepEqual(op.li.paidByUser, { type: 'registered', id: ALICE });
  // Default split: every contributor, equal shares.
  assert.deepEqual(op.li.splitWith, { type: 'individuals', users: [{ type: 'registered', id: ALICE }, { type: 'registered', id: BOB }] });
  assert.equal(out.added, true);
  assert.equal(out.index, 1);
  assert.equal(out.external_id, 'ai-test-1');
  assert.equal(out.owned, true);
  assert.equal(out.description, 'AI test expense');
  assert.equal(trip.tripPlan.itinerary.budget.expenses.length, 2);
});

test('add is idempotent on the external id and never writes twice', async t => {
  const trip = fixtureTrip();
  const { opts, calls } = await harness(t, trip);
  await addExpense(opts, 'fixture', baseAdd);
  await assert.rejects(() => addExpense(opts, 'fixture', { ...baseAdd, amount: '9' }), err => err instanceof ConflictError && err.exitCode === 6 && /already exists/.test(err.message));
  assert.equal(calls.post, 1);
  // Same external id under another owner tag is a different owner's expense.
  await addExpense(opts, 'fixture', { ...baseAdd, ownerTag: 'other' });
  assert.equal(calls.post, 2);
  assert.equal(trip.tripPlan.itinerary.budget.expenses[1].description, 'AI test expense [other:ai-test-1]');
});

test('add validates category, currency, amount, date, description and members before any write', async t => {
  const trip = fixtureTrip();
  const { opts, calls } = await harness(t, trip);
  const bad = [
    [{ category: 'transit' }, /--category must be one of/],
    [{ category: 'Food' }, /--category must be one of/],
    [{ category: undefined }, /--category must be one of/],
    [{ currency: 'US' }, /--currency must be a 3-letter/],
    [{ currency: 'XXQ' }, /not in Wanderlog's currency rate table/],
    [{ amount: '0' }, /--amount/],
    [{ amount: 'abc' }, /--amount/],
    [{ amount: undefined }, /--amount/],
    [{ date: '2026-02-30' }, /--date/],
    [{ date: '03/02/2026' }, /--date/],
    [{ description: '   ' }, /--description is required/],
    [{ description: 'sneaky [tf:other-id]' }, /must not end with an ownership tag/],
    [{ externalId: 'has space' }, /--external-id/],
    [{ ownerTag: 'a:b' }, /--owner-tag/],
    [{ paidBy: '4242' }, /--paid-by user 4242 is not a contributor or editor/],
    [{ paidBy: 'alice' }, /--paid-by must be a numeric/],
    [{ splitWith: `${ALICE},4242` }, /--split-with user 4242 is not a contributor or editor/],
    [{ splitWith: `${ALICE},${ALICE}` }, /must not repeat/],
    [{ splitWith: ',' }, /at least one user id/],
  ];
  for (const [override, pattern] of bad) {
    await assert.rejects(() => addExpense(opts, 'fixture', { ...baseAdd, ...override }), err => err instanceof UsageError && err.exitCode === 2 && pattern.test(err.message), JSON.stringify(override));
  }
  assert.equal(calls.post, 0);
  await addExpense(opts, 'fixture', { ...baseAdd, splitWith: String(BOB), currency: 'KRW' });
  assert.deepEqual(trip.tripPlan.itinerary.budget.expenses[0].splitWith.users, [{ type: 'registered', id: BOB }]);
  assert.equal(trip.tripPlan.itinerary.budget.expenses[0].amount.currencyCode, 'KRW');
});

test('add defaults the payer to the logged-in user and supports dry-run', async t => {
  const trip = fixtureTrip();
  const { opts, calls } = await harness(t, trip);
  const dry = await addExpense(opts, 'fixture', { ...baseAdd, paidBy: undefined, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.ops[0].li.paidByUserId, ALICE);
  assert.equal(calls.post, 0);
  assert.equal(trip.tripPlan.itinerary.budget.expenses.length, 0);
});

test('add verification fails when the write is dropped, altered, or disturbs other data', async t => {
  const dropped = await harness(t, fixtureTrip(), { dropWrite: true });
  await assert.rejects(() => addExpense(dropped.opts, 'fixture', baseAdd), err => err instanceof VerificationError && err.exitCode === 7 && /absent/.test(err.message));
  assert.equal(dropped.calls.post, 1, 'never retried');

  const altered = await harness(t, fixtureTrip(), { mutateInsert: e => ({ ...e, category: 'other' }) });
  await assert.rejects(() => addExpense(altered.opts, 'fixture', baseAdd), /present with different fields/);

  const lostOther = await harness(t, fixtureTrip([fixtureExpense(1, 'Hand typed')]), { afterWrite: trip => trip.tripPlan.itinerary.budget.expenses.shift() });
  await assert.rejects(() => addExpense(lostOther.opts, 'fixture', baseAdd), err => err instanceof VerificationError && /other expenses changed/.test(err.message));

  const payments = await harness(t, fixtureTrip(), { afterWrite: trip => trip.tripPlan.itinerary.budget.payments.pop() });
  await assert.rejects(() => addExpense(payments.opts, 'fixture', baseAdd), /payments array changed/);
});

test('uncertain and rejected writes are reported distinctly and never retried', async t => {
  const fiveHundred = await harness(t, fixtureTrip(), { postResponse: () => new Response('boom', { status: 502 }) });
  await assert.rejects(() => addExpense(fiveHundred.opts, 'fixture', baseAdd), err => err instanceof VerificationError && /uncertain/.test(err.message));
  assert.equal(fiveHundred.calls.post, 1);

  const network = await harness(t, fixtureTrip(), { postResponse: () => { throw new Error('socket hang up'); } });
  await assert.rejects(() => addExpense(network.opts, 'fixture', baseAdd), err => err instanceof VerificationError && /uncertain/.test(err.message));
  assert.equal(network.calls.post, 1);

  const rejected = await harness(t, fixtureTrip(), { postResponse: () => Response.json({ error: 'bad op' }, { status: 400 }) });
  await assert.rejects(() => addExpense(rejected.opts, 'fixture', baseAdd), err => err.name === 'ApiError' && err.exitCode === 1 && /400/.test(err.message));
  assert.equal(rejected.calls.post, 1);

  const refused = await harness(t, fixtureTrip(), { postResponse: () => Response.json({ success: false, error: 'nope' }) });
  await assert.rejects(() => addExpense(refused.opts, 'fixture', baseAdd), err => err.name === 'ApiError' && /rejected/.test(err.message));
});

test('update replaces the exact old object at its fresh index and keeps the tag', async t => {
  const first = fixtureExpense(1, 'Hand typed');
  const mine = fixtureExpense(2, 'Dinner [tf:a1]');
  const trip = fixtureTrip([first, mine]);
  const { opts, calls } = await harness(t, trip);
  const out = await updateExpense(opts, 'fixture', { id: '2', expectExternalId: 'a1', amount: '2.34', description: 'Dinner edited', category: 'drinks', date: '2026-03-04', splitWith: String(ALICE), paidBy: String(BOB) });
  const op = calls.ops[0][0];
  assert.equal(calls.ops[0].length, 1);
  assert.deepEqual(op.p, ['itinerary', 'budget', 'expenses', 1]);
  assert.deepEqual(op.ld, fixtureExpense(2, 'Dinner [tf:a1]'));
  assert.deepEqual(op.li, fixtureExpense(2, 'Dinner edited [tf:a1]', {
    amount: { amount: 2.34, currencyCode: 'USD' }, category: 'drinks', associatedDate: '2026-03-04',
    paidByUserId: BOB, paidByUser: { type: 'registered', id: BOB },
    splitWith: { type: 'individuals', users: [{ type: 'registered', id: ALICE }] },
  }));
  assert.equal(op.li.date, '2026-01-01', 'creation date is not rewritten');
  assert.equal(out.updated, true);
  assert.equal(out.external_id, 'a1');
  assert.equal(out.description, 'Dinner edited');
  assert.deepEqual(trip.tripPlan.itinerary.budget.expenses[0], first);
});

test('update with no effective change writes nothing', async t => {
  const trip = fixtureTrip([fixtureExpense(2, 'Dinner [tf:a1]')]);
  const { opts, calls } = await harness(t, trip);
  const out = await updateExpense(opts, 'fixture', { id: 2, expectExternalId: 'a1', amount: '10', category: 'food' });
  assert.equal(out.unchanged, true);
  assert.equal(out.updated, false);
  assert.equal(calls.post, 0);
  await assert.rejects(() => updateExpense(opts, 'fixture', { id: 2, expectExternalId: 'a1' }), /No fields to change/);
  await assert.rejects(() => updateExpense(opts, 'fixture', { id: 2, expectExternalId: 'a1', category: 'transit' }), /--category/);
  await assert.rejects(() => updateExpense(opts, 'fixture', { id: 2, expectExternalId: 'a1', paidBy: '4242' }), /not a contributor or editor/);
  assert.equal(calls.post, 0);
});

test('update and remove guards: id, tag, exact description, ownership', async t => {
  const trip = fixtureTrip([fixtureExpense(1, 'Hand typed'), fixtureExpense(2, 'Dinner [tf:a1]'), fixtureExpense(3, 'Theirs [other:z9]')]);
  const { opts, calls } = await harness(t, trip);
  const guard = pattern => err => err instanceof ConfirmRequiredError && err.exitCode === 5 && pattern.test(err.message);
  for (const fn of [updateExpense, removeExpense]) {
    const extra = fn === updateExpense ? { amount: '5' } : {};
    await assert.rejects(() => fn(opts, 'fixture', { ...extra }), UsageError);
    await assert.rejects(() => fn(opts, 'fixture', { id: 99, expectExternalId: 'a1', ...extra }), err => err instanceof NotFoundError && err.exitCode === 4);
    await assert.rejects(() => fn(opts, 'fixture', { id: 2, ...extra }), guard(/A guard is required/));
    await assert.rejects(() => fn(opts, 'fixture', { id: 2, expectExternalId: 'a2', ...extra }), guard(/does not carry the tag \[tf:a2\]/));
    await assert.rejects(() => fn(opts, 'fixture', { id: 2, expectDescription: 'Dinner', ...extra }), guard(/does not match --expect-description exactly/));
    // Untagged or foreign-tagged expenses need --force-unowned even with a matching description guard.
    await assert.rejects(() => fn(opts, 'fixture', { id: 1, expectDescription: 'Hand typed', ...extra }), guard(/--force-unowned/));
    await assert.rejects(() => fn(opts, 'fixture', { id: 3, expectDescription: 'Theirs [other:z9]', ...extra }), guard(/--force-unowned/));
    await assert.rejects(() => fn(opts, 'fixture', { id: 3, expectExternalId: 'z9', ...extra }), guard(/does not carry the tag \[tf:z9\]/));
    // --force-unowned never replaces the guard itself.
    await assert.rejects(() => fn(opts, 'fixture', { id: 1, forceUnowned: true, ...extra }), guard(/A guard is required/));
  }
  assert.equal(calls.post, 0);
  await updateExpense(opts, 'fixture', { id: 1, expectDescription: 'Hand typed', forceUnowned: true, amount: '5' });
  assert.equal(trip.tripPlan.itinerary.budget.expenses[0].amount.amount, 5);
  assert.equal(trip.tripPlan.itinerary.budget.expenses[0].description, 'Hand typed');
  await removeExpense(opts, 'fixture', { id: 3, expectExternalId: 'z9', ownerTag: 'other' });
  assert.deepEqual(trip.tripPlan.itinerary.budget.expenses.map(e => e.id), [1, 2]);
});

test('duplicate expense ids are refused', async t => {
  const trip = fixtureTrip([fixtureExpense(2, 'Dinner [tf:a1]'), fixtureExpense(2, 'Dinner [tf:a1]')]);
  const { opts, calls } = await harness(t, trip);
  await assert.rejects(() => removeExpense(opts, 'fixture', { id: 2, expectExternalId: 'a1' }), /not unique/);
  assert.equal(calls.post, 0);
});

test('remove deletes the exact old object at its fresh index and verifies', async t => {
  const trip = fixtureTrip([fixtureExpense(1, 'Hand typed'), fixtureExpense(2, 'Dinner [tf:a1]'), fixtureExpense(3, 'Lunch [tf:a2]')]);
  const { opts, calls } = await harness(t, trip);
  const dry = await removeExpense(opts, 'fixture', { id: 2, expectExternalId: 'a1', dryRun: true });
  assert.deepEqual(dry.ops, [{ p: ['itinerary', 'budget', 'expenses', 1], ld: fixtureExpense(2, 'Dinner [tf:a1]') }]);
  assert.equal(calls.post, 0);
  const out = await removeExpense(opts, 'fixture', { id: 2, expectExternalId: 'a1' });
  assert.deepEqual(calls.ops[0], dry.ops);
  assert.equal(out.removed, true);
  assert.equal(out.id, 2);
  assert.deepEqual(trip.tripPlan.itinerary.budget.expenses.map(e => e.id), [1, 3]);
  // The index is recomputed from fresh state on the next call.
  await removeExpense(opts, 'fixture', { id: 3, expectDescription: 'Lunch [tf:a2]' });
  assert.deepEqual(calls.ops[1][0].p, ['itinerary', 'budget', 'expenses', 1]);
});

test('update and remove verification failures', async t => {
  const make = () => fixtureTrip([fixtureExpense(1, 'Hand typed'), fixtureExpense(2, 'Dinner [tf:a1]')]);
  const stuck = await harness(t, make(), { dropWrite: true });
  await assert.rejects(() => removeExpense(stuck.opts, 'fixture', { id: 2, expectExternalId: 'a1' }), err => err instanceof VerificationError && /still present/.test(err.message));
  await assert.rejects(() => updateExpense(stuck.opts, 'fixture', { id: 2, expectExternalId: 'a1', amount: '3' }), err => err instanceof VerificationError && /does not match the requested fields/.test(err.message));
  assert.equal(stuck.calls.post, 2);

  const collateral = await harness(t, make(), { afterWrite: trip => trip.tripPlan.itinerary.budget.expenses.shift() });
  await assert.rejects(() => removeExpense(collateral.opts, 'fixture', { id: 2, expectExternalId: 'a1' }), /other expenses changed/);

  const vanished = await harness(t, make(), { afterWrite: trip => trip.tripPlan.itinerary.budget.expenses.pop() });
  await assert.rejects(() => updateExpense(vanished.opts, 'fixture', { id: 2, expectExternalId: 'a1', amount: '3' }), /absent/);
});

test('CLI flags route through the dispatcher', async t => {
  const trip = fixtureTrip();
  const { opts } = await harness(t, trip);
  const run = argv => {
    const parsed = parseArgs(argv);
    return createCommandDispatcher({ ...parsed.options, ...opts }).execute(parsed.command, parsed.subcommand, parsed.args);
  };
  const added = await run(['budget', 'add', 'fixture', '--amount', '1.23', '--currency', 'USD', '--category', 'publicTransit', '--description', 'AI test expense', '--date', '2026-02-03', '--paid-by', String(ALICE), '--split-with', `${ALICE},${BOB}`, '--external-id', 'ai-test-1', '--owner-tag', 'tf']);
  assert.equal(added.data.category, 'publicTransit');
  const id = String(added.data.id);
  const updated = await run(['budget', 'update', 'fixture', '--id', id, '--expect-external-id', 'ai-test-1', '--amount', '2.34']);
  assert.equal(updated.data.amount, 2.34);
  const listed = await run(['budget', 'list', 'fixture', '--json']);
  assert.deepEqual(listed.data.expenses.map(e => [e.external_id, e.owned, e.amount]), [['ai-test-1', true, 2.34]]);
  await assert.rejects(() => run(['budget', 'remove', 'fixture', '--id', id]), ConfirmRequiredError);
  const removed = await run(['budget', 'remove', 'fixture', '--id', id, '--expect-description', 'AI test expense [tf:ai-test-1]']);
  assert.equal(removed.data.removed, true);
  assert.equal(trip.tripPlan.itinerary.budget.expenses.length, 0);
  await assert.rejects(() => run(['budget', 'nonsense', 'fixture']), err => err instanceof UsageError && /wlog budget/.test(err.message));
  assert.match((await createCommandDispatcher({ help: true }).execute('budget', null, [])).data, /publicTransit/);
});
