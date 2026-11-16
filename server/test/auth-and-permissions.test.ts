import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, expectApiError, seed, startEnv, type TestEnv } from './helpers.js';

describe('player authentication', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('valid credentials create a session; me reflects the assigned role', async () => {
    const me = await s.a.get('/api/auth/me');
    assert.equal(me.user.username, 'alice');
    assert.equal(me.user.roleId, s.stark.id);
    assert.equal(me.user.isGm, false);
  });

  test('wrong password and unknown users are rejected identically', async () => {
    await expectApiError(new Client(env.base).login('alice', 'nope'), 401, /Incorrect username or password/);
    await expectApiError(new Client(env.base).login('nobody', 'nope'), 401, /Incorrect username or password/);
  });

  test('passwords are stored hashed, never in plain text', () => {
    const row = env.app.ctx.db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE username = 'alice'")!;
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes('password1'));
  });

  test('requests without a session are refused', async () => {
    const anon = new Client(env.base);
    await expectApiError(anon.get('/api/me/state'), 401);
    await expectApiError(anon.get('/api/gm/overview'), 401);
  });

  test('logout invalidates the session token', async () => {
    const c = await env.as('cersei');
    const cookie = c.cookie;
    await c.post('/api/auth/logout');
    const replay = new Client(env.base);
    replay.cookie = cookie;
    await expectApiError(replay.get('/api/me/state'), 401);
  });

  test('disabling an account blocks login and ends existing sessions', async () => {
    const c = await env.as('cersei');
    await env.gm.patch(`/api/gm/players/${s.cersei.id}`, { disabled: true });
    await expectApiError(c.get('/api/me/state'), 401);
    await expectApiError(new Client(env.base).login('cersei', 'password1'), 403, /disabled/);
    await env.gm.patch(`/api/gm/players/${s.cersei.id}`, { disabled: false });
    await env.as('cersei');
  });

  test('GM password reset revokes the player sessions and issues the new password', async () => {
    const b = await env.as('bob');
    await env.gm.post(`/api/gm/players/${s.bob.id}/password`, { password: 'brand-new-pass' });
    await expectApiError(b.get('/api/me/state'), 401);
    await expectApiError(new Client(env.base).login('bob', 'password1'), 401);
    await env.as('bob', 'brand-new-pass');
  });

  test('mutations from a foreign origin are blocked', async () => {
    const r = await s.a.raw('POST', '/api/me/inventory/reorder', { entryId: 'x', beforeEntryId: null }, { origin: 'http://evil.example' });
    assert.equal(r.status, 403);
  });

  test('non-JSON request bodies are refused (blocks cross-site form posts)', async () => {
    const r = await fetch(env.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=alice&password=password1' });
    assert.equal(r.status, 400);
  });
});

describe('role assignment restrictions', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('a player holds at most one role: assigning a new role replaces the old one', async () => {
    await env.gm.post(`/api/gm/players/${s.bob.id}/assign`, { roleId: s.lannister.id });
    const me = await s.b.get('/api/auth/me');
    assert.equal(me.user.roleId, s.lannister.id);
    const rows = env.app.ctx.db.all('SELECT * FROM role_assignments WHERE user_id = ?', s.bob.id);
    assert.equal(rows.length, 1);
    await env.gm.post(`/api/gm/players/${s.bob.id}/assign`, { roleId: s.stark.id });
  });

  test('the database itself refuses a second assignment row for a player', () => {
    assert.throws(() => env.app.ctx.db.run('INSERT INTO role_assignments (user_id, role_id, assigned_at) VALUES (?, ?, 0)', s.alice.id, s.lannister.id), /UNIQUE|PRIMARY/);
  });

  test('a role may have multiple players', async () => {
    const roles = (await env.gm.get('/api/gm/roles')).roles;
    const stark = roles.find((r: any) => r.id === s.stark.id);
    assert.deepEqual(stark.players.map((p: any) => p.username).sort(), ['alice', 'bob']);
  });

  test('unassigned players can log in but cannot perform inventory actions', async () => {
    await env.gm.post('/api/gm/players', { username: 'drifter', password: 'password1' });
    const d = await env.as('drifter');
    const state = await d.state();
    assert.equal(state.inventory, null);
    await expectApiError(d.post('/api/me/inventory/reorder', { entryId: 'x', beforeEntryId: null }), 403, /not assigned/);
    await expectApiError(d.donate(s.stark.id, [{ type: 'currency', currencyId: s.gold.id, amount: '1' }]), 403, /not assigned/);
  });

  test('unassigning takes effect immediately for the player', async () => {
    await env.gm.post(`/api/gm/players/${s.bob.id}/assign`, { roleId: null });
    assert.equal((await s.b.state()).inventory, null);
    await env.gm.post(`/api/gm/players/${s.bob.id}/assign`, { roleId: s.stark.id });
    assert.equal((await s.b.state()).inventory!.role.id, s.stark.id);
  });

  test('the GM account cannot be assigned to a role', async () => {
    const gmId = (await env.gm.get('/api/auth/me')).user.id;
    await expectApiError(env.gm.post(`/api/gm/players/${gmId}/assign`, { roleId: s.stark.id }), 400);
  });
});

describe('GM permissions', () => {
  let env: TestEnv;
  let s: Awaited<ReturnType<typeof seed>>;
  before(async () => {
    env = await startEnv();
    s = await seed(env);
  });
  after(() => env.close());

  test('players cannot call any GM endpoint', async () => {
    const attempts: [string, string, unknown?][] = [
      ['GET', '/api/gm/overview'],
      ['GET', '/api/gm/players'],
      ['POST', '/api/gm/players', { username: 'x1', password: 'password1' }],
      ['POST', `/api/gm/roles/${s.stark.id}/items`, { itemDefId: s.brick.id, quantity: 99 }],
      ['POST', `/api/gm/roles/${s.stark.id}/currencies/${s.gold.id}`, { op: 'add', amount: '500' }],
      ['POST', `/api/gm/roles/${s.stark.id}/duplicate`],
      ['DELETE', `/api/gm/roles/${s.lannister.id}`, { confirmName: 'House Lannister' }],
      ['PUT', '/api/gm/settings', { approvalRequired: true }],
      ['GET', '/api/gm/audit'],
      ['GET', '/api/gm/donations'],
    ];
    for (const [method, url, body] of attempts) {
      await expectApiError(s.a.req(method, url, body), 403);
    }
    // Nothing changed.
    const state = await s.a.state();
    assert.equal(state.inventory!.entries.find((e) => e.name === 'Brick')!.quantity, 5);
    assert.equal(state.inventory!.balances.find((b) => b.currencyId === s.gold.id)!.amount, '100.50');
  });

  test('the permanent audit history is GM-only and records GM actions', async () => {
    await expectApiError(s.a.get('/api/gm/audit'), 403);
    const audit = await env.gm.get('/api/gm/audit?category=gm');
    assert.ok(audit.events.some((e: any) => e.action === 'gm.item.added' && e.actorUsername === 'gm'));
    assert.ok(audit.events.every((e: any) => e.category === 'gm'));
  });

  test('audit records are immutable at the database level', () => {
    const db = env.app.ctx.db;
    assert.throws(() => db.run("UPDATE audit_events SET summary = 'tampered'"), /immutable/);
    assert.throws(() => db.run('DELETE FROM audit_events'), /immutable/);
    assert.throws(() => db.run('DELETE FROM audit_event_assets'), /immutable/);
  });

  test('the GM cannot use player donation endpoints', async () => {
    await expectApiError(env.gm.donate(s.stark.id, [{ type: 'currency', currencyId: s.gold.id, amount: '1' }]), 403);
  });
});
