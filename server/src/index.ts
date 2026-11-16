import './suppress-warnings.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { lanAddresses } from './http/routes.js';

const config = loadConfig();
const app = createApp(config);

const port = await app.listen();
const proto = config.tlsCertFile ? 'https' : 'http';
console.log('');
console.log('  The Ledger is running.');
console.log(`  Database: ${config.databasePath}`);
console.log(`  This computer:  ${proto}://localhost:${port}`);
if (config.host === '0.0.0.0' || config.host === '::') {
  for (const a of lanAddresses(port)) console.log(`  Local network:  ${a.replace('http:', proto + ':')}`);
} else {
  console.log(`  Listening on ${config.host} only (set HOST=0.0.0.0 to allow other devices).`);
}
if (config.publicUrl) console.log(`  Public URL:     ${config.publicUrl}`);
if (app.initialGm.created) {
  console.log('');
  console.log(`  Created the GM account "${app.initialGm.username}".`);
  if (app.initialGm.password) {
    console.log(`  Generated GM password: ${app.initialGm.password}`);
    console.log('  Write it down now; it is not shown again. (Set GM_PASSWORD before first start to choose your own.)');
  }
}
console.log('');

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}, shutting down...`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
