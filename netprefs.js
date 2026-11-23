// ============================================================================
// "Data & speed saver" panel (Videos tab). Settings are stored in
// chrome.storage.local.netPrefs and read live by background.js.
// ============================================================================
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DEFAULTS = { quality: '720', pace: 'realtime', realtimeFactor: 0.8, speedKBps: 250, parallel: 1, delaySec: 60, dailyLimitMB: 1500 };
  let prefs = Object.assign({}, DEFAULTS);
  if (!$('net-panel')) return;

  // Speed steps for "By video length": download time = factor × video length.
  const STEPS = [
    { f: 1.0,  name: 'Very slow' },
    { f: 0.8,  name: 'Like watching' },
    { f: 0.6,  name: 'A bit faster' },
    { f: 0.5,  name: 'Half time' },
    { f: 0.33, name: 'One-third time' },
    { f: 0.25, name: 'Quarter time' }
  ];
  const stepIndex = (f) => { let best = 1, d = 9; STEPS.forEach((s, i) => { const x = Math.abs(s.f - f); if (x < d) { d = x; best = i; } }); return best; };
  const fmtMin = (m) => { if (m >= 1) { const w = Math.floor(m), s = Math.round((m - w) * 60); return s ? (s === 30 ? w + '½ min' : w + ' min ' + s + ' s') : w + ' min'; } return Math.round(m * 60) + ' s'; };

  const clamp = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return isNaN(n) ? dflt : Math.min(hi, Math.max(lo, n)); };

  function save() {
    chrome.storage.local.set({ netPrefs: prefs });
    paint();
  }

  function paint() {
    $('net-quality').value = prefs.quality;
    $('net-pace').value = prefs.pace;
    $('net-speed').value = prefs.speedKBps;
    $('net-par').value = prefs.parallel;
    $('net-delay').value = prefs.delaySec;
    $('net-limit').value = prefs.dailyLimitMB;
    $('net-speed-wrap').style.opacity = prefs.pace === 'limit' ? '1' : '0.45';
    const si = stepIndex(prefs.realtimeFactor || 0.8);
    $('net-factor').value = si;
    $('net-factor-name').textContent = STEPS[si].name;
    $('net-factor-text').textContent = '5-min video ≈ ' + fmtMin(5 * STEPS[si].f) + ' · 10-min ≈ ' + fmtMin(10 * STEPS[si].f);
    $('net-factor-wrap').hidden = prefs.pace !== 'realtime';
    $('net-speed-mb').textContent = '(≈ ' + (prefs.speedKBps * 60 / 1024).toFixed(prefs.speedKBps < 170 ? 1 : 0) + ' MB/min)';
    $('net-par-wrap').style.opacity = prefs.pace === 'realtime' ? '0.45' : '1';
    const q = prefs.quality === 'best' ? 'best' : prefs.quality === 'lowest' ? 'lowest' : prefs.quality + 'p';
    const sp = prefs.pace === 'realtime' ? STEPS[stepIndex(prefs.realtimeFactor || 0.8)].name.toLowerCase() : prefs.pace === 'limit' ? prefs.speedKBps + ' KB/s' : 'full speed';
    $('net-summary').textContent = '— ' + q + ' · ' + sp + (prefs.delaySec ? ' · ' + prefs.delaySec + 's wait' : '');
  }

  function refreshUsage() {
    chrome.runtime.sendMessage({ action: 'getNetStats' }, (r) => {
      void chrome.runtime.lastError;
      if (!r) return;
      const used = r.usedMB || 0;
      const lim = r.limitMB || 0;
      $('net-used').textContent = 'Used today: ' + used.toFixed(used < 10 ? 1 : 0) + ' MB' + (lim ? ' of ' + lim + ' MB' : ' (no limit)');
      const pct = lim ? Math.min(100, used / lim * 100) : 0;
      const fill = $('net-bar-fill');
      fill.style.width = pct + '%';
      fill.className = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
    });
  }

  $('net-quality').addEventListener('change', (e) => { prefs.quality = e.target.value; save(); });
  $('net-factor').addEventListener('input', (e) => { prefs.realtimeFactor = STEPS[clamp(e.target.value, 0, 5, 1)].f; paint(); });
  $('net-factor').addEventListener('change', (e) => { prefs.realtimeFactor = STEPS[clamp(e.target.value, 0, 5, 1)].f; save(); });
  $('net-pace').addEventListener('change', (e) => { prefs.pace = e.target.value; save(); });
  $('net-speed').addEventListener('change', (e) => { prefs.speedKBps = clamp(e.target.value, 16, 10000, 250); save(); });
  $('net-par').addEventListener('change', (e) => { prefs.parallel = clamp(e.target.value, 1, 5, 1); save(); });
  $('net-delay').addEventListener('change', (e) => { prefs.delaySec = clamp(e.target.value, 0, 1800, 60); save(); });
  $('net-limit').addEventListener('change', (e) => { prefs.dailyLimitMB = clamp(e.target.value, 0, 100000, 1500); save(); refreshUsage(); });
  $('net-reset').addEventListener('click', () => {
    if (!confirm('Reset today\'s data counter to 0 MB?')) return;
    chrome.runtime.sendMessage({ action: 'resetDataUsage' }, () => { void chrome.runtime.lastError; refreshUsage(); });
  });

  chrome.storage.local.get('netPrefs', (d) => {
    prefs = Object.assign({}, DEFAULTS, d.netPrefs || {});
    paint();
    refreshUsage();
  });
  setInterval(refreshUsage, 3000);
})();
