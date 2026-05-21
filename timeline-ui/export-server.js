/**
 * htmlMC Export Server
 *
 * A thin Node.js HTTP server on port 8793 that the Timeline UI calls.
 * Receives export config from the browser, runs the pipeline/export.js
 * orchestrator, and streams progress back as newline-delimited JSON.
 *
 * Endpoints:
 *   POST /export  — start export, streams NDJSON progress
 *   POST /abort   — abort current export
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import { resolve, dirname, join, extname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync, readdirSync, unlinkSync, createWriteStream } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8793;

// Auto-create pipeline assets base directory
try {
  mkdirSync(resolve(__dirname, '../pipeline/assets'), { recursive: true });
} catch (e) {
  console.warn('[export-server] Warning: Failed to create assets directory:', e.message);
}

function getAssetsDir(canvasId) {
  if (!canvasId) return resolve(__dirname, '../pipeline/assets');
  const dir = resolve(__dirname, '../pipeline/assets', canvasId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function listAssetsInDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return readdirSync(dir).map(filename => {
      const ext = extname(filename).toLowerCase();
      let type = 'other';
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) type = 'image';
      else if (ext === '.svg') type = 'vector';
      else if (['.mp4', '.webm', '.mov'].includes(ext)) type = 'video';
      else if (['.mp3', '.wav', '.ogg'].includes(ext)) type = 'audio';
      return { name: filename, path: `assets/${filename}`, type };
    });
  } catch {
    return [];
  }
}

let activeProcess = null;


// Session-level AI settings store (held securely in memory)
let sessionAiSettings = {
  provider: 'gemini',
  key: '',
  endpoint: '',
  model: 'gemini-2.5-pro',
  customModel: ''
};

const SYSTEM_PROMPT = `
You are the htmlMC AI Motion Graphic Designer, an expert front-end developer specializing in high-fidelity browser-based animations, SVG vectors, CSS layout, and the Web Animations API (WAAPI).

### Your Mission
Given a user prompt and the current composition code, you generate or edit HTML, CSS, and Vanilla JavaScript to produce stunning, hardware-accelerated, transparent motion graphics.

### Core Constraints & Guidelines

1. **Alpha Transparency Integrity**
   - The stage must remain fully transparent.
   - NEVER add solid background colors (#fff, black, etc.) to the html, body, #stage, or outer wrapper elements.
   - Use high-contrast foreground gradients, text fills, and subtle drop-shadows so elements stand out clearly over transparent backgrounds.

2. **Animation Paradigms Supported**
   - Use native CSS @keyframes and transitions.
   - Keep animations deterministic and frame-steppable. Avoid utilizing random values (Math.random()), real-time clock references (Date.now()), or requestAnimationFrame loops for animation offsets.
   - All animations must bind to standard Web Animations API (WAAPI) elements so the offline capture clock can hijack and seek them sample-accurately.

3. **No Infinite Animation Loops for Export**
   - Do NOT use "animation-iteration-count: infinite" on any element.
   - All animations must have a finite duration so the offline exporter can determine total frame count via animation.effect.getTiming().duration.
   - Use "animation-fill-mode: forwards" to hold the final state instead.

4. **SVG Vector & Media Asset Generation**
   - When generating visuals, prefer high-quality, inline SVG elements.
   - You can also generate separate, discrete asset files (such as high-fidelity SVGs, customized vectors, sound sequences, etc.) and save them directly into the workspace drawer by defining them in the "generated_assets" array in your JSON payload.
   - Animate SVGs using stroke-dash offsets, transforms, and gradient changes for premium micro-interactions.

5. **Return Strict JSON Format**
   - You must respond with a single, valid JSON object inside a \`\`\`json \`\`\` block.
   - The JSON object must match this schema:
     - "type": "full_generation" | "targeted_edit" | "suggestion"
     - "explanation": string (Markdown explanation of your design choices)
     - "suggested_changes": Array of { file: "html"|"css"|"js", action: "replace", target: string, replacement: string }
     - "full_code": { html: string, css: string, js: string }
     - "generated_assets": (optional) Array of { name: string, content: string, type: "vector" | "image" | "audio" }
       * Use "generated_assets" whenever the user explicitly requests to create/generate an asset file (like an SVG vector) and add it to their workspace/drawer. "content" should contain the complete, valid, beautifully-styled raw file string (e.g. for vectors, the full SVG source).
`;

function cleanJsonResponse(text) {
  let cleaned = text.trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
  }
  return JSON.parse(cleaned.trim());
}

const server = createServer(async (req, res) => {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-filename, x-canvas-id');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ─── AI Config Session Endpoint ────────────────────
  if (req.method === 'POST' && req.url === '/ai/config') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const payload = JSON.parse(body);
      Object.assign(sessionAiSettings, payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ─── Update Stage Preview Endpoint ───────────────────
  if (req.method === 'POST' && req.url === '/update-stage') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const payload = JSON.parse(body);
      const PIPELINE_DIR = resolve(__dirname, '../pipeline');
      const targetFile = join(PIPELINE_DIR, 'animation_preview.html');
      writeFileSync(targetFile, payload.code, 'utf8');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, url: '/pipeline/animation_preview.html' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ─── GET /assets — List local pipeline assets ─────────
  if (req.method === 'GET' && req.url.startsWith('/assets')) {
    try {
      const params = new URL(req.url, 'http://x').searchParams;
      const canvasId = params.get('canvasId') || '';
      const pooled   = params.get('pooled') === 'true';

      let list = [];
      if (pooled) {
        // Collect from all canvas subfolders + legacy flat folder
        const baseDir = resolve(__dirname, '../pipeline/assets');
        mkdirSync(baseDir, { recursive: true });
        const entries = readdirSync(baseDir, { withFileTypes: true });
        // Files directly in assets/ (legacy or canvas-less)
        list = entries.filter(e => e.isFile()).map(e => {
          const ext = extname(e.name).toLowerCase();
          let type = 'other';
          if (['.png','.jpg','.jpeg','.gif','.webp'].includes(ext)) type = 'image';
          else if (ext === '.svg') type = 'vector';
          else if (['.mp4','.webm','.mov'].includes(ext)) type = 'video';
          else if (['.mp3','.wav','.ogg'].includes(ext)) type = 'audio';
          return { name: e.name, canvasId: '', path: `assets/${e.name}`, type };
        });
        // Files in each canvas subfolder
        for (const entry of entries.filter(e => e.isDirectory())) {
          const subAssets = listAssetsInDir(resolve(baseDir, entry.name));
          subAssets.forEach(a => {
            list.push({ ...a, canvasId: entry.name, path: `assets/${entry.name}/${a.name}` });
          });
        }
      } else {
        const dir = getAssetsDir(canvasId);
        list = listAssetsInDir(dir).map(a => ({
          ...a,
          canvasId,
          path: canvasId ? `assets/${canvasId}/${a.name}` : `assets/${a.name}`
        }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ assets: list }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ─── POST /upload — Stream local file upload ───────────
  if (req.method === 'POST' && req.url === '/upload') {
    const filename = req.headers['x-filename'];
    const canvasId = req.headers['x-canvas-id'] || '';
    if (!filename) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing x-filename header' }));
      return;
    }
    try {
      const assetsDir = getAssetsDir(canvasId);
      const safeName  = filename.replace(/[\\/]/g, '_');
      const targetPath = join(assetsDir, safeName);

      const writeStream = createWriteStream(targetPath);
      req.pipe(writeStream);

      req.on('end', () => {
        const relativePath = canvasId ? `assets/${canvasId}/${safeName}` : `assets/${safeName}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, path: relativePath }));
      });

      writeStream.on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ─── POST /delete-asset — Remove local asset ──────────
  if (req.method === 'POST' && req.url === '/delete-asset') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const payload = JSON.parse(body);
      const canvasId = payload.canvasId || '';
      const assetsDir = getAssetsDir(canvasId);
      const targetPath = join(assetsDir, payload.filename);
      unlinkSync(targetPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ─── AI Code Generation Proxy Endpoint ───────────────
  if (req.method === 'POST' && req.url === '/ai/generate') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const payload = JSON.parse(body);
      const userPrompt = payload.prompt;
      const currentCode = payload.currentCode;

      const provider = sessionAiSettings.provider;
      const key = sessionAiSettings.key || process.env.HTMLMC_AI_KEY || '';
      const endpoint = sessionAiSettings.endpoint;
      const selectModel = sessionAiSettings.model;
      const model = selectModel === 'custom' ? sessionAiSettings.customModel : selectModel;

      // Scan local assets to inject context into the prompt (respects pooling)
      let assetsText = '';
      try {
        const canvasId = payload.canvasId || '';
        const pooled   = payload.pooled   === true;
        let assetPaths = [];
        if (pooled) {
          const baseDir = resolve(__dirname, '../pipeline/assets');
          mkdirSync(baseDir, { recursive: true });
          const entries = readdirSync(baseDir, { withFileTypes: true });
          entries.filter(e => e.isFile()).forEach(e => assetPaths.push(`assets/${e.name}`));
          entries.filter(e => e.isDirectory()).forEach(dir => {
            listAssetsInDir(resolve(baseDir, dir.name))
              .forEach(a => assetPaths.push(`assets/${dir.name}/${a.name}`));
          });
        } else {
          const dir = getAssetsDir(canvasId);
          listAssetsInDir(dir).forEach(a => {
            assetPaths.push(canvasId ? `assets/${canvasId}/${a.name}` : `assets/${a.name}`);
          });
        }
        if (assetPaths.length > 0) {
          assetsText = '\n\nAvailable Local Assets inside the Workspace:\n' +
            'You can reference and animate the following local asset files in your HTML using their exact relative paths:\n' +
            assetPaths.map(p => `- ${p}`).join('\n') +
            '\n\nWhen requested by the user, you can animate them, insert them into <img>, <video>, or SVG elements, position them, style them, and apply WAAPI transitions. Ensure you use these exact relative paths.';
        }
      } catch (e) {
        console.error('[export-server] Error listing assets for prompt:', e);
      }

      const enrichedPrompt = `User Prompt: ${userPrompt}${assetsText}\n\nCurrent Animation HTML File Content:\n${currentCode}`;
      let responseText = '';

      if (provider === 'lm_studio') {
        const url = `${endpoint || 'http://127.0.0.1:1234/v1'}/chat/completions`;
        const fetchRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model || 'local-model',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: enrichedPrompt }
            ],
            temperature: 0.2
          })
        });
        if (!fetchRes.ok) throw new Error(`LM Studio returned status ${fetchRes.status}`);
        const data = await fetchRes.json();
        responseText = data.choices[0].message.content;
      } else if (provider === 'gemini') {
        const base = endpoint || 'https://generativelanguage.googleapis.com/v1beta';
        const activeModel = model || 'gemini-2.5-pro';
        const url = `${base}/models/${activeModel}:generateContent?key=${key}`;
        
        const fetchRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { text: SYSTEM_PROMPT },
                  { text: enrichedPrompt }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: 'application/json'
            }
          })
        });
        if (!fetchRes.ok) {
          const errBody = await fetchRes.text();
          throw new Error(`Gemini returned status ${fetchRes.status}: ${errBody}`);
        }
        const data = await fetchRes.json();
        responseText = data.candidates[0].content.parts[0].text;
      } else if (provider === 'anthropic') {
        const url = `${endpoint || 'https://api.anthropic.com/v1'}/messages`;
        const fetchRes = await fetch(url, {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model || 'claude-3-5-sonnet-latest',
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [
              { role: 'user', content: enrichedPrompt }
            ],
            temperature: 0.2
          })
        });
        if (!fetchRes.ok) {
          const errBody = await fetchRes.text();
          throw new Error(`Anthropic returned status ${fetchRes.status}: ${errBody}`);
        }
        const data = await fetchRes.json();
        responseText = data.content[0].text;
      } else if (provider === 'openai') {
        const url = `${endpoint || 'https://api.openai.com/v1'}/chat/completions`;
        const fetchRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model || 'gpt-4o',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user',   content: enrichedPrompt }
            ],
            temperature: 0.2,
            response_format: { type: 'json_object' }
          })
        });
        if (!fetchRes.ok) {
          const errBody = await fetchRes.text();
          throw new Error(`OpenAI returned status ${fetchRes.status}: ${errBody}`);
        }
        const data = await fetchRes.json();
        responseText = data.choices[0].message.content;
      } else if (provider === 'deepseek') {
        const url = `${endpoint || 'https://api.deepseek.com/v1'}/chat/completions`;
        const fetchRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model || 'deepseek-reasoner',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user',   content: enrichedPrompt }
            ],
            temperature: 0.2
          })
        });
        if (!fetchRes.ok) {
          const errBody = await fetchRes.text();
          throw new Error(`DeepSeek returned status ${fetchRes.status}: ${errBody}`);
        }
        const data = await fetchRes.json();
        responseText = data.choices[0].message.content;
      } else if (provider === 'grok') {
        const url = `${endpoint || 'https://api.x.ai/v1'}/chat/completions`;
        const fetchRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model || 'grok-2-1212',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user',   content: enrichedPrompt }
            ],
            temperature: 0.2
          })
        });
        if (!fetchRes.ok) {
          const errBody = await fetchRes.text();
          throw new Error(`Grok returned status ${fetchRes.status}: ${errBody}`);
        }
        const data = await fetchRes.json();
        responseText = data.choices[0].message.content;
      } else {
        throw new Error(`Unsupported AI Provider: ${provider}`);
      }

      // Parse structured JSON response matching system prompt specs
      const aiResponse = cleanJsonResponse(responseText);

      // Auto-save generated assets to the active canvas subfolder
      if (aiResponse && Array.isArray(aiResponse.generated_assets)) {
        const canvasId  = payload.canvasId || '';
        const assetsDir = getAssetsDir(canvasId);
        for (const asset of aiResponse.generated_assets) {
          if (asset.name && asset.content) {
            const safeName = asset.name.replace(/[\\/]/g, '_');
            writeFileSync(join(assetsDir, safeName), asset.content, 'utf8');
            console.log(`[export-server] Saved AI asset: ${safeName} → canvas ${canvasId || '(root)'}`);
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(aiResponse));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/abort') {
    if (activeProcess) {
      activeProcess.kill();
      activeProcess = null;
    }
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/export') {
    // Parse body
    let body = '';
    for await (const chunk of req) body += chunk;
    const config = JSON.parse(body);

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    });

    const send = obj => {
      if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
    };

    send({ type: 'log', text: 'Starting export...' });

    // Pass config to the pipeline orchestrator via env vars
    const env = {
      ...process.env,
      HTMLMC_WIDTH:       String(config.width      ?? 800),
      HTMLMC_HEIGHT:      String(config.height     ?? 450),
      HTMLMC_FPS:         String(config.fps        ?? 30),
      HTMLMC_FORMAT:      config.format            ?? 'png_sequence',
      HTMLMC_START_FRAME: String(config.startFrame ?? 0),
      HTMLMC_END_FRAME:   String(config.endFrame   ?? -1),
      HTMLMC_ANIM_SRC:    config.animationSrc      ?? '../pipeline/animation.html',
      HTMLMC_AUDIO_PATH:  config.audioPath         ?? '',
      HTMLMC_AUDIO_OFFSET:String(config.audioOffset?? 0),
      HTMLMC_AUTO_INSTALL_FFMPEG: config.autoInstallFfmpeg ? 'true' : 'false',
      HTMLMC_PROJECT_NAME: config.projectName       ?? 'export',
    };

    const exportScript = resolve(__dirname, 'pipeline-runner.js');

    activeProcess = spawn('node', [exportScript], {
      cwd:   resolve(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeProcess.stdout.on('data', data => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          send(msg);
        } catch {
          send({ type: 'log', text: line });
        }
      }
    });

    activeProcess.stderr.on('data', data => {
      send({ type: 'log', text: data.toString().trim() });
    });

    activeProcess.on('close', code => {
      if (code !== 0 && code !== null) {
        send({ type: 'error', text: `Process exited with code ${code}` });
      }
      activeProcess = null;
      if (!res.writableEnded) res.end();
    });

    req.on('close', () => {
      if (activeProcess) { activeProcess.kill(); activeProcess = null; }
    });

    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[export-server] listening on http://127.0.0.1:${PORT}`);
});
