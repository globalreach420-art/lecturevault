// ============================================================================
// Autopilot tab (popup side). The real work runs in autopilot.js in the
// background, so closing this popup does not stop anything.
// ============================================================================
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  if (!$('tab-auto')) return;
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  let tabId = null;
  let state = null;

  function render() {
    if (!state || !state.ap) return;
    const ap = state.ap;
    const running = !!(state.active || ap.running);
    $('ap-start').hidden = running;
    $('ap-stop').hidden = !running;
    $('ap-scan').disabled = running; $('ap-add').disabled = running; $('ap-clear').disabled = running;
    $('ap-dot').hidden = !running;
    $('ap-state').textContent = running ? 'Running' : (ap.courses.some((c) => c.on && c.status !== 'done') && ap.stats.lectures ? 'Paused' : 'Idle');
    $('ap-state').className = 'ap-state' + (running ? ' on' : '');
    $('ap-status').textContent = ap.status || '';
    $('ap-path-name').textContent = ap.pathName || (ap.courses.length ? 'Queued courses' : 'No learning path scanned yet');

    const lv = state.live;
    $('ap-live').hidden = !lv;
    if (lv) {
      $('ap-live-title').textContent = lv.lecture + '  ·  ' + lv.course;
      $('ap-live-bar').style.width = Math.min(100, (lv.pos / Math.max(1, lv.targetSec)) * 100) + '%';
      $('ap-live-meta').textContent = 'Watched ' + fmt(lv.pos) + ' of ' + fmt(lv.targetSec) + ' (' + lv.pct + '% of ' + fmt(lv.durSec) + ')' + (lv.quality ? ' · ' + lv.quality : '');
    }
    const on = ap.courses.filter((c) => c.on);
    const doneN = on.filter((c) => c.status === 'done').length;
    // overall progress
    $('ap-prog-all').hidden = !on.length;
    if (on.length) {
      const cur = on.find((c) => c.status === 'running');
      $('ap-prog-all-txt').textContent = doneN + ' of ' + on.length + ' courses' + (cur ? ' · now: ' + cur.name : '');
      $('ap-prog-all-bar').style.width = Math.round(doneN / on.length * 100) + '%';
    }
    // video download in the background
    const v = state.video;
    const pend = state.vidPending || 0;
    $('ap-prog-vid').hidden = !(v || pend);
    if (v || pend) {
      $('ap-prog-vid-name').textContent = v ? 'Video: ' + v.name : 'Video downloads';
      $('ap-prog-vid-txt').textContent = (v ? Math.round(v.percent) + '%' : '') + (pend ? (v ? ' · ' : '') + pend + ' in queue' : '');
      $('ap-prog-vid-bar').style.width = (v ? Math.min(100, v.percent) : 0) + '%';
      $('ap-prog-vid-meta').textContent = v ? v.text : 'Starting the next video ...';
    }
    // last download-related message (so problems are visible without opening the log)
    const last = (ap.log || []).slice().reverse().find((l) => /Transcript|transcript|Video|video/.test(l));
    $('ap-last').textContent = last || '';
    $('ap-last').className = 'ap-last' + (last && /⚠️/.test(last) ? ' warn' : '');
    $('ap-stats').textContent = on.length
      ? doneN + '/' + on.length + ' courses done · ' + ap.stats.lectures + ' lectures watched · ' + ap.stats.txt + ' transcripts' + (ap.settings && ap.settings.autoVid ? ' · ' + (ap.stats.videos || 0) + ' videos' : '') + ' saved'
      : '';

    const list = $('ap-list');
    list.textContent = '';
    if (!ap.courses.length) {
      list.appendChild(el('div', 'empty-state', 'Open the INE learning path page, scroll to the bottom once, then press "Scan this learning path".'));
    }
    let lastSec = null;
    ap.courses.forEach((c, i) => {
      if (c.section && c.section !== lastSec) {
        lastSec = c.section;
        list.appendChild(el('div', 'ap-sec', (c.sectionNo ? 'Section ' + c.sectionNo + ' · ' : '') + c.section));
      }
      const row = el('label', 'ap-row' + (c.status === 'running' ? ' cur' : ''));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!c.on; cb.disabled = running;
      cb.addEventListener('change', async () => { await send({ action: 'ap:toggle', index: i, on: cb.checked }); refresh(); });
      const icon = c.status === 'done' ? '✅' : c.status === 'running' ? '⏳' : c.status === 'error' ? '⚠️' : '⬜';
      row.appendChild(cb);
      row.appendChild(el('span', 'ap-icon', icon));
      const name = el('span', 'ap-name', c.name);
      if (c.type && c.type !== 'course') name.appendChild(el('span', 'ap-type', ' ' + c.type));
      row.appendChild(name);
      const meta = (c.done && c.done.length ? c.done.length + ' watched' : '') + (c.pct ? (c.done && c.done.length ? ' · ' : '') + Math.round(c.pct) + '% on INE' : '');
      row.appendChild(el('span', 'ap-meta', meta));
      if (!running && (c.status === 'done' || c.status === 'error')) {
        const redo = el('button', 'mini', 'Redo'); redo.title = 'Run this course again from its first lecture';
        redo.addEventListener('click', async (e) => { e.preventDefault(); await send({ action: 'ap:redo', index: i }); refresh(); });
        row.appendChild(redo);
      }
      list.appendChild(row);
    });
    $('ap-log').textContent = (ap.log || []).slice().reverse().join('\n');

    const s = ap.settings || {};
    if (document.activeElement !== $('ap-min')) $('ap-min').value = s.minPct;
    if (document.activeElement !== $('ap-max')) $('ap-max').value = s.maxPct;
    if (document.activeElement !== $('ap-maxday')) $('ap-maxday').value = s.maxPerDay != null ? s.maxPerDay : 0;
    const TSTEPS = [0, 30, 60, 90, 120, 180, 240, 360, 480];
    const tlab = (m) => (m === 0 ? 'Off' : m < 60 ? m + ' min' : (m % 60 ? Math.floor(m / 60) + '½ h' : (m / 60) + ' h'));
    const curMin = s.runLimitMin || 0;
    let ti = TSTEPS.indexOf(curMin); if (ti < 0) ti = 0;
    if (document.activeElement !== $('ap-time')) $('ap-time').value = ti;
    $('ap-time-name').textContent = 'Stop after: ' + tlab(curMin);
    const left = state.runEndsAt && running ? Math.max(0, state.runEndsAt - Date.now()) : 0;
    $('ap-time-text').textContent = curMin === 0 ? 'runs until you press Stop'
      : left ? '⏱ stops in ' + Math.floor(left / 3600000) + ' h ' + String(Math.floor(left / 60000) % 60).padStart(2, '0') + ' min'
      : 'counted from when you press Start / Resume';
    $('ap-today').textContent = 'Today: ' + (state.today || 0) + ' lecture' + (state.today === 1 ? '' : 's') +
      (state.blockedUntil && state.blockedUntil > Date.now() ? ' · ⛔ INE limit — blocked until ' + new Date(state.blockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
    $('ap-lowq').checked = s.lowestQuality !== false;
    $('ap-mute').checked = s.mute !== false;
    $('ap-txt').checked = s.autoTxt !== false;
    $('ap-vid').checked = !!s.autoVid;
    $('ap-skip').checked = !!s.skipWatched;
  }

  async function refresh() { state = await send({ action: 'ap:state' }); render(); }
  const flash = (t) => { $('ap-status').textContent = t; };

  $('ap-scan').addEventListener('click', async () => {
    flash('Reading the learning path ...');
    const r = await send({ action: 'ap:scan', tabId });
    if (!r || !r.ok) flash((r && r.error) || 'No response'); else refresh();
  });
  $('ap-add').addEventListener('click', async () => {
    const r = await send({ action: 'ap:addCourse', tabId });
    if (!r || !r.ok) flash((r && r.error) || 'No response'); else refresh();
  });
  $('ap-start').addEventListener('click', async () => {
    const r = await send({ action: 'ap:start', tabId });
    if (!r || !r.ok) flash((r && r.error) || 'No response'); else refresh();
  });
  $('ap-stop').addEventListener('click', async () => { flash('Stopping ...'); await send({ action: 'ap:stop' }); setTimeout(refresh, 600); });
  $('ap-clear').addEventListener('click', async () => {
    if (!confirm('Empty the autopilot queue? (Downloaded files are not touched.)')) return;
    await send({ action: 'ap:clear' }); refresh();
  });
  $('ap-all').addEventListener('click', async () => { await send({ action: 'ap:all', on: true, coursesOnly: true }); refresh(); });
  $('ap-none').addEventListener('click', async () => { await send({ action: 'ap:all', on: false }); refresh(); });

  const saveSettings = async () => {
    const min = Math.max(5, Math.min(95, parseInt($('ap-min').value, 10) || 35));
    const max = Math.max(min, Math.min(95, parseInt($('ap-max').value, 10) || 60));
    await send({ action: 'ap:settings', settings: { minPct: min, maxPct: max, lowestQuality: $('ap-lowq').checked, mute: $('ap-mute').checked,
      autoTxt: $('ap-txt').checked, maxPerDay: Math.max(0, Math.min(500, parseInt($('ap-maxday').value, 10) || 0)), autoVid: $('ap-vid').checked, skipWatched: $('ap-skip').checked } });
    refresh();
  };
  $('ap-time').addEventListener('input', () => { const m = [0, 30, 60, 90, 120, 180, 240, 360, 480][+$('ap-time').value] || 0; $('ap-time-name').textContent = 'Stop after: ' + (m === 0 ? 'Off' : m < 60 ? m + ' min' : (m % 60 ? Math.floor(m / 60) + '½ h' : (m / 60) + ' h')); });
  $('ap-time').addEventListener('change', async () => { await send({ action: 'ap:settings', settings: { runLimitMin: [0, 30, 60, 90, 120, 180, 240, 360, 480][+$('ap-time').value] || 0 } }); refresh(); });
  ['ap-min', 'ap-max', 'ap-maxday', 'ap-lowq', 'ap-mute', 'ap-txt', 'ap-vid', 'ap-skip'].forEach((id) => $(id).addEventListener('change', saveSettings));

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.action !== 'autopilotProgress') return;
    if (state) { state.live = m.live || null; if (m.status && state.ap) state.ap.status = m.status; }
    if (m.done) refresh(); else render();
  });

  (async function init() {
    try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t ? t.id : null; } catch (e) { /* ignore */ }
    refresh();
    setInterval(refresh, 4000);
  })();
})();
