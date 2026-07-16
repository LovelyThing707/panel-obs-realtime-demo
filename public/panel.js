'use strict';

/**
 * Panel controller.
 *
 * Fires commands at the overlay and measures the round trip. The latency
 * number is computed entirely on the panel's own clock: we stamp t0 when a
 * command leaves, the overlay echoes the command id back after it has painted,
 * and we read the elapsed time here. The overlay's clock never enters the
 * calculation, so there is no clock-sync error to apologise for.
 */

(function () {
  const room = rt.getParam('room', 'DEMO').toUpperCase();
  const link = new RealtimeLink({ role: 'panel', room });

  // --- elements ---
  const el = {
    roomCode: document.getElementById('roomCode'),
    wsPill: document.getElementById('wsPill'),
    obsPill: document.getElementById('obsPill'),
    telemetry: document.getElementById('telemetry'),
    latencyValue: document.getElementById('latencyValue'),
    latencyCaption: document.getElementById('latencyCaption'),
    latencyMin: document.getElementById('latencyMin'),
    latencyLast: document.getElementById('latencyLast'),
    spark: document.getElementById('spark'),
    textInput: document.getElementById('textInput'),
    textBtn: document.getElementById('textBtn'),
    effectBtn: document.getElementById('effectBtn'),
    showBtn: document.getElementById('showBtn'),
    hideBtn: document.getElementById('hideBtn'),
    copyOverlay: document.getElementById('copyOverlay'),
    copyHint: document.getElementById('copyHint'),
  };

  el.roomCode.textContent = room;

  // --- latency state ---
  const pending = new Map(); // cmdId -> { t0, timer }
  const ACK_TIMEOUT_MS = 2500;
  const history = []; // recent round trips (ms)
  let latencyMin = Infinity;
  let overlaysConnected = 0;

  let cmdSeq = 0;
  function nextId() {
    // Unique per panel session; combined with the server-assigned origin id it
    // is unambiguous even with two panels in one room.
    return `${link.id || 'p'}-${++cmdSeq}`;
  }

  function fire(action, payload) {
    const id = nextId();
    const t0 = performance.now();

    // Optimistic, instant feedback — do not wait for the ack.
    el.telemetry.dataset.tally = 'firing';

    const ok = link.send({ type: 'cmd', id, action, payload: payload || {} });
    if (!ok) {
      setCaption('未接続 — コマンドを送信できません');
      el.telemetry.dataset.tally = link.isOpen() ? 'ready' : '';
      return;
    }

    // Expect one ack per connected overlay and report the SLOWEST (max), so a
    // faster preview tab can never silently deflate the number the client is
    // actually watching in OBS. With a single overlay (the normal case) the
    // first ack finalizes immediately, keeping the readout snappy.
    const expected = Math.max(1, overlaysConnected);

    const timer = setTimeout(() => {
      const rec = pending.get(id);
      pending.delete(id);
      if (rec && rec.samples.length) {
        finalize(Math.max(...rec.samples)); // some overlays acked — report worst
      } else {
        el.telemetry.dataset.tally = link.isOpen() ? 'ready' : '';
        el.latencyValue.textContent = '--';
        setCaption(overlaysConnected > 0 ? '応答なし' : 'オーバーレイ未接続');
      }
    }, ACK_TIMEOUT_MS);

    pending.set(id, { t0, timer, samples: [], expected });
  }

  function onAck(id) {
    const rec = pending.get(id);
    if (!rec) return; // late ack after finalize/timeout — ignore
    rec.samples.push(Math.max(0, Math.round(performance.now() - rec.t0)));
    if (rec.samples.length >= rec.expected) {
      clearTimeout(rec.timer);
      pending.delete(id);
      finalize(Math.max(...rec.samples));
    }
  }

  function finalize(ms) {
    el.telemetry.dataset.tally = 'ready';
    el.latencyValue.textContent = String(ms);
    el.latencyLast.textContent = ms + 'ms';
    latencyMin = Math.min(latencyMin, ms);
    el.latencyMin.textContent = latencyMin + 'ms';
    setCaption(gradeCaption(ms));
    pushSpark(ms);
  }

  function gradeCaption(ms) {
    if (ms < 60) return '反映 — 非常に高速';
    if (ms < 120) return '反映 — 高速';
    if (ms < 250) return '反映 — 良好';
    return '反映 — ネットワーク遅延あり';
  }

  function setCaption(text) {
    el.latencyCaption.textContent = text;
  }

  function pushSpark(ms) {
    history.push(ms);
    if (history.length > 24) history.shift();
    const max = Math.max(80, ...history);
    el.spark.replaceChildren(
      ...history.map((v) => {
        const bar = document.createElement('span');
        bar.className = 'bar';
        bar.style.height = Math.max(2, Math.round((v / max) * 26)) + 'px';
        bar.style.opacity = String(0.4 + 0.6 * (1 - Math.min(1, v / max)));
        return bar;
      })
    );
  }

  // --- connection status ---
  link.on('status', (state) => {
    const map = {
      connecting: ['connecting', '接続中'],
      reconnecting: ['reconnecting', '再接続中'],
      open: ['open', '接続'],
      closed: ['closed', '切断'],
    };
    const [dataState, label] = map[state] || ['off', state];
    el.wsPill.dataset.state = dataState;
    el.wsPill.querySelector('.pill-text').textContent = label;

    if (state === 'open') {
      el.telemetry.dataset.tally = 'ready';
    } else {
      // No live link → the round-trip number is meaningless. Clear it rather
      // than leave a stale fast value implying a connection that is gone.
      el.telemetry.dataset.tally = '';
      el.latencyValue.textContent = '--';
      setCaption(state === 'reconnecting' ? '再接続中…' : '未接続');
      for (const [, rec] of pending) clearTimeout(rec.timer);
      pending.clear();
    }
  });

  link.on('message', (msg) => {
    switch (msg.type) {
      case 'ack':
        onAck(msg.id);
        break;
      case 'presence':
        overlaysConnected = msg.overlays;
        setObsPill(msg.overlays);
        break;
      case 'state':
        syncFromState(msg.state);
        break;
    }
  });

  function setObsPill(n) {
    el.obsPill.dataset.state = n > 0 ? 'on' : 'off';
    el.obsPill.querySelector('.pill-text').textContent =
      n > 0 ? `OBS 接続 ${n}` : 'OBS 未接続';
  }

  // Re-sync the panel UI to authoritative server state (on connect / reconnect).
  function syncFromState(state) {
    if (!state) return;
    if (typeof state.text === 'string' && document.activeElement !== el.textInput) {
      el.textInput.value = state.text;
    }
    setVisibilityUI(!!state.visible);
  }

  function setVisibilityUI(visible) {
    el.showBtn.setAttribute('aria-pressed', String(visible));
    el.hideBtn.setAttribute('aria-pressed', String(!visible));
  }

  // --- controls ---
  function flash(btn) {
    btn.classList.remove('flash');
    // reflow to restart the animation
    void btn.offsetWidth;
    btn.classList.add('flash');
  }

  el.textBtn.addEventListener('click', () => {
    flash(el.textBtn);
    fire('text', { text: el.textInput.value });
  });
  el.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      flash(el.textBtn);
      fire('text', { text: el.textInput.value });
    }
  });

  el.effectBtn.addEventListener('click', () => {
    flash(el.effectBtn);
    fire('effect', {});
  });

  el.showBtn.addEventListener('click', () => {
    setVisibilityUI(true);
    fire('visibility', { visible: true });
  });
  el.hideBtn.addEventListener('click', () => {
    setVisibilityUI(false);
    fire('visibility', { visible: false });
  });

  el.copyOverlay.addEventListener('click', async () => {
    const url = `${location.origin}/overlay?room=${room}`;
    try {
      await navigator.clipboard.writeText(url);
      el.copyHint.textContent = 'コピーしました';
    } catch {
      el.copyHint.textContent = url;
    }
    setTimeout(() => (el.copyHint.textContent = ''), 2600);
  });

  link.connect();
})();
