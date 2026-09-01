// `npm run dev:full` — starts the local SSE/state server (:5174) and Vite (:5173)
// together and points the web app at the local API. Cross-platform (no shell &).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

process.env.PORT = process.env.PORT ?? '5174';
process.env.VITE_HUB_API_BASE = process.env.VITE_HUB_API_BASE ?? `http://localhost:${process.env.PORT}`;

const sse = spawn(process.execPath, [path.join(here, 'local-sse.mjs')], {
  stdio: 'inherit',
});

// Run the Vite CLI through node directly. Spawning `npx.cmd` on Windows fails
// with `spawn EINVAL` (batch files need a shell); this path works everywhere.
const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteCli], {
  stdio: 'inherit',
  cwd: root,
});

function shutdown() {
  sse.kill('SIGTERM');
  vite.kill('SIGTERM');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
