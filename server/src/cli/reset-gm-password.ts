import '../suppress-warnings.js';
import readline from 'node:readline/promises';
import { generatePassword } from '../auth.js';
import { systemClock } from '../clock.js';
import { loadConfig } from '../config.js';
import { Db } from '../db.js';
import { Ctx } from '../services/context.js';
import { setGmPassword } from '../services/users.js';

/** Usage: npm run reset-gm-password [-- <new password>]  (generates one if omitted). Safe to run while the server is up. */
const config = loadConfig();
const db = new Db(config.databasePath);
const ctx = new Ctx(db, systemClock, config);
let password = process.argv[2];
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('New GM password (leave empty to generate one): ')).trim();
  rl.close();
  password = answer || generatePassword(14);
}
try {
  const username = setGmPassword(ctx, null, password);
  console.log(`Password for GM "${username}" updated: ${password}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
