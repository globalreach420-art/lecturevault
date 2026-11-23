// ============================================================================
// Auto-capture bar: opens and briefly plays every lecture on the current page,
// one after another, so the Subtitles/Videos tabs fill up without you clicking
// through each lecture yourself. The actual capture still happens through the
// same network listeners background.js already uses for manual playback —
// this just does the clicking and waiting for you.
// ============================================================================
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));

  let tabId = null;

  function setRunning(running) {
    $('ac-start').hidden = running;
    $('ac-stop').hidden = !running;
    $('ac-wait').disabled = running;
  }
  function status(text, isError) {
    const s = $('ac-status');
    s.textContent = text;
    s.className = 'batch-status' + (isError ? ' error' : '');
  }

  $('ac-start').addEventListener('click', async () => {
    // Floor raised to 8s and default to 12s on purpose — slower, human-paced playback is safer
    // than the fastest setting. maxPerRun/breakEvery add randomized gaps and a longer pause every
    // few lectures, and stop the run after 20 lectures so a whole course isn't opened in one go.
    const secs = Math.max(8, Math.min(45, parseInt($('ac-wait').value, 10) || 12));
    setRunning(true);
    status('Starting — opening the first lecture on this page ...');
    const r = await send({ action: 'startAutoCapture', tabId, options: { waitMs: secs * 1000, maxPerRun: 20, breakEvery: 6 } });
    if (!r || !r.ok) { status('Could not start: ' + ((r && r.error) || 'no response'), true); setRunning(false); }
  });

  $('ac-stop').addEventListener('click', async () => {
    status('Stopping after this lecture ...');
    await send({ action: 'cancelAutoCapture' });
  });

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.action !== 'autoCaptureProgress') return;
    if (m.done) {
      setRunning(false);
      if (m.error) status(m.error, true);
      else if (m.cancelled) status('Stopped — opened ' + (m.opened || 0) + ' lecture(s). Check the Subtitles / Videos tabs.');
      else if (m.paused) status('Paused after ' + (m.opened || 0) + ' lecture(s) for this sitting — click Start again to continue from here.');
      else status('Done — opened ' + (m.opened || 0) + ' lecture(s) on this page. Check the Subtitles / Videos tabs.');
      return;
    }
    status('Capturing lecture ' + m.index + ': ' + m.name + ' — playing for a few seconds ...');
  });

  (async function init() {
    try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t ? t.id : null; } catch (e) { /* ignore */ }
    const st = await send({ action: 'autoCaptureState' });
    setRunning(!!(st && st.running));
    if (st && st.running) status('Already running from a previous click ...');
  })();
})();
