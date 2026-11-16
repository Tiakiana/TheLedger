import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { balanceOf, entryByName, expectApiError, seed, startEnv, type TestEnv } from './helpers.js';

describe('role duplication', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('creates an exact, independent copy with new instance ids and no players', async () => {
    // Give the source a custom order and an in-flight donation.
    const st = await s.a.state();
    await s.a.post('/api/me/inventory/reorder', { entryId: entryByName(st, 'Deed: Winterfell')!.id, beforeEntryId: entryByName(st, 'Brick')!.id });
    await s.a.donate(s.lannister.id, [{ type: 'item', entryId: entryByName(st, 'Brick')!.id, quantity: 1 }]);

    const source = (await env.gm.get(`/api/gm/roles/${s.stark.id}/inventory`)).inventory;
    const copy = (await env.gm.post(`/api/gm/roles/${s.stark.id}/duplicate`)).role;
    assert.equal(copy.name, 'House Stark (copy)');
    assert.deepEqual(copy.players, []);
    assert.equal(copy.activeDonations, 0, 'pending transactions are not duplicated');

    const dup = (await env.gm.get(`/api/gm/roles/${copy.id}/inventory`)).inventory;
    assert.deepEqual(
      dup.entries.map((e: any) => [e.name, e.quantity, e.kind, e.itemDefId, e.customName, e.position]),
      source.entries.map((e: any) => [e.name, e.quantity, e.kind, e.itemDefId, e.customName, e.position]),
    );
    const srcIds = new Set(source.entries.map((e: any) => e.id));
    assert.ok(dup.entries.every((e: any) => !srcIds.has(e.id)), 'every copied entry has a new id');
    assert.ok(dup.entries.every((e: any) => e.reserved === 0));
    assert.deepEqual(
      dup.balances.map((b: any) => b.amount),
      source.balances.map((b: any) => b.amount),
    );
  });

  test('the original is unchanged and the copies are independent', async () => {
    const before = (await env.gm.get(`/api/gm/roles/${s.stark.id}/inventory`)).inventory;
    const copy = (await env.gm.get('/api/gm/roles')).roles.find((r: any) => r.name === 'House Stark (copy)');
    const dupInv = (await env.gm.get(`/api/gm/roles/${copy.id}/inventory`)).inventory;
    const dupBrick = dupInv.entries.find((e: any) => e.name === 'Brick');
    await env.gm.patch(`/api/gm/entries/${dupBrick.id}`, { quantity: 1 });
    await env.gm.post(`/api/gm/roles/${copy.id}/currencies/${s.gold.id}`, { op: 'reset' });
    const after = (await env.gm.get(`/api/gm/roles/${s.stark.id}/inventory`)).inventory;
    assert.deepEqual(after, before);
  });

  test('duplicating again picks a distinguishable name', async () => {
    const copy2 = (await env.gm.post(`/api/gm/roles/${s.stark.id}/duplicate`)).role;
    assert.equal(copy2.name, 'House Stark (copy 2)');
  });
});

describe('GM role, player and catalog management', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('role names are unique and roles can be renamed and searched', async () => {
    await expectApiError(env.gm.post('/api/gm/roles', { name: 'house stark' }), 409);
    await env.gm.patch(`/api/gm/roles/${s.lannister.id}`, { name: 'House Lannister of Casterly Rock' });
    const found = (await env.gm.get('/api/gm/roles?q=casterly')).roles;
    assert.equal(found.length, 1);
    assert.equal((await s.c.get('/api/auth/me')).user.roleName, 'House Lannister of Casterly Rock');
  });

  test('players can be searched by username', async () => {
    const found = (await env.gm.get('/api/gm/players?q=ers')).players;
    assert.deepEqual(
      found.map((p: any) => p.username),
      ['cersei'],
    );
  });

  test('deleting a role requires the exact name and cancels its active donations', async () => {
    const tmp = (await env.gm.post('/api/gm/roles', { name: 'Iron Bank' })).role;
    await env.gm.post(`/api/gm/players/${s.bob.id}/assign`, { roleId: tmp.id });
    await env.gm.post(`/api/gm/roles/${tmp.id}/currencies/${s.gold.id}`, { op: 'set', amount: '5' });
    const d = await s.a.donate(tmp.id, [{ type: 'currency', currencyId: s.gold.id, amount: '1' }]);
    await expectApiError(env.gm.del(`/api/gm/roles/${tmp.id}`, { confirmName: 'Iron' }), 400, /Type the role name/);
    await env.gm.del(`/api/gm/roles/${tmp.id}`, { confirmName: 'Iron Bank' });
    assert.equal((await s.a.get(`/api/donations/${d.id}`)).donation.status, 'cancelled');
    assert.equal(balanceOf(await s.a.state(), s.gold.id).reserved, '0.00');
    assert.equal((await s.b.state()).inventory, null, 'players of a deleted role become unassigned');
    // History is preserved.
    const audit = await env.gm.get(`/api/gm/audit?roleId=${tmp.id}`);
    assert.ok(audit.events.some((e: any) => e.action === 'gm.role.deleted' && e.roleName === 'Iron Bank'));
  });

  test('deleting an item definition removes it everywhere but keeps history', async () => {
    const gem = (await env.gm.post('/api/gm/item-definitions', { name: 'Gem', stackable: true })).itemDefinition;
    await env.gm.post(`/api/gm/roles/${s.stark.id}/items`, { itemDefId: gem.id, quantity: 4 });
    const res = await env.gm.del(`/api/gm/item-definitions/${gem.id}`);
    assert.equal(res.removedUnits, 4);
    assert.equal(entryByName(await s.a.state(), 'Gem'), undefined);
    const audit = await env.gm.get(`/api/gm/audit?assetType=item&assetId=${gem.id}`);
    assert.ok(audit.events.length >= 3);
  });

  test('stackability cannot change while the item is held', async () => {
    await expectApiError(env.gm.patch(`/api/gm/item-definitions/${s.brick.id}`, { stackable: false }), 409);
  });

  test('images are validated by content', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a9a40000000049454e44ae426082', 'hex');
    const up = await env.gm.post('/api/gm/images', { mime: 'image/png', dataBase64: png.toString('base64') });
    const img = await fetch(env.base + up.url, { headers: { cookie: s.a.cookie! } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    await expectApiError(env.gm.post('/api/gm/images', { mime: 'image/png', dataBase64: Buffer.from('<svg onload=alert(1)>').toString('base64') }), 400);
    await expectApiError(env.gm.post('/api/gm/images', { mime: 'image/svg+xml', dataBase64: 'AAAA' }), 400);
  });

  test('currency limits cannot be tightened below existing balances', async () => {
    await expectApiError(env.gm.patch(`/api/gm/currencies/${s.gold.id}`, { max: '50' }), 409, /outside the new limits/);
    await env.gm.patch(`/api/gm/currencies/${s.gold.id}`, { max: null, gauge: 'dial' });
  });

  test('raising precision rescales balances exactly; lossy lowering is refused', async () => {
    await env.gm.patch(`/api/gm/currencies/${s.gold.id}`, { precision: 3 });
    assert.equal(balanceOf(await s.a.state(), s.gold.id).amount, '100.500');
    await expectApiError(env.gm.patch(`/api/gm/currencies/${s.gold.id}`, { precision: 0 }), 409, /lose/);
    await env.gm.patch(`/api/gm/currencies/${s.gold.id}`, { precision: 1 });
    assert.equal(balanceOf(await s.a.state(), s.gold.id).amount, '100.5');
  });

  test('audit history can be filtered by player, role, asset, action and date', async () => {
    const all = await env.gm.get('/api/gm/audit?limit=500');
    assert.ok(all.events.length > 10);
    const byUser = await env.gm.get(`/api/gm/audit?userId=${s.alice.id}`);
    assert.ok(byUser.events.length > 0 && byUser.events.every((e: any) => e.actorUserId === s.alice.id));
    const byAction = await env.gm.get('/api/gm/audit?action=gm.player.');
    assert.ok(byAction.events.every((e: any) => e.action.startsWith('gm.player.')));
    const byCurrency = await env.gm.get(`/api/gm/audit?assetType=currency&assetId=${s.gold.id}`);
    assert.ok(byCurrency.events.every((e: any) => e.assets.some((a: any) => a.assetId === s.gold.id)));
    const future = await env.gm.get(`/api/gm/audit?from=${env.clock.now() + 1}`);
    assert.equal(future.events.length, 0);
    const page1 = await env.gm.get('/api/gm/audit?limit=5');
    const page2 = await env.gm.get(`/api/gm/audit?limit=5&before=${page1.nextBefore}`);
    assert.ok(page2.events[0].id < page1.events[4].id);
  });
});
