import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { balanceOf, entryByName, expectApiError, seed, startEnv, type TestEnv } from './helpers.js';

describe('item stacking and unique items', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('identical stackable definitions combine into one stack with a quantity', async () => {
    await env.gm.post(`/api/gm/roles/${s.stark.id}/items`, { itemDefId: s.brick.id, quantity: 3 });
    const bricks = (await s.a.state()).inventory!.entries.filter((e) => e.itemDefId === s.brick.id);
    assert.equal(bricks.length, 1);
    assert.equal(bricks[0].quantity, 8);
    assert.equal(bricks[0].kind, 'stack');
  });

  test('unique items never stack: each has its own instance id', async () => {
    await env.gm.post(`/api/gm/roles/${s.stark.id}/items`, { itemDefId: s.sword.id, quantity: 2 });
    const swords = (await s.a.state()).inventory!.entries.filter((e) => e.itemDefId === s.sword.id);
    assert.equal(swords.length, 3);
    assert.ok(swords.every((e) => e.quantity === 1 && e.kind === 'unique'));
    assert.equal(new Set(swords.map((e) => e.id)).size, 3);
  });

  test('the database refuses a second stack of the same definition', () => {
    const inv = env.app.ctx.db.get<{ id: string }>('SELECT id FROM inventories WHERE role_id = ?', s.stark.id)!.id;
    assert.throws(
      () =>
        env.app.ctx.db.run(
          "INSERT INTO inventory_entries (id, inventory_id, item_def_id, kind, quantity, acquired_at, position) VALUES ('dup', ?, ?, 'stack', 1, 0, 99)",
          inv,
          s.brick.id,
        ),
      /UNIQUE/,
    );
  });

  test('quantities must be positive integers', async () => {
    const brick = entryByName(await s.a.state(), 'Brick')!;
    await expectApiError(env.gm.patch(`/api/gm/entries/${brick.id}`, { quantity: -2 }), 400);
    await expectApiError(env.gm.patch(`/api/gm/entries/${brick.id}`, { quantity: 1.5 }), 400);
    await expectApiError(env.gm.post(`/api/gm/roles/${s.stark.id}/items`, { itemDefId: s.brick.id, quantity: 0 }), 400);
  });

  test('removing the final unit removes the stack from the inventory', async () => {
    const brick = entryByName(await s.a.state(), 'Brick')!;
    await env.gm.patch(`/api/gm/entries/${brick.id}`, { quantity: 0 });
    assert.equal(entryByName(await s.a.state(), 'Brick'), undefined);
  });

  test('GM can move a unique item between roles; its instance id is preserved', async () => {
    const deed = entryByName(await s.a.state(), 'Deed: Winterfell')!;
    await env.gm.post(`/api/gm/entries/${deed.id}/move`, { toRoleId: s.lannister.id });
    assert.equal(entryByName(await s.a.state(), 'Deed: Winterfell'), undefined);
    const moved = entryByName(await s.c.state(), 'Deed: Winterfell')!;
    assert.equal(moved.id, deed.id);
    assert.equal(moved.defName, 'Land deed');
  });
});

describe('currencies use exact decimal arithmetic', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('0.10 + 0.20 is exactly 0.30, with no floating-point drift', async () => {
    await env.gm.post(`/api/gm/roles/${s.lannister.id}/currencies/${s.gold.id}`, { op: 'set', amount: '0.10' });
    await env.gm.post(`/api/gm/roles/${s.lannister.id}/currencies/${s.gold.id}`, { op: 'add', amount: '0.20' });
    assert.equal(balanceOf(await s.c.state(), s.gold.id).amount, '0.30');
    for (let i = 0; i < 10; i++) await env.gm.post(`/api/gm/roles/${s.lannister.id}/currencies/${s.gold.id}`, { op: 'add', amount: '0.10' });
    assert.equal(balanceOf(await s.c.state(), s.gold.id).amount, '1.30');
  });

  test('amounts finer than the currency precision are rejected', async () => {
    await expectApiError(env.gm.post(`/api/gm/roles/${s.lannister.id}/currencies/${s.gold.id}`, { op: 'add', amount: '0.001' }), 400, /decimal/);
  });

  test('configured maximum is enforced and minimum defaults to zero', async () => {
    await expectApiError(env.gm.post(`/api/gm/roles/${s.lannister.id}/currencies/${s.gold.id}`, { op: 'set', amount: '1000.01' }), 409, /exceed/);
    await expectApiError(env.gm.post(`/api/gm/roles/${s.lannister.id}/currencies/${s.gold.id}`, { op: 'subtract', amount: '999' }), 409, /below/);
  });

  test('GM transfers move exact amounts between roles', async () => {
    await env.gm.post('/api/gm/currency-transfers', { fromRoleId: s.stark.id, toRoleId: s.lannister.id, currencyId: s.gold.id, amount: '0.50' });
    assert.equal(balanceOf(await s.a.state(), s.gold.id).amount, '100.00');
    assert.equal(balanceOf(await s.c.state(), s.gold.id).amount, '1.80');
  });

  test('players cannot edit balances directly (no such endpoint for them)', async () => {
    await expectApiError(s.a.post(`/api/gm/roles/${s.stark.id}/currencies/${s.gold.id}`, { op: 'set', amount: '999' }), 403);
  });

  test('balances are visible per role across the GM view', async () => {
    const { balances } = await env.gm.get(`/api/gm/currencies/${s.gold.id}/balances`);
    assert.deepEqual(
      balances.map((b: any) => [b.roleName, b.amount]),
      [
        ['House Lannister', '1.80'],
        ['House Stark', '100.00'],
      ],
    );
  });
});

describe('persistent custom sorting', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  const names = async (c = s.a) => (await c.state()).inventory!.entries.map((e) => e.name);

  test('new items are appended to the custom order', async () => {
    assert.deepEqual(await names(), ['Brick', 'Sword', 'Deed: Winterfell']);
  });

  test('a player rearrangement is stored and shared with everyone controlling the role', async () => {
    const st = await s.a.state();
    const deed = entryByName(st, 'Deed: Winterfell')!;
    const brick = entryByName(st, 'Brick')!;
    await s.a.post('/api/me/inventory/reorder', { entryId: deed.id, beforeEntryId: brick.id });
    assert.deepEqual(await names(s.a), ['Deed: Winterfell', 'Brick', 'Sword']);
    assert.deepEqual(await names(s.b), ['Deed: Winterfell', 'Brick', 'Sword']);
    await s.b.post('/api/me/inventory/reorder', { entryId: brick.id, beforeEntryId: null });
    assert.deepEqual(await names(s.a), ['Deed: Winterfell', 'Sword', 'Brick']);
  });

  test('players cannot reorder another role’s inventory', async () => {
    const deed = entryByName(await s.a.state(), 'Deed: Winterfell')!;
    await expectApiError(s.c.post('/api/me/inventory/reorder', { entryId: deed.id, beforeEntryId: null }), 404);
  });

  test('the custom order survives a server restart', async () => {
    await env.restart();
    const a = await env.as('alice');
    assert.deepEqual(await names(a), ['Deed: Winterfell', 'Sword', 'Brick']);
    s.a = a;
  });

  test('adding to an existing stack keeps its place in the custom order', async () => {
    await env.gm.post(`/api/gm/roles/${s.stark.id}/items`, { itemDefId: s.brick.id, quantity: 1 });
    await env.gm.post(`/api/gm/roles/${s.stark.id}/items`, { itemDefId: s.sword.id, quantity: 1 });
    assert.deepEqual(await names(), ['Deed: Winterfell', 'Sword', 'Brick', 'Sword']);
  });
});

describe('shared-role inventory access', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  function listen(cookie: string): Promise<{ messages: any[]; ws: WebSocket; ready: Promise<void> }> {
    const ws = new WebSocket(env.base.replace('http', 'ws') + '/ws', { headers: { cookie } });
    const messages: any[] = [];
    const ready = new Promise<void>((resolve, reject) => {
      ws.on('message', (data: Buffer) => {
        const m = JSON.parse(String(data));
        messages.push(m);
        if (m.type === 'hello') resolve();
      });
      ws.on('error', reject);
    });
    return Promise.resolve({ messages, ws, ready });
  }

  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) throw new Error('Timed out waiting for live update');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  test('players of the same role see exactly the same inventory', async () => {
    const [x, y] = await Promise.all([s.a.state(), s.b.state()]);
    assert.deepEqual(x.inventory, y.inventory);
    assert.deepEqual(x.members, ['alice', 'bob']);
  });

  test('a change by one player is pushed live to the other, but not to unrelated roles', async () => {
    const bobWs = await listen(s.b.cookie!);
    const cerseiWs = await listen(s.c.cookie!);
    await Promise.all([bobWs.ready, cerseiWs.ready]);
    const st = await s.a.state();
    await s.a.post('/api/me/inventory/reorder', { entryId: entryByName(st, 'Brick')!.id, beforeEntryId: null });
    await waitFor(() => bobWs.messages.some((m) => m.type === 'changed' && m.roles.includes(s.stark.id)));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!cerseiWs.messages.some((m) => m.type === 'changed'));
    bobWs.ws.close();
    cerseiWs.ws.close();
  });

  test('WebSocket connections require a valid session', async () => {
    const ws = new WebSocket(env.base.replace('http', 'ws') + '/ws');
    const err = await new Promise<Error>((resolve) => ws.on('error', resolve));
    assert.match(err.message, /401/);
  });
});
