// Development: rebuild the client on change and restart the server on change.
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const procs = [run('node', ['scripts/build-client.mjs', '--watch']), run('npx', ['tsx', 'watch', '--clear-screen=false', 'server/src/index.ts'])];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
