import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { balanceOf, entryByName, expectApiError, seed, startEnv, tempDbFile, type TestEnv } from './helpers.js';

const CANCEL_MS = 5_000;
const APPROVAL_MS = 5 * 60_000;

describe('five-second donation cancellation', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  afterEach(() => env.close());

  test('confirming reserves the assets and starts a server-side 5 s window', async () => {
    const st = await s.a.state();
    const d = await s.a.donate(s.lannister.id, [
      { type: 'item', entryId: entryByName(st, 'Brick')!.id, quantity: 2 },
      { type: 'currency', currencyId: s.gold.id, amount: '10.25' },
    ]);
    assert.equal(d.status, 'countdown');
    assert.equal(d.cancelDeadline - d.createdAt, CANCEL_MS);
    assert.match(d.id, /^DN-[0-9A-F]{12}$/);
    const after = await s.a.state();
    const brick = entryByName(after, 'Brick')!;
    assert.equal(brick.quantity, 5, 'reserved assets remain owned by the sender');
    assert.equal(brick.reserved, 2);
    assert.equal(brick.available, 3);
    assert.equal(balanceOf(after, s.gold.id).reserved, '10.25');
    assert.equal(balanceOf(after, s.gold.id).available, '90.25');
    assert.equal(after.outgoing.length, 1);
    // The recipient does not see a donation still in its cancellation window.
    assert.equal((await s.c.state()).incoming.length, 0);
  });

  test('cancelling before the deadline releases every reservation', async () => {
    const st = await s.a.state();
    const d = await s.a.donate(s.lannister.id, [{ type: 'item', entryId: entryByName(st, 'Brick')!.id, quantity: 5 }]);
    env.clock.advance(CANCEL_MS - 1);
    const cancelled = (await s.a.post(`/api/donations/${d.id}/cancel`)).donation;
    assert.equal(cancelled.status, 'cancelled');
    const brick = entryByName(await s.a.state(), 'Brick')!;
    assert.equal(brick.reserved, 0);
    assert.equal(brick.available, 5);
    env.app.tick();
    assert.equal(entryByName(await s.c.state(), 'Brick'), undefined, 'nothing was transferred');
  });

  test('another player of the sending role can cancel (shared role)', async () => {
    const st = await s.a.state();
    const d = await s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '1' }]);
    const r = (await s.b.post(`/api/donations/${d.id}/cancel`)).donation;
    assert.equal(r.status, 'cancelled');
    assert.ok(st);
  });

  test('cancellation is refused once the server deadline has passed, even before the sweep runs', async () => {
    const st = await s.a.state();
    const d = await s.a.donate(s.lannister.id, [{ type: 'item', entryId: entryByName(st, 'Sword')!.id, quantity: 1 }]);
    env.clock.advance(CANCEL_MS);
    await expectApiError(s.a.post(`/api/donations/${d.id}/cancel`), 409, /window has closed/);
  });

  test('the recipient cannot cancel a donation', async () => {
    const d = await s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '1' }]);
    await expectApiError(s.c.post(`/api/donations/${d.id}/cancel`), 403);
  });

  test('a donation cannot be cancelled twice', async () => {
    const d = await s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '1' }]);
    await s.a.post(`/api/donations/${d.id}/cancel`);
    await expectApiError(s.b.post(`/api/donations/${d.id}/cancel`), 409);
  });
});

describe('automatic donation completion (approval disabled, the default)', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('approval is disabled by default', async () => {
    assert.equal((await env.gm.get('/api/gm/settings')).approvalRequired, false);
  });

  test('the donation does not complete before the deadline', async () => {
    const st = await s.a.state();
    const d = await s.a.donate(s.lannister.id, [
      { type: 'item', entryId: entryByName(st, 'Brick')!.id, quantity: 2 },
      { type: 'item', entryId: entryByName(st, 'Deed: Winterfell')!.id, quantity: 1 },
      { type: 'currency', currencyId: s.gold.id, amount: '0.50' },
    ]);
    env.clock.advance(CANCEL_MS - 1);
    env.app.tick();
    assert.equal((await s.a.get(`/api/donations/${d.id}`)).donation.status, 'countdown');

    env.clock.advance(1);
    env.app.tick();
    const done = (await s.a.get(`/api/donations/${d.id}`)).donation;
    assert.equal(done.status, 'completed');

    const sender = await s.a.state();
    const recipient = await s.c.state();
    assert.equal(entryByName(sender, 'Brick')!.quantity, 3);
    assert.equal(entryByName(sender, 'Brick')!.reserved, 0);
    assert.equal(entryByName(sender, 'Deed: Winterfell'), undefined);
    assert.equal(balanceOf(sender, s.gold.id).amount, '100.00');
    assert.equal(entryByName(recipient, 'Brick')!.quantity, 2);
    assert.ok(entryByName(recipient, 'Deed: Winterfell'));
    assert.equal(balanceOf(recipient, s.gold.id).amount, '0.50');
  });

  test('every step is recorded in the GM audit log under the acting player', async () => {
    const audit = await env.gm.get('/api/gm/audit?category=donation');
    const actions = audit.events.map((e: any) => e.action);
    assert.ok(actions.includes('donation.created'));
    assert.ok(actions.includes('donation.completed'));
    const created = audit.events.find((e: any) => e.action === 'donation.created');
    assert.equal(created.actorUsername, 'alice');
    assert.equal(created.assets.length, 3);
  });
});

describe('unique item transfers', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('a donated unique item keeps its instance id and custom name', async () => {
    const deed = entryByName(await s.a.state(), 'Deed: Winterfell')!;
    await s.a.donate(s.lannister.id, [{ type: 'item', entryId: deed.id, quantity: 1 }]);
    env.clock.advance(CANCEL_MS);
    env.app.tick();
    const received = entryByName(await s.c.state(), 'Deed: Winterfell')!;
    assert.equal(received.id, deed.id);
    assert.equal(received.kind, 'unique');
    assert.equal(entryByName(await s.a.state(), 'Deed: Winterfell'), undefined);
  });

  test('a unique item quantity must be exactly 1', async () => {
    const sword = entryByName(await s.a.state(), 'Sword')!;
    await expectApiError(s.a.donate(s.lannister.id, [{ type: 'item', entryId: sword.id, quantity: 2 }]), 400, /unique/);
  });

  test('a reserved unique item cannot join a second donation', async () => {
    const sword = entryByName(await s.a.state(), 'Sword')!;
    await s.a.donate(s.lannister.id, [{ type: 'item', entryId: sword.id, quantity: 1 }]);
    await expectApiError(s.b.donate(s.lannister.id, [{ type: 'item', entryId: sword.id, quantity: 1 }]), 409, /reserved/);
  });

  test('a role cannot donate to itself, and cannot give what it does not own', async () => {
    const brick = entryByName(await s.a.state(), 'Brick')!;
    await expectApiError(s.a.donate(s.stark.id, [{ type: 'item', entryId: brick.id, quantity: 1 }]), 400, /itself/);
    await expectApiError(s.a.donate(s.lannister.id, [{ type: 'item', entryId: brick.id, quantity: 6 }]), 409, /only have/);
    const deed = entryByName(await s.c.state(), 'Deed: Winterfell')!;
    await expectApiError(s.a.donate(s.lannister.id, [{ type: 'item', entryId: deed.id, quantity: 1 }]), 409, /no longer in your inventory/);
  });
});

describe('currency donations', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('players cannot donate more than the available balance', async () => {
    await expectApiError(s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '100.51' }]), 409, /only have 100.50/);
    await expectApiError(s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '0' }]), 400);
    await expectApiError(s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '-5' }]), 400);
    await expectApiError(s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '1.005' }]), 400);
  });

  test('exact decimal transfers', async () => {
    await s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '0.1' }]);
    await s.b.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '0.2' }]);
    env.clock.advance(CANCEL_MS);
    env.app.tick();
    assert.equal(balanceOf(await s.c.state(), s.gold.id).amount, '0.30');
    assert.equal(balanceOf(await s.a.state(), s.gold.id).amount, '100.20');
  });

  test('the full balance can be donated, never below zero', async () => {
    await s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '100.20' }]);
    await expectApiError(s.b.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '0.01' }]), 409);
    env.clock.advance(CANCEL_MS);
    env.app.tick();
    assert.equal(balanceOf(await s.a.state(), s.gold.id).amount, '0.00');
  });
});

describe('recipient approval', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    env = await startEnv();
    s = await seed(env);
    await env.gm.put('/api/gm/settings', { approvalRequired: true });
    // A second player for the recipient role, to test double resolution.
    await env.gm.post('/api/gm/players', { username: 'jaime', password: 'password1', roleId: s.lannister.id });
  });
  afterEach(() => env.close());

  async function sendBricks(n = 2) {
    const brick = entryByName(await s.a.state(), 'Brick')!;
    const d = await s.a.donate(s.lannister.id, [{ type: 'item', entryId: brick.id, quantity: n }]);
    env.clock.advance(CANCEL_MS);
    env.app.tick();
    return d;
  }

  test('after the cancellation window the donation becomes pending with a 5-minute deadline', async () => {
    const d = await sendBricks();
    const inbox = (await s.c.state()).incoming;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].id, d.id);
    assert.equal(inbox[0].status, 'pending');
    assert.equal(inbox[0].approvalDeadline, d.cancelDeadline + APPROVAL_MS);
    // Still reserved, still owned by the sender.
    const brick = entryByName(await s.a.state(), 'Brick')!;
    assert.equal(brick.quantity, 5);
    assert.equal(brick.reserved, 2);
    // The sender can no longer cancel.
    await expectApiError(s.a.post(`/api/donations/${d.id}/cancel`), 409);
  });

  test('acceptance by a recipient player completes the transfer', async () => {
    const d = await sendBricks();
    env.clock.advance(APPROVAL_MS - 1);
    const r = (await s.c.post(`/api/donations/${d.id}/accept`)).donation;
    assert.equal(r.status, 'completed');
    assert.equal(r.resolvedByUsername, 'cersei');
    assert.equal(entryByName(await s.c.state(), 'Brick')!.quantity, 2);
    assert.equal(entryByName(await s.a.state(), 'Brick')!.quantity, 3);
  });

  test('rejection releases all reserved assets to the sender', async () => {
    const d = await sendBricks();
    const r = (await s.c.post(`/api/donations/${d.id}/reject`)).donation;
    assert.equal(r.status, 'rejected');
    const brick = entryByName(await s.a.state(), 'Brick')!;
    assert.equal(brick.quantity, 5);
    assert.equal(brick.reserved, 0);
    assert.equal(entryByName(await s.c.state(), 'Brick'), undefined);
  });

  test('two recipient players cannot resolve the same donation twice', async () => {
    const d = await sendBricks();
    const jaime = await env.as('jaime');
    const results = await Promise.allSettled([s.c.post(`/api/donations/${d.id}/accept`), jaime.post(`/api/donations/${d.id}/accept`), jaime.post(`/api/donations/${d.id}/reject`)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(entryByName(await s.c.state(), 'Brick')!.quantity, 2, 'transferred exactly once');
    assert.equal(entryByName(await s.a.state(), 'Brick')!.quantity, 3);
  });

  test('only players of the recipient role may accept or reject', async () => {
    const d = await sendBricks();
    await expectApiError(s.b.post(`/api/donations/${d.id}/accept`), 403);
    await expectApiError(s.a.post(`/api/donations/${d.id}/reject`), 403);
  });

  test('no response within five minutes rejects automatically and returns the assets', async () => {
    const d = await sendBricks();
    env.clock.advance(APPROVAL_MS - 1);
    env.app.tick();
    assert.equal((await s.a.get(`/api/donations/${d.id}`)).donation.status, 'pending');
    env.clock.advance(1);
    env.app.tick();
    const r = (await s.a.get(`/api/donations/${d.id}`)).donation;
    assert.equal(r.status, 'rejected');
    assert.match(r.resolutionNote, /expired/);
    assert.equal(entryByName(await s.a.state(), 'Brick')!.reserved, 0);
    const audit = await env.gm.get(`/api/gm/audit?donationId=${d.id}`);
    assert.ok(audit.events.some((e: any) => e.action === 'donation.expired'));
  });

  test('an approval arriving after the deadline cannot complete the transfer', async () => {
    const d = await sendBricks();
    env.clock.advance(APPROVAL_MS); // deadline reached; sweep has NOT run yet
    await expectApiError(s.c.post(`/api/donations/${d.id}/accept`), 409, /approval window has closed/);
    assert.equal((await s.a.get(`/api/donations/${d.id}`)).donation.status, 'rejected');
    assert.equal(entryByName(await s.c.state(), 'Brick'), undefined);
    assert.equal(entryByName(await s.a.state(), 'Brick')!.available, 5);
  });

  test('disabling approval later does not affect donations already pending', async () => {
    const d = await sendBricks();
    await env.gm.put('/api/gm/settings', { approvalRequired: false });
    env.app.tick();
    assert.equal((await s.a.get(`/api/donations/${d.id}`)).donation.status, 'pending');
  });
});

describe('concurrent donation attempts', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('two players racing for the same unique item: exactly one succeeds', async () => {
    const sword = entryByName(await s.a.state(), 'Sword')!;
    const attempts = [s.a, s.b, s.a, s.b, s.a, s.b].map((c) => c.donate(s.lannister.id, [{ type: 'item', entryId: sword.id, quantity: 1 }]));
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  });

  test('ten parallel requests for one brick each against a stack of five: exactly five succeed', async () => {
    const brick = entryByName(await s.a.state(), 'Brick')!;
    const attempts = Array.from({ length: 10 }, (_, i) => (i % 2 ? s.a : s.b).donate(s.lannister.id, [{ type: 'item', entryId: brick.id, quantity: 1 }]));
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
    env.clock.advance(CANCEL_MS);
    env.app.tick();
    assert.equal(entryByName(await s.a.state(), 'Brick'), undefined);
    assert.equal(entryByName(await s.c.state(), 'Brick')!.quantity, 5);
  });

  test('parallel currency donations never overdraw the balance', async () => {
    const attempts = Array.from({ length: 12 }, (_, i) => (i % 2 ? s.a : s.b).donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '10' }]));
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 10);
    env.clock.advance(CANCEL_MS);
    env.app.tick();
    assert.equal(balanceOf(await s.a.state(), s.gold.id).amount, '0.50');
    assert.equal(balanceOf(await s.c.state(), s.gold.id).amount, '100.00');
  });

  test('a repeated request id (double click, retry) creates only one donation', async () => {
    await env.gm.post(`/api/gm/roles/${s.stark.id}/currencies/${s.gold.id}`, { op: 'set', amount: '50' });
    const [x, y] = await Promise.all([
      s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '20' }], 'req-123'),
      s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '20' }], 'req-123'),
    ]);
    assert.equal(x.id, y.id);
    assert.equal(balanceOf(await s.a.state(), s.gold.id).reserved, '20.00');
  });
});

describe('multi-item donation atomicity', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  afterEach(() => env.close());

  test('one invalid line rejects the whole donation and reserves nothing', async () => {
    const st = await s.a.state();
    await expectApiError(
      s.a.donate(s.lannister.id, [
        { type: 'item', entryId: entryByName(st, 'Brick')!.id, quantity: 2 },
        { type: 'item', entryId: entryByName(st, 'Sword')!.id, quantity: 1 },
        { type: 'currency', currencyId: s.gold.id, amount: '5000' },
      ]),
      409,
    );
    const after = await s.a.state();
    assert.ok(after.inventory!.entries.every((e) => e.reserved === 0));
    assert.equal(balanceOf(after, s.gold.id).reserved, '0.00');
    assert.equal(after.outgoing.length, 0);
  });

  test('if completion fails for any line, nothing moves and everything is released', async () => {
    // Recipient is close to the Gold maximum (1000); fill it up after the donation is reserved.
    const st = await s.a.state();
    const d = await s.a.donate(s.lannister.id, [
      { type: 'item', entryId: entryByName(st, 'Brick')!.id, quantity: 3 },
      { type: 'item', entryId: entryByName(st, 'Sword')!.id, quantity: 1 },
      { type: 'currency', currencyId: s.gold.id, amount: '50' },
    ]);
    await env.gm.post(`/api/gm/roles/${s.lannister.id}/currencies/${s.gold.id}`, { op: 'set', amount: '990' });
    env.clock.advance(CANCEL_MS);
    env.app.tick();
    const r = (await s.a.get(`/api/donations/${d.id}`)).donation;
    assert.equal(r.status, 'failed');
    const sender = await s.a.state();
    const recipient = await s.c.state();
    assert.equal(entryByName(sender, 'Brick')!.quantity, 5);
    assert.equal(entryByName(sender, 'Brick')!.reserved, 0);
    assert.ok(entryByName(sender, 'Sword'));
    assert.equal(balanceOf(sender, s.gold.id).amount, '100.50');
    assert.equal(entryByName(recipient, 'Brick'), undefined);
    assert.equal(entryByName(recipient, 'Sword'), undefined);
    assert.equal(balanceOf(recipient, s.gold.id).amount, '990.00');
  });

  test('GM cannot remove or reduce assets that are reserved by a donation', async () => {
    const st = await s.a.state();
    const brick = entryByName(st, 'Brick')!;
    const sword = entryByName(st, 'Sword')!;
    await s.a.donate(s.lannister.id, [
      { type: 'item', entryId: brick.id, quantity: 4 },
      { type: 'item', entryId: sword.id, quantity: 1 },
      { type: 'currency', currencyId: s.gold.id, amount: '100' },
    ]);
    await expectApiError(env.gm.patch(`/api/gm/entries/${brick.id}`, { quantity: 3 }), 409, /reserved/);
    await expectApiError(env.gm.del(`/api/gm/entries/${sword.id}`), 409, /reserved/);
    await expectApiError(env.gm.post(`/api/gm/entries/${sword.id}/move`, { toRoleId: s.lannister.id }), 409);
    await expectApiError(env.gm.post(`/api/gm/roles/${s.stark.id}/currencies/${s.gold.id}`, { op: 'set', amount: '50' }), 409, /reserved/);
    await env.gm.patch(`/api/gm/entries/${brick.id}`, { quantity: 4 }); // down to the reserved amount is fine
  });
});

describe('server restart during pending donations', () => {
  test('a countdown that expired while the server was down completes on startup', async () => {
    const dbFile = tempDbFile();
    let env = await startEnv({ dbFile });
    let s = await seed(env);
    const brick = entryByName(await s.a.state(), 'Brick')!;
    const d = await s.a.donate(s.lannister.id, [{ type: 'item', entryId: brick.id, quantity: 2 }]);
    await env.close();
    env.clock.advance(60_000);
    env = await startEnv({ dbFile, clock: env.clock }); // createApp runs the sweep immediately
    const a = await env.as('alice');
    const c = await env.as('cersei');
    assert.equal((await a.get(`/api/donations/${d.id}`)).donation.status, 'completed');
    assert.equal(entryByName(await c.state(), 'Brick')!.quantity, 2);
    assert.equal(entryByName(await a.state(), 'Brick')!.quantity, 3);
    await env.close();
    void s;
  });

  test('a countdown still running after restart can be cancelled; reservations survived', async () => {
    const dbFile = tempDbFile();
    let env = await startEnv({ dbFile });
    const s = await seed(env);
    const d = await s.a.donate(s.lannister.id, [{ type: 'currency', currencyId: s.gold.id, amount: '40' }]);
    await env.restart();
    env.clock.advance(2_000);
    const a = await env.as('alice');
    assert.equal(balanceOf(await a.state(), s.gold.id).reserved, '40.00');
    assert.equal((await a.post(`/api/donations/${d.id}/cancel`)).donation.status, 'cancelled');
    assert.equal(balanceOf(await a.state(), s.gold.id).available, '100.50');
    await env.close();
  });

  test('pending approvals keep their deadline across restarts and expire on time', async () => {
    const dbFile = tempDbFile();
    let env = await startEnv({ dbFile });
    const s = await seed(env);
    await env.gm.put('/api/gm/settings', { approvalRequired: true });
    const sword = entryByName(await s.a.state(), 'Sword')!;
    const d1 = await s.a.donate(s.lannister.id, [{ type: 'item', entryId: sword.id, quantity: 1 }]);
    const brick = entryByName(await s.a.state(), 'Brick')!;
    const d2 = await s.a.donate(s.lannister.id, [{ type: 'item', entryId: brick.id, quantity: 1 }]);
    env.clock.advance(CANCEL_MS);
    env.app.tick();

    // Restart within the approval window: still pending and acceptable.
    await env.restart();
    env.clock.advance(60_000);
    let c = await env.as('cersei');
    assert.equal((await c.state()).incoming.length, 2);
    assert.equal((await c.post(`/api/donations/${d1.id}/accept`)).donation.status, 'completed');

    // Server down past the approval deadline: the other donation is rejected at startup.
    await env.close();
    env.clock.advance(APPROVAL_MS);
    env = await startEnv({ dbFile, clock: env.clock });
    c = await env.as('cersei');
    const a = await env.as('alice');
    assert.equal((await a.get(`/api/donations/${d2.id}`)).donation.status, 'rejected');
    assert.equal(entryByName(await a.state(), 'Brick')!.available, 5);
    assert.ok(entryByName(await c.state(), 'Sword'));
    await env.close();
  });

  test('all inventory state survives a restart', async () => {
    const dbFile = tempDbFile();
    let env = await startEnv({ dbFile });
    const s = await seed(env);
    const before = await s.a.state();
    await env.restart();
    const a = await env.as('alice');
    const after = await a.state();
    assert.deepEqual(after.inventory, before.inventory);
    await env.close();
  });
});
