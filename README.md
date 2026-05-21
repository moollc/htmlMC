# htmlMC

**htmlMC** is an AI-integrated HTML motion graphics engine. It allows developers and designers to build, preview, and export high-fidelity, deterministic motion graphics directly from HTML, CSS, and JavaScript. 

Unlike traditional browser captures, htmlMC uses Web Animations API (WAAPI) hijacking to perfectly synchronize with a headless Chromium instance via Playwright. This ensures **100% frame-accurate exports** with native alpha transparency, without dropped frames or jitter, all powered by an offline Rust-based FFmpeg bridge.

---

## Core Features

- **AI-Powered Editor:** Integrated dockable AI assistant supporting multiple providers (Anthropic, Google, OpenAI, DeepSeek, xAI, and local LM Studio models) that writes and injects deterministic animations directly into your active canvas.
- **Isolated Sandbox Stage:** Compositions run in an isolated `iframe` to prevent errors from crashing the main timeline UI, with an automated fallback/auto-correct loop.
- **Flawless Export Pipeline:**
  - **PNG Sequences** with pristine native alpha (`rgba(0,0,0,0)`)
  - **ProRes 4444 QuickTime** (`.mov`) with native video transparency
- **Asset Pooling & Multimodal AI:** Drag-and-drop local PNG, SVG, or MP4 files into the Workspace Drawer, and the AI is instantly aware of them to inject directly into your scenes.
- **History State Manager:** Built-in IDE features like Undo/Redo (`Ctrl+Z`, `Ctrl+Shift+Z`) and click-to-modify prompt histories, enabling rapid AI iteration loops without data loss.
- **Multi-Canvas Workspace:** Manage multiple active compositions simultaneously, seamlessly saved to `localStorage` with inline, dialog-free renaming and deletion gestures.

---

## Architecture

htmlMC relies on a zero-dependency frontend and a high-performance backend, decoupling the UI from the heavy-lifting of video encoding:

1. **Timeline UI (`timeline-ui/`)**: A pure Vanilla JS frontend. It manages the AI state, timelines, Web Animations API synchronizers, and canvas memory.
2. **Export Orchestrator (`pipeline/`)**: A Node.js middleware that acts as the bridge. It handles AI key proxying (to keep keys secure from the browser network tab), file streaming, and Playwright orchestration.
3. **FFmpeg Bridge (`ffmpeg-bridge/`)**: A dedicated Rust/Axum binary that receives binary frame streams from Node via IPC and pipes them directly to FFmpeg with `O(1)` memory overhead, ensuring lightning-fast exports.

---

## Getting Started

### Prerequisites
- Node.js (v18+)
- Rust (for compiling the `ffmpeg-bridge`)
- FFmpeg (automatically downloaded to `%APPDATA%\htmlMC\ffmpeg\` on first run)

### 1. Build the Rust FFmpeg Bridge
```bash
cd ffmpeg-bridge
cargo build --release
```

### 2. Launch the Application
Start the Node.js orchestrator and the static server from the `timeline-ui` folder:
```bash
cd timeline-ui
npm install
npm start
```
*Note: Depending on the specific build, `pipeline-runner.js` handles spawning the backend services dynamically.*

### 3. Open the UI
Navigate to `http://127.0.0.1:8795` in any modern web browser to access the htmlMC workspace.

---

## Using the AI Integrations

To start prompting animations:
1. Click the **Settings** gear in the top right.
2. Select your AI provider and input your API key. Keys are sent securely to the local Node backend and are **never** persisted to disk.
3. If using a local model via **LM Studio**, select the LM Studio provider. The loopback address (`http://127.0.0.1:1234/v1`) is automatically injected, and no API key is required.
4. Open the AI Sidebar, type a prompt (e.g., *"Draw a glowing neon circle that pulses for 3 seconds"*), and hit **Generate**.

---

## Security & Development Rules

- **Zero Modal Dialogs:** The application UI uses inline glassmorphic confirmations and interactions. Standard blocking browser functions (`window.prompt`, `window.alert`, `window.confirm`) are strictly prohibited in the codebase to ensure compatibility with embedded webviews.
- **Deterministic Animations Only:** AI generations are instructed to never use `animation-iteration-count: infinite`. All animations must have a determinable, finite duration to allow the offline exporter to properly compute total frame counts.
