# Panel → OBS Real-Time Demo

A browser control panel that drives an **OBS Browser Source** overlay in real
time, with a **live latency readout** (「反映まで 42ms」). One Node process
serves both pages and the WebSocket from a single origin.

This is a generic, reusable panel→OBS control demo — no gift detection, no
persistence, no theme-specific 演出. It proves one thing: a panel action reaches
OBS in well under 100 ms, and you can watch the number.

## Run locally

```bash
npm install
npm start
# → http://localhost:3000
```

Open the landing page at `/` to get a room code, or go straight to:

- **Panel:**   `http://localhost:3000/panel?room=DEMO`
- **Overlay:** `http://localhost:3000/overlay?room=DEMO`  (add `&preview=1` to preview in a browser)

Open the panel and the overlay side by side, type some text, hit **反映**, and
watch the overlay update and the latency number move.

## Architecture

```
[Panel: iPad / browser]  ──WS──►  [Node server]  ──WS──►  [Overlay: OBS Browser Source]
        ▲                                                          │
        └──────────────────── ack (latency readout) ──────────────┘
```

- **Node + Express** serves `/panel` and `/overlay`.
- **`ws`** is the realtime channel at `/ws?room=XXXX&role=panel|overlay`.
- **Vanilla JS** on both pages — no framework, fast first paint.
- **Rooms** namespace every session (`?room=XXXX`) so sessions never collide.
- Per-room state (text / visibility) is held **in memory** so a freshly opened
  OBS source — or a reconnecting panel — immediately re-syncs. No database.

### How the latency number is honest

The round trip is measured entirely on the **panel's own clock**:

1. Panel stamps `t0` and sends the command with a unique id.
2. Overlay applies the change and acks **after the frame has painted** (double
   `requestAnimationFrame`) — real on-screen time, not just a DOM mutation.
3. Server routes the ack back to the exact panel that fired it (`origin` id).
4. Panel reads `performance.now() - t0`.

The overlay's clock never enters the calculation, so there is no clock-sync
error. `performance.now()` is monotonic, so the reading can't jump if the
system clock is adjusted mid-demo.

### Reconnection

Both pages run an auto-reconnect loop (exponential backoff + jitter, plus an
immediate retry on `online` / tab-focus). The server heartbeats every 30 s and
drops dead sockets so the panel's OBS-connection indicator stays truthful. If
the socket dies mid-demo, it comes back on its own.

## Deploy

Deploy to a host with **persistent processes** — **Railway, Render, or Fly.io**.
Do **not** use Vercel serverless: serverless functions don't hold long-lived
WebSocket connections, and cold starts would lag the very first interaction.

Any of these works with zero config beyond `npm start` and the `PORT` env var
(the server already reads `process.env.PORT`):

- **Render:** New → Web Service → build `npm install`, start `npm start`.
- **Railway:** New Project → Deploy from repo → it auto-detects Node.
- **Fly.io:** `fly launch` → accept the Node defaults → `fly deploy`.

Then the public URLs are:

- Panel:   `https://<your-app>/panel?room=XXXX`
- Overlay: `https://<your-app>/overlay?room=XXXX`

## OBS setup note for the client (Japanese)

> OBS → ソース → ＋ → 「ブラウザ」 → URL に **オーバーレイのURL** を貼付 →
> 幅 **1920** / 高さ **1080** → OK。
> 表示が更新されないときは、ソースのプロパティで
> 「現在のページのキャッシュを削除」を押してください。
> 背景は透過で表示されます（`?preview=1` を付けると確認用の背景が出ます）。

## Files

| File | Role |
| --- | --- |
| `server.js` | Express + `ws`; room relay, in-memory state, heartbeat |
| `public/shared.js` | `RealtimeLink` — reconnecting socket used by both pages |
| `public/panel.*` | Operator control surface (the graded UI) |
| `public/overlay.*` | OBS Browser Source overlay |
