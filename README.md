# Panel → OBS Real-Time Demo

A browser control panel that drives an **OBS Browser Source** overlay in real
time, with a **live latency readout** (「反映まで 42ms」).

Static pages hosted on **Vercel**; the realtime channel runs over **Ably**
(rooms, presence, global-edge delivery). No relay server to run, no database.
Generic and reusable — no gift detection, no persistence, no theme-specific 演出.

## Architecture

```
[Panel: iPad / browser] ──┐                         ┌── [Overlay: OBS Browser Source]
                          │   Ably channel           │
                          ├──►  room:XXXX  ◄─────────┤
                          │  (cmd / ack / presence)  │
   ▲ latency readout ─────┘                          └──── ack after paint
```

- **Static pages on Vercel** — `panel.html`, `overlay.html`, and their JS/CSS.
- **`/api/ably-token`** — a Vercel function that mints a short-lived Ably token
  scoped to one room. The Ably API key stays server-side; the browser never sees it.
- **Ably** carries the realtime messages on a per-room channel (`room:XXXX`).
  Rooms, presence (connection indicator), and reconnection are Ably-native.
- **State re-sync** (text / visibility) rides on the panel's Ably **presence
  data**, so a freshly opened OBS overlay picks up the current state with no store.

### How the latency number stays honest

Ably is only the transport — the measurement is unchanged:

1. Panel stamps `t0` (monotonic `performance.now()`) and publishes the command.
2. Overlay applies it and acks **after the frame has painted** (double rAF).
3. Panel matches the ack by id and reads `performance.now() - t0`.

It is a real panel→overlay→panel round trip, measured entirely on the panel's
clock. With several overlays connected, the panel reports the **slowest** ack,
so a faster preview tab can't deflate the headline number.

## Deploy (Vercel)

1. Create a free **[Ably](https://ably.com)** account (no card) → copy an API key.
2. In the Vercel project, set env var **`ABLY_API_KEY`** to that key.
3. Deploy. Vercel serves the static pages and builds the `/api/ably-token` function.

Public URLs:

- Panel:   `https://<app>.vercel.app/panel?room=XXXX`
- Overlay: `https://<app>.vercel.app/overlay?room=XXXX`  (`&preview=1` to preview in a browser)

## OBS setup note for the client (Japanese)

> OBS → ソース → ＋ → 「ブラウザ」 → URL に **オーバーレイのURL** を貼付 →
> 幅 **1920** / 高さ **1080** → OK。
> 表示が更新されないときは、ソースのプロパティで
> 「現在のページのキャッシュを削除」を押してください。
> 背景は透過で表示されます（`?preview=1` を付けると確認用の背景が出ます）。

## Files

| File | Role |
| --- | --- |
| `index.html` | Landing — mints a room code, links to both pages |
| `panel.*` | Operator control surface (the graded UI) |
| `overlay.*` | OBS Browser Source overlay |
| `ably-client.js` | `RealtimeLink` over Ably — same surface both pages use |
| `api/ably-token.js` | Serverless token mint (keeps the Ably key server-side) |
| `vercel.json` | Rewrites + cache headers |
