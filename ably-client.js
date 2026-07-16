'use strict';

/**
 * Ably-backed realtime client.
 *
 * Exposes the SAME surface as the old ws RealtimeLink (on/send/connect/close/
 * isOpen/id) so the panel and overlay controllers are unchanged. Ably provides
 * the room channel, presence, reconnection, and global-edge delivery — so there
 * is no relay server to run, which is what lets this deploy on Vercel.
 *
 * Message shapes emitted to controllers match the old server exactly:
 *   { type:'cmd', id, action, payload, origin }   (to overlays)
 *   { type:'ack', id }                            (to panels)
 *   { type:'presence', panels, overlays }         (to both)
 *   { type:'state', state:{ text, visible } }     (to overlays, on (re)sync)
 *
 * The latency measurement is unchanged and still honest: the panel stamps t0
 * and reads the elapsed time itself when the overlay's ack returns. Ably is
 * only the transport; the number is a real panel→overlay→panel round trip.
 */

(function (global) {
  function getParam(name, fallback) {
    const v = new URLSearchParams(location.search).get(name);
    return v == null || v === '' ? fallback : v;
  }

  function afterPaint(cb) {
    requestAnimationFrame(() => requestAnimationFrame(cb));
  }

  // Ably connection states → our four status labels.
  const STATUS = {
    initialized: 'connecting',
    connecting: 'connecting',
    connected: 'open',
    disconnected: 'reconnecting',
    suspended: 'reconnecting',
    closing: 'closed',
    closed: 'closed',
    failed: 'closed',
  };

  class RealtimeLink {
    constructor({ role, room }) {
      this.role = role;
      this.room = room;
      this.channelName = 'room:' + room;
      // Presence requires a clientId; generate a stable one per page load.
      this.clientId = role + '-' + Math.random().toString(36).slice(2, 10);
      this.handlers = { open: [], close: [], message: [], status: [] };
      this.id = null;
      // The panel is the source of truth for durable state; it publishes this
      // into its presence data so a late-joining overlay can sync immediately.
      this.state = { text: '', visible: true };
      this.ably = null;
      this.channel = null;
    }

    on(event, fn) {
      if (this.handlers[event]) this.handlers[event].push(fn);
      return this;
    }
    _emit(event, arg) {
      for (const fn of this.handlers[event] || []) fn(arg);
    }

    isOpen() {
      return !!this.ably && this.ably.connection.state === 'connected';
    }

    connect() {
      this._emit('status', 'connecting');

      // Token auth: the browser never sees the Ably API key — it fetches a
      // short-lived token scoped to just this room's channel.
      this.ably = new global.Ably.Realtime({
        authUrl: '/api/ably-token',
        authParams: { room: this.room },
        clientId: this.clientId,
        // echo is fine: neither role subscribes to what it publishes.
        echoMessages: true,
      });

      const conn = this.ably.connection;
      conn.on((change) => {
        if (change.current === 'connected') this.id = conn.id; // origin id
        this._emit('status', STATUS[change.current] || change.current);
        if (change.current === 'connected') this._emit('open');
        if (['disconnected', 'suspended', 'failed', 'closed'].includes(change.current)) {
          this._emit('close');
        }
      });

      this.channel = this.ably.channels.get(this.channelName);

      if (this.role === 'overlay') {
        this.channel.subscribe('cmd', (m) => {
          const d = m.data || {};
          this._emit('message', {
            type: 'cmd',
            id: d.id,
            action: d.action,
            payload: d.payload || {},
            origin: d.origin,
          });
        });
      } else {
        this.channel.subscribe('ack', (m) => {
          this._emit('message', { type: 'ack', id: (m.data || {}).id });
        });
      }

      // Presence: enter once connected, then keep counts fresh and sync state.
      conn.once('connected', async () => {
        try {
          await this.channel.presence.enter(this._enterData());
          await this._refreshPresence();
          if (this.role === 'overlay') {
            // Pull current state from an already-present panel (late join).
            const members = await this.channel.presence.get();
            const panel = members.find((x) => x.data && x.data.role === 'panel');
            if (panel) this._syncFromPanel(panel.data);
          }
        } catch (_) {
          /* presence is best-effort */
        }
      });

      this.channel.presence.subscribe((member) => {
        this._refreshPresence();
        // A panel appearing (re)syncs the overlay's initial state. We deliberately
        // ignore 'update'/'leave' — live text/visibility changes come via 'cmd',
        // so re-emitting state here would double-render.
        if (
          this.role === 'overlay' &&
          (member.action === 'enter' || member.action === 'present') &&
          member.data &&
          member.data.role === 'panel'
        ) {
          this._syncFromPanel(member.data);
        }
      });
    }

    _enterData() {
      return this.role === 'panel'
        ? { role: 'panel', text: this.state.text, visible: this.state.visible }
        : { role: 'overlay' };
    }

    _syncFromPanel(data) {
      this._emit('message', {
        type: 'state',
        state: { text: (data && data.text) || '', visible: !(data && data.visible === false) },
      });
    }

    async _refreshPresence() {
      try {
        const members = await this.channel.presence.get();
        let panels = 0;
        let overlays = 0;
        for (const m of members) {
          if (m.data && m.data.role === 'overlay') overlays++;
          else panels++;
        }
        this._emit('message', { type: 'presence', panels, overlays });
      } catch (_) {
        /* ignore */
      }
    }

    send(obj) {
      if (!this.channel || !this.isOpen()) return false;

      if (obj.type === 'cmd') {
        this.channel.publish('cmd', {
          id: obj.id,
          action: obj.action,
          payload: obj.payload || {},
          origin: this.id, // panel's connectionId; ack echoes it back
        });
        // Keep presence state fresh so a later overlay syncs correctly.
        if (obj.action === 'text') this.state.text = (obj.payload && obj.payload.text) || '';
        if (obj.action === 'visibility') this.state.visible = !(obj.payload && obj.payload.visible === false);
        if (obj.action === 'text' || obj.action === 'visibility') {
          this.channel.presence.update({ role: 'panel', text: this.state.text, visible: this.state.visible });
        }
        return true;
      }

      if (obj.type === 'ack') {
        this.channel.publish('ack', { id: obj.id, origin: obj.origin });
        return true;
      }
      return false;
    }

    close() {
      if (this.ably) this.ably.close();
    }
  }

  global.RealtimeLink = RealtimeLink;
  global.rt = { getParam, afterPaint };
})(window);
