import { spawn, execSync } from 'child_process';
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'fs';
import { join, resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WIDTH        = parseInt(process.env.HTMLMC_WIDTH)        || 800;
const HEIGHT       = parseInt(process.env.HTMLMC_HEIGHT)       || 450;
const FPS          = parseInt(process.env.HTMLMC_FPS)          || 30;
const FORMAT       = process.env.HTMLMC_FORMAT                 || 'png_sequence';
const START_FRAME  = parseInt(process.env.HTMLMC_START_FRAME)  || 0;
const END_FRAME_E  = parseInt(process.env.HTMLMC_END_FRAME);
const ANIM_SRC     = process.env.HTMLMC_ANIM_SRC               || '../pipeline/animation.html';
const AUDIO_PATH   = process.env.HTMLMC_AUDIO_PATH             || null;
const AUDIO_OFFSET = parseFloat(process.env.HTMLMC_AUDIO_OFFSET) || 0.0;
const PROJECT_NAME = process.env.HTMLMC_PROJECT_NAME           || 'export';

const RUST_BIN    = resolve(__dirname, '../ffmpeg-bridge/target/debug/ffmpeg-bridge.exe');
const BRIDGE_HOST = 'http://127.0.0.1:8791';
const STATIC_PORT = 8794;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };

const IS_VIDEO = FORMAT === 'prores' || FORMAT === 'mp4';

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function log(text) { emit({ type: 'log', text }); }

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'export';
}

function resolveOutputDir(projectName) {
  const base    = resolve(__dirname, '../pipeline/exports');
  const safeName = sanitizeName(projectName);
  const candidate = join(base, safeName);
  if (!existsSync(candidate)) return candidate;

  let v = 1;
  while (existsSync(join(base, `${safeName}-v${v}`))) v++;
  return join(base, `${safeName}-v${v}`);
}

async function waitPort(url, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.status < 500) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

async function post(path, body, ct = 'application/json') {
  const r = await fetch(`${BRIDGE_HOST}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': ct },
    body: ct === 'application/json' ? JSON.stringify(body) : body,
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json().catch(() => ({}));
}

function getAppData() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || join(os.homedir(), '.local', 'share');
}

async function setupFfmpeg() {
  const FFMPEG_DIR = join(getAppData(), 'htmlMC', 'ffmpeg');
  const FFMPEG_BIN = join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

  if (existsSync(FFMPEG_BIN)) return FFMPEG_BIN;

  try {
    execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg', { stdio: 'ignore' });
    log('ffmpeg found in system PATH');
    return 'ffmpeg';
  } catch {}

  if (process.env.HTMLMC_AUTO_INSTALL_FFMPEG !== 'true') {
    emit({ type: 'ffmpeg_missing' });
    throw new Error('ffmpeg is missing. Prompting user for download.');
  }

  log('Fetching latest ffmpeg binary info...');
  const apiRes = await fetch('https://ffbinaries.com/api/v1/version/latest');
  if (!apiRes.ok) throw new Error('Failed to fetch ffbinaries api');
  const apiData = await apiRes.json();

  const platformKey = process.platform === 'win32' ? 'windows-64' : process.platform === 'darwin' ? 'osx-64' : 'linux-64';
  const url = apiData.bin.ffmpeg[platformKey];
  if (!url) throw new Error('No ffmpeg binary found for ' + platformKey);

  log(`Downloading ffmpeg from ${url}...`);
  mkdirSync(FFMPEG_DIR, { recursive: true });

  const zipPath = join(FFMPEG_DIR, 'ffmpeg.zip');
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to download: ' + res.statusText);
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  log('Extracting ffmpeg...');
  if (process.platform === 'win32') {
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${FFMPEG_DIR}' -Force"`);
  } else {
    execSync(`unzip -o '${zipPath}' -d '${FFMPEG_DIR}'`);
  }

  unlinkSync(zipPath);
  if (process.platform !== 'win32') chmodSync(FFMPEG_BIN, '755');

  log(`ffmpeg installed at ${FFMPEG_BIN}`);
  return FFMPEG_BIN;
}

async function run() {
  const animSrcPath = resolve(__dirname, ANIM_SRC);
  const staticDir   = resolve(animSrcPath, '..');

  const staticServer = createServer((req, res) => {
    const filePath = join(staticDir, req.url === '/' ? 'animation_preview.html' : req.url.split('?')[0]);
    try {
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'text/plain' });
      res.end(readFileSync(filePath));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => staticServer.listen(STATIC_PORT, '127.0.0.1', r));
  log(`static server on http://127.0.0.1:${STATIC_PORT}`);

  const outputDir = resolveOutputDir(PROJECT_NAME);
  mkdirSync(outputDir, { recursive: true });
  log(`output → ${outputDir}`);

  // Video formats only: start Rust bridge + ffmpeg
  let rustProc = null;
  if (IS_VIDEO) {
    const ffmpegPath = await setupFfmpeg();

    if (!existsSync(RUST_BIN)) throw new Error(`Rust binary not found: ${RUST_BIN}`);
    rustProc = spawn(RUST_BIN, [], {
      cwd: resolve(__dirname, '../ffmpeg-bridge'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FFMPEG_PATH: ffmpegPath }
    });
    rustProc.stderr.on('data', d => log(`[Rust] ${d.toString().trim()}`));
    process.on('exit', () => { try { rustProc.kill(); } catch {} });

    await waitPort(`${BRIDGE_HOST}/export/start`);
    log('Rust bridge ready');

    await post('/export/start', {
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      format: FORMAT,
      audio_path: AUDIO_PATH,
      audio_offset: AUDIO_OFFSET,
      output_dir: outputDir,
    });
  }

  // Launch Playwright
  const browser = await chromium.launch();
  const page    = await browser.newPage();
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/`);
  await page.waitForTimeout(200);

  const durationFrames = await page.evaluate(() => {
    const anims = document.getAnimations();
    if (!anims.length) return 150;
    return Math.max(...anims.map(a => {
      const eff = a.effect;
      return eff ? Math.round(((eff.getTiming().duration ?? 5000) / 1000) * 30) : 150;
    }));
  }).catch(() => 150);

  const endFrame    = (END_FRAME_E > 0) ? END_FRAME_E : durationFrames;
  const totalFrames = endFrame - START_FRAME;

  for (let i = 0; i < totalFrames; i++) {
    const frame = START_FRAME + i;
    const t     = (frame / FPS) * 1000;

    await page.evaluate(timeMs => {
      document.getAnimations().forEach(a => { a.currentTime = timeMs; a.pause(); });
      document.body.getBoundingClientRect();
    }, t);

    const png = await page.screenshot({ type: 'png', omitBackground: true });

    if (IS_VIDEO) {
      // Decode PNG → RGBA buffer, pipe to Rust bridge
      const rgba = await page.evaluate(async b64 => {
        const img = await new Promise((res, rej) => {
          const i = new Image(); i.onload = () => res(i); i.onerror = rej;
          i.src = `data:image/png;base64,${b64}`;
        });
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        return new Uint8Array(c.getContext('2d').getImageData(0, 0, img.width, img.height).data.buffer);
      }, png.toString('base64'));

      await post('/export/frame', Buffer.from(rgba), 'application/octet-stream');
    } else {
      // PNG sequence: write directly to disk
      const frameNum = String(frame + 1).padStart(4, '0');
      writeFileSync(join(outputDir, `frame_${frameNum}.png`), png);
    }

    emit({ type: 'progress', frame: i + 1, total: totalFrames });
  }

  await browser.close();
  staticServer.close();

  if (IS_VIDEO) {
    await post('/export/end', {});
    rustProc.kill();
    emit({ type: 'done', output: outputDir });
  } else {
    emit({ type: 'done', output: outputDir });
  }
}

run().catch(err => {
  emit({ type: 'error', text: err.message });
  process.exit(1);
});
