/**
 * htmlMC Step 4 — Full Export Pipeline Integration Orchestrator
 * 
 * Programmatically spawns the local Rust Axum server, serves animation.html,
 * puppets Playwright using the WAAPI compositor-sync engine, streams raw pixels
 * frame-by-frame to avoid memory ballooning, and performs automated self-verification.
 */

import { spawn } from 'child_process';
import { createServer } from 'http';
import { readFileSync, readdirSync, statSync, existsSync, rmSync } from 'fs';
import { join, dirname, extname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RUST_BIN      = resolve(__dirname, '../ffmpeg-bridge/target/debug/ffmpeg-bridge.exe');
const BRIDGE_HOST   = 'http://127.0.0.1:8791';
const STATIC_PORT   = 8792;
const WIDTH         = 800;
const HEIGHT        = 450;
const FPS           = 30;
const DURATION_S    = 5;
const TOTAL_FRAMES  = FPS * DURATION_S; // 150 frames
const FRAME_BYTES   = WIDTH * HEIGHT * 4;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// ─── Programmatic Helper to wait for HTTP port to open ──────────────────────
async function waitPort(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.status === 405 || res.status === 404 || res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for port: ${url}`);
}

async function post(path, body, contentType = 'application/json') {
  const url = `${BRIDGE_HOST}${path}`;
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: contentType === 'application/json' ? JSON.stringify(body) : body,
  };
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
}

function log(msg) {
  process.stdout.write(`[pipeline] ${msg}\n`);
}

async function run() {
  log('=== htmlMC Step 4 Pipeline Integration ===');

  // 1. Verify Rust Binary exists
  if (!existsSync(RUST_BIN)) {
    throw new Error(`Rust server binary not found at: ${RUST_BIN}. Please run 'cargo build' inside scafolds/ffmpeg-bridge/ first.`);
  }

  // 2. Programmatically Spawn Rust Server
  log(`Spawning Rust server: ${RUST_BIN}`);
  const rustProcess = spawn(RUST_BIN, [], {
    cwd: resolve(__dirname, '../ffmpeg-bridge'),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Log Rust server output to console
  rustProcess.stdout.on('data', (data) => {
    process.stdout.write(`[Rust] ${data.toString().trim()}\n`);
  });
  rustProcess.stderr.on('data', (data) => {
    process.stderr.write(`[Rust-Error] ${data.toString().trim()}\n`);
  });

  // Ensure Rust server is shut down if this Node script exits
  const killRust = () => {
    try { rustProcess.kill(); } catch {}
  };
  process.on('exit', killRust);
  process.on('SIGINT', () => { killRust(); process.exit(1); });

  // Wait for Rust server to be active on 8791
  await waitPort(`${BRIDGE_HOST}/export/start`, 60000);
  log('Rust server active and listening.');

  // 3. Spin up Local Static HTTP Server to serve animation.html
  const staticServer = createServer((req, res) => {
    const filePath = join(__dirname, req.url === '/' ? 'animation.html' : req.url.split('?')[0]);
    try {
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'text/plain' });
      res.end(readFileSync(filePath));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(r => staticServer.listen(STATIC_PORT, '127.0.0.1', r));
  log(`Local static server serving animation on http://127.0.0.1:${STATIC_PORT}`);

  // 4. Launch Playwright
  log('Launching headless browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/`);

  await page.waitForTimeout(200); // Allow initial layout paints

  // Clean old output directory before starting Rust session to avoid file bleeding
  const targetOutputDir = resolve(__dirname, '../ffmpeg-bridge/output/test_export');
  if (existsSync(targetOutputDir)) {
    log(`Cleaning old output directory: ${targetOutputDir}`);
    rmSync(targetOutputDir, { recursive: true, force: true });
  }

  const isProRes = process.argv.includes('--prores');
  const format = isProRes ? 'prores' : 'png_sequence';

  // 5. Start Export Session via Rust Bridge
  log(`POST /export/start with format=${format}...`);
  const startRes = await post('/export/start', {
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    format: format
  });
  const outputDir = startRes.output_dir ?? './output';
  log(`Export started. Target output directory: ${outputDir}`);

  // 6. Step, capture, and stream on-the-fly (O(1) memory pattern!)
  log(`Streaming ${TOTAL_FRAMES} animation frames directly to FFmpeg bridge...`);
  const t0 = Date.now();

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const t = (i / FPS) * 1000; // ms

    // Seek all animations & force compositor flush
    await page.evaluate((timeMs) => {
      document.getAnimations().forEach(a => {
        a.currentTime = timeMs;
        a.pause();
      });
      document.body.getBoundingClientRect(); // flush paint state
    }, t);

    // Snapshot transparent viewport
    const png = await page.screenshot({ type: 'png', omitBackground: true });

    // Decode base64 to typed array inside browser to avoid JSON buffer IPC explosion
    const rgba = await page.evaluate(async (b64) => {
      const img = await new Promise((res, rej) => {
        const imgObj = new Image();
        imgObj.onload = () => res(imgObj);
        imgObj.onerror = rej;
        imgObj.src = `data:image/png;base64,${b64}`;
      });
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
      return new Uint8Array(d.buffer);
    }, png.toString('base64'));

    // POST raw frame immediately (Constant memory usage, zero array retention!)
    await post('/export/frame', Buffer.from(rgba), 'application/octet-stream');

    if (i % 30 === 0 || i === TOTAL_FRAMES - 1) {
      log(`  processed frame ${i}/${TOTAL_FRAMES - 1} (${t.toFixed(0)}ms)`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  log(`All ${TOTAL_FRAMES} frames streamed in ${elapsed}s`);

  // 7. End Export Session
  log('POST /export/end...');
  const endRes = await post('/export/end', {});
  log(`Bridge finalize response: ${JSON.stringify(endRes)}`);

  // 8. Clean up everything
  log('Cleaning up browser and static servers...');
  await browser.close();
  staticServer.close();
  rustProcess.kill();

  // 9. Auto-Verification check
  log('\n── Automated Pipeline Verification ───────────────────');
  if (format === 'prores') {
    const videoPath = join(outputDir, 'output.mov');
    const exists = existsSync(videoPath);
    const size = exists ? statSync(videoPath).size : 0;
    log(`ProRes output file: ${videoPath}`);
    log(`Exists: ${exists ? '✅ YES' : '❌ NO'}`);
    log(`File size: ${size} bytes → ${size > 1000 ? '✅ PASS' : '❌ FAIL'}`);
    log('──────────────────────────────────────────────────────\n');

    if (exists && size > 1000) {
      log('🎉 Step 4 ProRes Export Integration SUCCESS!');
    } else {
      log('❌ Step 4 ProRes Export Integration FAILED.');
      process.exit(1);
    }
  } else {
    const files = readdirSync(outputDir)
      .filter(f => f.endsWith('.png'))
      .sort();

    const frameCount = files.length;
    log(`Frame count written: ${frameCount} (Expected: ${TOTAL_FRAMES}) → ${frameCount === TOTAL_FRAMES ? '✅ PASS' : '❌ FAIL'}`);

    let nonZero = 0;
    for (const f of files) {
      const size = statSync(join(outputDir, f)).size;
      if (size > 0) nonZero++;
    }
    log(`Non-empty files: ${nonZero}/${frameCount} → ${nonZero === frameCount ? '✅ PASS' : '❌ FAIL'}`);
    log('──────────────────────────────────────────────────────\n');

    if (frameCount === TOTAL_FRAMES && nonZero === frameCount) {
      log('🎉 Step 4 Full Pipeline Integration SUCCESS!');
    } else {
      log('❌ Step 4 Full Pipeline Integration FAILED.');
      process.exit(1);
    }
  }
}

run().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
