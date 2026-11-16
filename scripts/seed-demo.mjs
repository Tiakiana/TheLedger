// Fills a running server with demo data so you can try The Ledger quickly.
// Usage: node scripts/seed-demo.mjs [http://localhost:8080] [gm-username] [gm-password]
// Creates roles, players (password "password1"), items and currencies. Safe to run once on an empty server.

const base = (process.argv[2] || process.env.LEDGER_URL || 'http://localhost:8080').replace(/\/$/, '');
const gmUser = process.argv[3] || process.env.GM_USERNAME || 'gm';
const gmPass = process.argv[4] || process.env.GM_PASSWORD;
if (!gmPass) {
  console.error('Pass the GM password: node scripts/seed-demo.mjs <url> <gm-username> <gm-password>');
  process.exit(1);
}

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${json?.error?.message ?? res.status}`);
  return json;
}

await call('POST', '/api/auth/login', { username: gmUser, password: gmPass });

const roleNames = ['House Stark', 'House Lannister', 'The Iron Bank', 'Brotherhood Without Banners', 'Night’s Watch'];
const roles = {};
for (const name of roleNames) roles[name] = (await call('POST', '/api/gm/roles', { name })).role;

const players = [
  ['alice', 'House Stark'],
  ['bob', 'House Stark'],
  ['cersei', 'House Lannister'],
  ['jaime', 'House Lannister'],
  ['banker', 'The Iron Bank'],
  ['newcomer', null],
];
for (const [username, role] of players) await call('POST', '/api/gm/players', { username, password: 'password1', roleId: role ? roles[role].id : null });

const defs = {};
const itemDefs = [
  ['Brick', 'A fired clay brick, good for walls and keeps.', true],
  ['Timber', 'Seasoned oak planks.', true],
  ['Sack of wheat', 'Enough grain to feed a family for a week.', true],
  ['Iron ingot', 'Smelted iron, ready for the smith.', true],
  ['Healing draught', 'Bitter, but it closes wounds.', true],
  ['Arrow', 'Grey goose fletching.', true],
  ['Barrel of ale', 'Brewed in the Riverlands.', true],
  ['Bolt of silk', 'Fine silk from across the Narrow Sea.', true],
  ['Raven', 'Trained to carry messages between castles.', true],
  ['Longsword', 'A well-balanced steel blade.', false],
  ['Warhorse', 'A destrier trained for battle.', false],
  ['Land deed', 'Proof of ownership of a holding.', false],
  ['Signet ring', 'Seals letters with a house sigil.', false],
  ['Map of Westeros', 'Hand-drawn, with a few errors.', false],
];
for (const [name, description, stackable] of itemDefs) defs[name] = (await call('POST', '/api/gm/item-definitions', { name, description, stackable })).itemDefinition;

const gold = (await call('POST', '/api/gm/currencies', { name: 'Gold dragons', precision: 2, max: '100000', gauge: 'bar', color: '#b07d2b' })).currency;
const influence = (await call('POST', '/api/gm/currencies', { name: 'Influence', precision: 0, max: '100', gauge: 'dial', color: '#2f5d50' })).currency;
const prestige = (await call('POST', '/api/gm/currencies', { name: 'Prestige', precision: 1, gauge: 'none', color: '#7a4b8c' })).currency;

const give = (role, def, quantity, customName) => call('POST', `/api/gm/roles/${roles[role].id}/items`, { itemDefId: defs[def].id, quantity, customName });
await give('House Stark', 'Brick', 5);
await give('House Stark', 'Timber', 40);
await give('House Stark', 'Sack of wheat', 120);
await give('House Stark', 'Iron ingot', 18);
await give('House Stark', 'Healing draught', 7);
await give('House Stark', 'Arrow', 300);
await give('House Stark', 'Raven', 4);
await give('House Stark', 'Longsword', 1, 'Ice');
await give('House Stark', 'Longsword', 2);
await give('House Stark', 'Warhorse', 1, 'Grey Wind’s Saddle Horse');
await give('House Stark', 'Land deed', 1, 'Deed: Winterfell');
await give('House Stark', 'Land deed', 1, 'Deed: Moat Cailin');
await give('House Stark', 'Signet ring', 1, 'Stark signet');
await give('House Stark', 'Map of Westeros', 1);
await give('House Lannister', 'Bolt of silk', 25);
await give('House Lannister', 'Barrel of ale', 12);
await give('House Lannister', 'Land deed', 1, 'Deed: Casterly Rock');
await give('House Lannister', 'Longsword', 1, 'Widow’s Wail');
await give('The Iron Bank', 'Iron ingot', 500);

const setBal = (role, cur, amount) => call('POST', `/api/gm/roles/${roles[role].id}/currencies/${cur.id}`, { op: 'set', amount });
await setBal('House Stark', gold, '1250.50');
await setBal('House Stark', influence, '62');
await setBal('House Stark', prestige, '310.5');
await setBal('House Lannister', gold, '48210.00');
await setBal('House Lannister', influence, '88');
await setBal('House Lannister', prestige, '540');
await setBal('The Iron Bank', gold, '99000.00');
await setBal('The Iron Bank', influence, '45');

console.log(`Demo data created on ${base}. Players: ${players.map((p) => p[0]).join(', ')} (password "password1").`);
