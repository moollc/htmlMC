/**
 * Serves the Timeline UI on port 8795.
 * Run: node serve.js
 * Then open http://localhost:8795 in Chrome.
 *
 * Also starts the export server on port 8793 automatically.
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = resolve(__dirname, '../pipeline');
const PORT = 8795;

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
};


// Start export server as a sibling process
const exportProc = fork(join(__dirname, 'export-server.js'), [], { stdio: 'inherit' });
process.on('exit', () => exportProc.kill());

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Serve pipeline animation files at /pipeline/*
  let filePath;
  if (url.startsWith('/pipeline/')) {
    filePath = join(PIPELINE_DIR, url.slice('/pipeline/'.length));
  } else {
    filePath = join(__dirname, url === '/' ? 'index.html' : url);
  }

  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'text/plain' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ui] open http://127.0.0.1:${PORT} in Chrome`);
  console.log('[ui] export server starting on port 8793...');
});
