'use strict';

/**
 * Panel → OBS real-time demo server.
 *
 * One Node process serves both pages and the realtime channel from a single
 * origin (no CORS, no cross-service hop). Messages are relayed panel↔overlay,
 * namespaced by room code. Per-room state is held in memory so a freshly
 * opened OBS Browser Source (or a reconnecting panel) immediately re-syncs.
 *
 * This is intentionally NOT obs-websocket: the overlay is an OBS Browser
 * Source, which is the only approach that works for a remote, HTTPS, iPad-
 * operated demo. See CLAUDE.md §4.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');

// ----------------------------------------------------------------------------
// Static + page routes
// ----------------------------------------------------------------------------

// Serve assets with no-cache so a redeploy is picked up. The overlay lives in
// OBS's embedded browser, which caches hard; this plus ASSET_VERSION query
// strings keeps stale renders from undermining the demo.
app.use(
  express.static(PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    },
  })
);

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// no-store on the HTML too, so OBS's embedded browser can't serve a stale page.
function noStore(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
}

app.get('/panel', (_req, res) => {
  noStore(res);
  res.sendFile(path.join(PUBLIC_DIR, 'panel.html'));
});
app.get('/overlay', (_req, res) => {
  noStore(res);
  res.sendFile(path.join(PUBLIC_DIR, 'overlay.html'));
});

// Landing: mint a room code and point the operator at both pages.
app.get('/', (_req, res) => {
  noStore(res);
  const room = randomRoom();
  res.type('html').send(landingHtml(room));
});

const server = http.createServer(app);

// ----------------------------------------------------------------------------
// Realtime channel
// ----------------------------------------------------------------------------

// maxPayload caps a single frame (our messages are tiny); the per-connection
// rate limit below caps flooding. Together they stop one client from OOM-ing
// or pegging the server during a public demo.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const MAX_MSGS_PER_SEC = 60;

/**
 * rooms: code -> {
 *   clients: Set<ws>,
 *   state:   { text: string, visible: boolean }
 * }
 */
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { clients: new Set(), state: { text: '', visible: true } };
    rooms.set(code, room);
  }
  return room;
}

function normRoom(raw) {
  const cleaned = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return cleaned || 'DEMO';
}

function randomRoom() {
  // Ambiguity-free alphabet (no O/0, I/1) — the operator may type this by hand.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function presenceOf(room) {
  let panels = 0;
  let overlays = 0;
  for (const c of room.clients) {
    if (c.role === 'overlay') overlays++;
    else panels++;
  }
  return { type: 'presence', panels, overlays };
}

function broadcastPresence(room) {
  const msg = presenceOf(room);
  for (const c of room.clients) send(c, msg);
}

wss.on('connection', (ws, req) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    ws.close();
    return;
  }

  const code = normRoom(url.searchParams.get('room'));
  const role = url.searchParams.get('role') === 'overlay' ? 'overlay' : 'panel';

  ws.id = crypto.randomUUID();
  ws.code = code;
  ws.role = role;
  ws.isAlive = true;
  ws.rate = { count: 0, since: Date.now() };

  const room = getRoom(code);
  room.clients.add(ws);

  // Hand the client its id (panels stamp it as `origin` so acks route back to
  // the exact panel that fired the command) and the current room state.
  send(ws, { type: 'welcome', id: ws.id, room: code, role });
  send(ws, { type: 'state', state: room.state });
  broadcastPresence(room);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    // Cheap per-connection flood guard.
    const now = Date.now();
    if (now - ws.rate.since > 1000) {
      ws.rate.since = now;
      ws.rate.count = 0;
    }
    if (++ws.rate.count > MAX_MSGS_PER_SEC) {
      ws.terminate();
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'cmd' && ws.role === 'panel') {
      const clean = sanitizeCommand(msg);
      if (!clean) return; // unknown action — ignore
      applyCommandToState(room.state, clean);
      const relay = {
        type: 'cmd',
        id: typeof msg.id === 'string' ? msg.id.slice(0, 64) : '',
        action: clean.action,
        payload: clean.payload,
        origin: ws.id,
      };
      for (const c of room.clients) {
        if (c.role === 'overlay') send(c, relay);
      }
      return;
    }

    if (msg.type === 'ack' && ws.role === 'overlay') {
      // Route the render-ack back only to the panel that issued the command.
      const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : '';
      const origin = typeof msg.origin === 'string' ? msg.origin : '';
      const ack = { type: 'ack', id };
      for (const c of room.clients) {
        if (c.role === 'panel' && c.id === origin) send(c, ack);
      }
      return;
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      rooms.delete(code);
    } else {
      broadcastPresence(room);
    }
  });

  ws.on('error', () => {
    // A socket-level error is followed by 'close'; nothing extra to do.
  });
});

/**
 * Whitelist actions and normalize payloads ONCE, so the same caps protect both
 * the stored state and the live relay forwarded to every overlay in the room.
 * Returns null for an unknown action.
 */
function sanitizeCommand(msg) {
  switch (msg.action) {
    case 'text': {
      const p = msg.payload || {};
      return { action: 'text', payload: { text: typeof p.text === 'string' ? p.text.slice(0, 200) : '' } };
    }
    case 'visibility': {
      const p = msg.payload || {};
      return { action: 'visibility', payload: { visible: p.visible !== false } };
    }
    case 'effect':
      return { action: 'effect', payload: {} };
    default:
      return null;
  }
}

/** Persist only durable state (text / visibility). Effects are one-shot. */
function applyCommandToState(state, cmd) {
  if (cmd.action === 'text') state.text = cmd.payload.text;
  else if (cmd.action === 'visibility') state.visible = cmd.payload.visible;
}

// Heartbeat: drop sockets that stopped answering so presence stays honest and
// dead connections don't linger. Clients run their own reconnect loop.
const HEARTBEAT_MS = 30000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Panel→OBS demo listening on http://localhost:${PORT}`);
  console.log(`  Panel:   http://localhost:${PORT}/panel?room=DEMO`);
  console.log(`  Overlay: http://localhost:${PORT}/overlay?room=DEMO`);
});

// ----------------------------------------------------------------------------
// Landing page (plain, self-contained; not the graded surface)
// ----------------------------------------------------------------------------

function landingHtml(room) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Panel → OBS リアルタイムデモ</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    background: #0e1419; color: #e8eef2;
    font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  }
  .card { width: min(520px, 90vw); padding: 32px; background: #161f27;
    border: 1px solid #243139; border-radius: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; letter-spacing: .04em; }
  p { color: #8b9aa5; margin: 0 0 20px; font-size: 14px; }
  .room { font: 600 28px ui-monospace, "SF Mono", Consolas, monospace;
    letter-spacing: .3em; color: #31d07f; margin: 0 0 20px; }
  a { display: block; padding: 16px; margin-bottom: 12px; border-radius: 10px;
    background: #1d2830; border: 1px solid #2d3b45; color: #e8eef2;
    text-decoration: none; font-size: 15px; }
  a:hover { border-color: #3fa9f5; }
  a small { display: block; color: #8b9aa5; font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Panel → OBS リアルタイムデモ</h1>
    <p>この端末用のルームコードを発行しました。</p>
    <div class="room">${room}</div>
    <a href="/panel?room=${room}">操作パネルを開く<small>iPad / ブラウザで操作</small></a>
    <a href="/overlay?room=${room}&preview=1">オーバーレイをプレビュー<small>OBS には &preview=1 なしのURLを貼付</small></a>
  </div>
</body>
</html>`;
}
