// Bundles the React client into dist/public with esbuild (fast, offline-friendly, no config).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'public');
const watch = process.argv.includes('--watch');

function writeIndex(metafile) {
  const outputs = Object.keys(metafile.outputs).map((p) => path.relative(out, path.resolve(root, p)).split(path.sep).join('/'));
  const js = outputs.find((p) => p.endsWith('.js'));
  const css = outputs.filter((p) => p.endsWith('.css'));
  let html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
  html = html.replace('<!--STYLES-->', css.map((c) => `<link rel="stylesheet" href="/${c}" />`).join('\n    '));
  html = html.replace('<!--SCRIPTS-->', `<script type="module" src="/${js}"></script>`);
  fs.writeFileSync(path.join(out, 'index.html'), html);
}

function copyPublic() {
  const src = path.join(root, 'client', 'public');
  if (fs.existsSync(src)) fs.cpSync(src, out, { recursive: true });
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
copyPublic();

const options = {
  entryPoints: [path.join(root, 'client', 'src', 'main.tsx')],
  bundle: true,
  outdir: path.join(out, 'assets'),
  entryNames: watch ? '[name]' : '[name]-[hash]',
  format: 'esm',
  target: ['es2020', 'chrome90', 'firefox90', 'safari15'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: true,
  metafile: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
  plugins: [
    {
      name: 'write-index',
      setup(build) {
        build.onEnd((result) => {
          if (result.metafile) writeIndex(result.metafile);
        });
      },
    },
  ],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching client sources…');
} else {
  await esbuild.build(options);
}
