'use strict';

/**
 * Overlay controller (OBS Browser Source).
 *
 * Applies commands relayed from the panel, then acks *after the frame has
 * painted* (rt.afterPaint = double rAF) so the latency the panel reports is
 * honest on-screen time, not just the moment the DOM changed.
 */

(function () {
  const room = rt.getParam('room', 'DEMO').toUpperCase();
  const preview = rt.getParam('preview', null) !== null;
  const link = new RealtimeLink({ role: 'overlay', room });

  const stage = document.getElementById('stage');
  const titleCard = document.getElementById('titleCard');
  const titleText = document.getElementById('titleText');
  const toastLayer = document.getElementById('toastLayer');
  const previewRoom = document.getElementById('previewRoom');
  const previewConn = document.getElementById('previewConn');

  if (preview) {
    document.body.classList.add('preview');
    previewRoom.textContent = `room ${room}`;
    fitPreview();
    window.addEventListener('resize', fitPreview);
  }

  // In preview we scale the fixed 1920×1080 stage to fit the browser window.
  // OBS renders the source at native resolution, so this only runs for preview.
  function fitPreview() {
    const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = `scale(${scale})`;
  }

  // ---- rendering ----------------------------------------------------------

  function renderText(text) {
    const t = (text || '').trim();
    if (t) {
      titleText.textContent = t;
      titleCard.dataset.empty = 'false';
      titleCard.setAttribute('aria-hidden', 'false');
      titleCard.classList.remove('enter');
      void titleCard.offsetWidth; // restart entrance animation
      titleCard.classList.add('enter');
    } else {
      titleCard.dataset.empty = 'true';
      titleCard.setAttribute('aria-hidden', 'true');
    }
  }

  function setVisible(visible) {
    stage.dataset.visible = String(visible);
  }

  // Generic sample notification card. Deliberately neutral — not a letter,
  // not a bottle, nothing from the client's world-view (CLAUDE.md §2/§6).
  function playEffect() {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML =
      '<div class="toast-icon" aria-hidden="true"></div>' +
      '<div class="toast-body">' +
      '<div class="toast-title">サンプル演出</div>' +
      '<div class="toast-sub">リアルタイム通知カード</div>' +
      '</div>';
    toastLayer.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    const HOLD_MS = 3400;
    setTimeout(() => {
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 600);
    }, HOLD_MS);

    return toast;
  }

  // ---- command handling ---------------------------------------------------

  function applyCommand(msg) {
    switch (msg.action) {
      case 'text':
        renderText(msg.payload && msg.payload.text);
        break;
      case 'visibility':
        setVisible(!(msg.payload && msg.payload.visible === false));
        break;
      case 'effect':
        playEffect();
        break;
    }
    // Ack once the change has actually painted.
    rt.afterPaint(() => {
      link.send({ type: 'ack', id: msg.id, origin: msg.origin });
    });
  }

  // Initial / reconnect sync — apply state with no animation fuss and no ack
  // (there is no command id to ack).
  function applyState(state) {
    if (!state) return;
    setVisible(state.visible !== false);
    if (typeof state.text === 'string') renderText(state.text);
  }

  // ---- wiring -------------------------------------------------------------

  link.on('message', (msg) => {
    switch (msg.type) {
      case 'cmd':
        applyCommand(msg);
        break;
      case 'state':
        applyState(msg.state);
        break;
      case 'presence':
        if (preview) {
          previewConn.textContent = `panel ${msg.panels} · overlay ${msg.overlays}`;
        }
        break;
    }
  });

  link.on('status', (state) => {
    if (preview && state !== 'open') previewConn.textContent = state;
  });

  link.connect();
})();
