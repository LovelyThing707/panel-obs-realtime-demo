'use strict';

/**
 * Shared realtime client for the panel and overlay pages.
 *
 * RealtimeLink wraps a WebSocket with auto-reconnect (exponential backoff +
 * jitter) and surfaces a small event API. Reconnection is not optional here:
 * if the socket dies mid-demo and the overlay goes dark, the demo fails at the
 * one thing it exists to prove (CLAUDE.md §10).
 */

(function (global) {
  function getParam(name, fallback) {
    const v = new URLSearchParams(location.search).get(name);
    return v == null || v === '' ? fallback : v;
  }

  function wsUrl(role, room) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ room, role });
    return `${proto}//${location.host}/ws?${q.toString()}`;
  }

  class RealtimeLink {
    constructor({ role, room }) {
      this.role = role;
      this.room = room;
      this.ws = null;
      this.id = null;
      this.manualClose = false;

      this.attempt = 0;
      this.baseDelay = 500; // ms
      this.maxDelay = 8000; // ms
      this.reconnectTimer = null;

      this.handlers = { open: [], close: [], message: [], status: [] };

      // Try to recover the instant connectivity returns, rather than waiting
      // out the backoff timer. Gate on _isActive (not isOpen): a socket that is
      // still CONNECTING is already an in-flight attempt, so we must NOT spawn a
      // second one — an iPad waking up fires 'online' and 'visibilitychange' in
      // quick succession, and that race is exactly what would orphan a socket.
      global.addEventListener('online', () => {
        if (!this.manualClose && !this._isActive()) this._reconnectNow();
      });
      // Reconnect fast when the operator returns to the tab.
      document.addEventListener('visibilitychange', () => {
        if (
          document.visibilityState === 'visible' &&
          !this.manualClose &&
          !this._isActive()
        ) {
          this._reconnectNow();
        }
      });
    }

    on(event, fn) {
      if (this.handlers[event]) this.handlers[event].push(fn);
      return this;
    }

    _emit(event, arg) {
      for (const fn of this.handlers[event] || []) fn(arg);
    }

    isOpen() {
      return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    // "Active" = there is already a live attempt (connecting) or a live
    // connection (open). Used to coalesce overlapping reconnect triggers.
    _isActive() {
      return (
        this.ws &&
        (this.ws.readyState === WebSocket.CONNECTING ||
          this.ws.readyState === WebSocket.OPEN)
      );
    }

    connect() {
      this.manualClose = false;
      this._emit('status', this.attempt === 0 ? 'connecting' : 'reconnecting');

      let ws;
      try {
        ws = new WebSocket(wsUrl(this.role, this.room));
      } catch {
        this._scheduleReconnect();
        return;
      }

      // Retire any previous socket. `ws` becomes the authoritative connection
      // first, so the old socket's handlers — guarded below by an identity
      // check — become no-ops the instant we reassign, and closing it can't
      // trigger a reconnect. This prevents zombie duplicate connections.
      const prev = this.ws;
      this.ws = ws;
      if (prev && prev !== ws) {
        try {
          prev.close();
        } catch {
          /* ignore */
        }
      }

      // Every handler ignores events from a socket that is no longer current.
      const guard = (fn) => (ev) => {
        if (this.ws !== ws) return;
        fn(ev);
      };

      ws.addEventListener(
        'open',
        guard(() => {
          this.attempt = 0;
          this._emit('status', 'open');
          this._emit('open');
        })
      );

      ws.addEventListener(
        'message',
        guard((ev) => {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (msg.type === 'welcome') this.id = msg.id;
          this._emit('message', msg);
        })
      );

      ws.addEventListener(
        'close',
        guard(() => {
          this._emit('status', 'closed');
          this._emit('close');
          if (!this.manualClose) this._scheduleReconnect();
        })
      );

      ws.addEventListener(
        'error',
        guard(() => {
          // Surface as a close; the close handler drives the reconnect.
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        })
      );
    }

    _scheduleReconnect() {
      if (this.manualClose) return;
      clearTimeout(this.reconnectTimer);
      const delay = Math.min(this.maxDelay, this.baseDelay * Math.pow(1.8, this.attempt));
      const jittered = delay * (0.7 + Math.random() * 0.6);
      this.attempt++;
      this._emit('status', 'reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), jittered);
    }

    _reconnectNow() {
      if (this.manualClose) return; // honour an intentional close
      clearTimeout(this.reconnectTimer);
      this.attempt = 0;
      this.connect();
    }

    send(obj) {
      if (this.isOpen()) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }

    close() {
      this.manualClose = true;
      clearTimeout(this.reconnectTimer);
      if (this.ws) this.ws.close();
    }
  }

  // afterPaint runs cb after the browser has actually painted the current
  // frame — a double rAF. The overlay uses it so its render-ack reflects real
  // on-screen time, not just DOM mutation. Honest latency, not a flattering one.
  function afterPaint(cb) {
    requestAnimationFrame(() => requestAnimationFrame(cb));
  }

  global.RealtimeLink = RealtimeLink;
  global.rt = { getParam, afterPaint };
})(window);
