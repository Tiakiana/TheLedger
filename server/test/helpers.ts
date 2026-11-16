import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type App } from '../src/app.js';
import { ManualClock } from '../src/clock.js';
import { loadConfig, type Config } from '../src/config.js';
import type { DonationDTO, PlayerStateDTO } from '../src/shared/types.js';

export const GM_PASSWORD = 'gm-password-1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: { code: string; message: string } },
  ) {
    super(`${status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  }
}

/** A minimal HTTP client with its own cookie (one per logged-in user). */
export class Client {
  cookie: string | null = null;
  constructor(public base: string) {}

  async raw(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(this.base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async req<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    const r = await this.raw(method, url, body);
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const json = r.status === 204 ? {} : await r.json();
    if (!r.ok) throw new ApiError(r.status, json);
    return json as T;
  }

  get = <T = any>(url: string) => this.req<T>('GET', url);
  post = <T = any>(url: string, body: unknown = {}) => this.req<T>('POST', url, body);
  patch = <T = any>(url: string, body: unknown = {}) => this.req<T>('PATCH', url, body);
  put = <T = any>(url: string, body: unknown = {}) => this.req<T>('PUT', url, body);
  del = <T = any>(url: string, body?: unknown) => this.req<T>('DELETE', url, body);

  async login(username: string, password: string): Promise<this> {
    await this.post('/api/auth/login', { username, password });
    return this;
  }

  state(): Promise<PlayerStateDTO> {
    return this.get<PlayerStateDTO>('/api/me/state');
  }

  async donate(recipientRoleId: string, lines: unknown[], requestId?: string): Promise<DonationDTO> {
    return (await this.post<{ donation: DonationDTO }>('/api/donations', { recipientRoleId, lines, requestId })).donation;
  }
}

export interface TestEnv {
  app: App;
  clock: ManualClock;
  base: string;
  gm: Client;
  config: Config;
  dbFile: string;
  /** Logs in a new client. */
  as(username: string, password?: string): Promise<Client>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  return path.join(dir, 'ledger.db');
}

/** Starts a real server on a random port with a file-backed database and a manual clock. */
export async function startEnv(opts: { dbFile?: string; clock?: ManualClock } = {}): Promise<TestEnv> {
  const dbFile = opts.dbFile ?? tempDbFile();
  const clock = opts.clock ?? new ManualClock();
  const config: Config = { ...loadConfig({}, path.dirname(dbFile)), databasePath: dbFile, gmPassword: GM_PASSWORD, host: '127.0.0.1' };
  let app = createApp(config, { clock, schedule: false });
  let port = await app.listen(0, '127.0.0.1');
  const env: TestEnv = {
    app,
    clock,
    config,
    dbFile,
    base: `http://127.0.0.1:${port}`,
    gm: await new Client(`http://127.0.0.1:${port}`).login('gm', GM_PASSWORD),
    async as(username, password = 'password1') {
      return new Client(env.base).login(username, password);
    },
    async restart() {
      await app.close();
      app = createApp(config, { clock, schedule: false });
      port = await app.listen(0, '127.0.0.1');
      env.app = app;
      env.base = `http://127.0.0.1:${port}`;
      env.gm = await new Client(env.base).login('gm', GM_PASSWORD);
    },
    async close() {
      await app.close();
    },
  };
  return env;
}

/** Common fixture: two roles, three players (alice+bob share House Stark), items and a currency. */
export async function seed(env: TestEnv) {
  const gm = env.gm;
  const stark = (await gm.post('/api/gm/roles', { name: 'House Stark' })).role;
  const lannister = (await gm.post('/api/gm/roles', { name: 'House Lannister' })).role;
  const alice = (await gm.post('/api/gm/players', { username: 'alice', password: 'password1', roleId: stark.id })).player;
  const bob = (await gm.post('/api/gm/players', { username: 'bob', password: 'password1', roleId: stark.id })).player;
  const cersei = (await gm.post('/api/gm/players', { username: 'cersei', password: 'password1', roleId: lannister.id })).player;
  const brick = (await gm.post('/api/gm/item-definitions', { name: 'Brick', description: 'A clay brick', stackable: true })).itemDefinition;
  const sword = (await gm.post('/api/gm/item-definitions', { name: 'Sword', description: 'Sharp', stackable: false })).itemDefinition;
  const deed = (await gm.post('/api/gm/item-definitions', { name: 'Land deed', description: 'Proof of ownership', stackable: false })).itemDefinition;
  const gold = (await gm.post('/api/gm/currencies', { name: 'Gold', precision: 2, max: '1000' })).currency;
  await gm.post(`/api/gm/roles/${stark.id}/items`, { itemDefId: brick.id, quantity: 5 });
  await gm.post(`/api/gm/roles/${stark.id}/items`, { itemDefId: sword.id, quantity: 1 });
  await gm.post(`/api/gm/roles/${stark.id}/items`, { itemDefId: deed.id, quantity: 1, customName: 'Deed: Winterfell' });
  await gm.post(`/api/gm/roles/${stark.id}/currencies/${gold.id}`, { op: 'set', amount: '100.50' });
  const a = await env.as('alice');
  const b = await env.as('bob');
  const c = await env.as('cersei');
  return { stark, lannister, alice, bob, cersei, brick, sword, deed, gold, a, b, c };
}

export function entryByName(state: PlayerStateDTO, name: string) {
  return state.inventory!.entries.find((e) => e.name === name);
}

export function balanceOf(state: PlayerStateDTO, currencyId: string) {
  return state.inventory!.balances.find((b) => b.currencyId === currencyId)!;
}

export async function expectApiError(p: Promise<unknown>, status: number, messagePart?: RegExp): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status !== status) throw new Error(`Expected HTTP ${status}, got ${e.status}: ${e.message}`);
    if (messagePart && !messagePart.test(e.body?.error?.message ?? '')) throw new Error(`Unexpected message: ${e.body?.error?.message}`);
    return e;
  }
  throw new Error(`Expected HTTP ${status}, but the request succeeded`);
}
