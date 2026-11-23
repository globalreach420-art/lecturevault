// ============================================================================
// Videos tab: every lecture you played (kept across page changes), grouped and
// sorted in course order like the Subtitles tab. Downloads run in the background,
// one after another, each with its .srt next to it.
// ============================================================================
(function () {
  'use strict';
  const U = window.SubUtils;
  const VLIB_KEY = 'videoLibrary';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));
  const two = (n) => String(n).padStart(2, '0');

  let vlib = [];
  let tabId = null;
  let running = false;
  const UNTICK_KEY = 'videoUnticked';   // ids you unticked; kept across popup closes (v1.11.1)
  const unticked = new Set();
  let untickTimer = null;
  const saveUnticked = () => { void untickTimer; chrome.storage.local.set({ [UNTICK_KEY]: [...unticked].slice(-3000) }); };
  class TickSet extends Set {
    add(id) { if (unticked.delete(id)) saveUnticked(); return super.add(id); }
    delete(id) { if (!unticked.has(id)) { unticked.add(id); saveUnticked(); } return super.delete(id); }
    clear() { for (const id of this) unticked.add(id); saveUnticked(); super.clear(); }
  }
  const selected = new TickSet();
  const known = new Set();
  let prefs = { folder: 'eJPT', prefix: true, withSubs: true };
  const progress = {};   // video id -> text shown on its row
  let renderPending = false;

  const sorted = () => U.sortByPlace(vlib, (v) => v.place || {});
  const opts = () => ({ prefix: prefs.prefix !== false, folder: (prefs.folder || 'eJPT').trim(), withSubs: prefs.withSubs !== false });

  function status(text, isError) { const s = $('vl-status'); s.textContent = text; s.className = 'batch-status' + (isError ? ' error' : ''); }

  function row(v, n) {
    const p = v.place || {};
    const r = el('div', 'sub-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.className = 'sel'; cb.checked = selected.has(v.id);
    cb.addEventListener('change', () => { cb.checked ? selected.add(v.id) : selected.delete(v.id); updateButtons(); });
    const num = el('div', 'sub-num', two(p.lessonIndex || n));
    num.title = 'Lecture number inside its section (used in the file name)';

    const main = el('div', 'sub-main');
    const name = el('input', 'name'); name.type = 'text'; name.spellcheck = false;
    name.value = v.userName || p.name || 'Lecture';
    name.title = 'Click to rename. This becomes the file name.';
    name.addEventListener('change', () => send({ action: 'renameVideo', id: v.id, name: name.value.trim() === p.name ? '' : name.value.trim() }));
    name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') name.blur(); });

    const meta = el('div', 'sub-meta');
    const bits = [];
    const d = U.formatDuration(v.duration); if (d) bits.push(d);
    if (v.resolution) bits.push(v.resolution + 'p');
    bits.push(/HLS/i.test(v.type || '') ? 'stream' : (v.type || '').toLowerCase());
    meta.appendChild(el('span', 'bit', bits.join(' · ')));
    if (progress[v.id]) meta.appendChild(el('span', 'bit vprog', progress[v.id]));
    main.appendChild(name); main.appendChild(meta);

    const act = el('div', 'sub-actions');
    const dl = el('button', 'mini', 'Video'); dl.title = 'Download this video (+ its .srt) into its course folder';
    dl.disabled = running;
    dl.addEventListener('click', () => startBatch([v.id]));
    const srt = el('button', 'mini', 'SRT'); srt.title = 'Save only the subtitle (.srt) into the video folder';
    srt.addEventListener('click', async () => {
      const r = await send({ action: 'prepareVideo', video: v, name: v.userName || '', options: Object.assign(opts(), { subsOnly: true }) });
      status(r && r.srt ? 'Saved .srt for ' + (v.userName || p.name) : ((r && r.error) || 'No subtitle captured for this lecture yet'), !(r && r.srt));
    });
    const x = el('button', 'mini danger', '×'); x.title = 'Remove from list';
    x.addEventListener('click', () => { selected.delete(v.id); send({ action: 'removeVideos', ids: [v.id] }); });
    act.appendChild(dl); act.appendChild(srt); act.appendChild(x);
    const bar = el('div', 'sub-bar'); bar.appendChild(el('span', 'bit', '')); bar.appendChild(act); main.appendChild(bar);

    r.appendChild(cb); r.appendChild(num); r.appendChild(main);
    return r;
  }

  function render() {
    const a = document.activeElement;
    if (a && a.classList && a.classList.contains('name') && $('vl-list').contains(a)) { renderPending = true; return; }
    renderPending = false;
    vlib.forEach((v) => { if (!unticked.has(v.id)) Set.prototype.add.call(selected, v.id); });   // new items start ticked, your unticks stay
    for (const id of [...selected]) if (!vlib.some((v) => v.id === id)) Set.prototype.delete.call(selected, id);

    const list = $('vl-list');
    list.textContent = '';
    const rows = sorted();
    if (!rows.length) {
      const empty = el('div', 'empty-state');
      empty.appendChild(el('p', 'empty-title', 'No lectures yet'));
      empty.appendChild(el('p', 'empty-desc', 'Open a lecture and let it play for 5–10 seconds. Do this for every lecture you want; they are sorted into course order here.'));
      list.appendChild(empty);
    } else {
      let lastCourse = null, lastGroup = null, n = 0;
      rows.forEach((v) => {
        const p = v.place || {};
        if ((p.course || '') !== lastCourse) {
          lastCourse = p.course || ''; lastGroup = null;
          if (lastCourse) list.appendChild(el('div', 'grp-course', '🎓 ' + U.courseDir(lastCourse).split('/').join('  ›  ')));
        }
        const g = (p.category || '') + '|' + (p.section || '');
        if (g !== lastGroup) {
          lastGroup = g; n = 0;
          const parts = [];
          if (p.category) parts.push((p.categoryIndex ? two(p.categoryIndex) + ' ' : '') + p.category);
          if (p.section) parts.push((p.sectionIndex ? two(p.sectionIndex) + ' ' : '') + p.section);
          list.appendChild(el('div', 'grp-sec' + (p.section ? '' : ' missing'), '📁 ' + (parts.length ? parts.join('  ›  ') : 'Section not found')));
        }
        list.appendChild(row(v, ++n));
      });
    }
    updateButtons();
  }

  function updateButtons() {
    const all = vlib.length;
    $('vl-count').textContent = all;
    const sel = vlib.filter((v) => selected.has(v.id)).length;
    $('vl-dl-all').textContent = 'Download all videos (' + all + ')' + (prefs.withSubs !== false ? ' + .srt' : '');
    $('vl-dl-all').disabled = running || !all;
    $('vl-dl-sel').textContent = 'Download selected (' + sel + ')';
    $('vl-dl-sel').disabled = running || !sel;
    $('vl-stop').hidden = !running;
    document.querySelectorAll('#vl-list .sub-actions button:first-child').forEach((b) => { b.disabled = running; });
  }

  async function startBatch(ids) {
    if (!ids.length || running) return;
    running = true; updateButtons();
    status('Starting ' + ids.length + ' video' + (ids.length === 1 ? '' : 's') + ' in course order ...');
    const r = await send({ action: 'downloadLibVideos', tabId, ids, options: opts() });
    running = false; updateButtons();
    if (!r || (r.error && !r.total)) { status('Failed: ' + ((r && r.error) || 'no response'), true); return; }
    if (r.failed && r.failed.some((f) => f.error === 'daily data limit')) status('Stopped: daily data limit reached. ' + r.ok + ' video' + (r.ok === 1 ? '' : 's') + ' saved. Raise the limit in "Data & speed saver" or continue tomorrow.', true);
    else if (r.failed && r.failed.length) status('Finished: ' + r.ok + ' saved, ' + r.failed.length + ' not saved — ' + r.failed.map((f) => f.name + ' (' + f.error + ')').join('; '), true);
    else status('Done — ' + r.ok + ' video' + (r.ok === 1 ? '' : 's') + ' saved to Downloads/' + opts().folder + '/Lectures');
  }

  $('vl-dl-all').addEventListener('click', () => startBatch(sorted().map((v) => v.id)));
  $('vl-dl-sel').addEventListener('click', () => startBatch(sorted().filter((v) => selected.has(v.id)).map((v) => v.id)));
  $('vl-stop').addEventListener('click', () => { send({ action: 'cancelVideoBatch' }); status('Stopping ...'); });
  $('vl-all').addEventListener('click', () => { vlib.forEach((v) => selected.add(v.id)); render(); });
  $('vl-none').addEventListener('click', () => { selected.clear(); render(); });
  $('vl-clear').addEventListener('click', async () => {
    if (!vlib.length || !confirm('Remove all ' + vlib.length + ' lectures from this list?\n(Downloaded files are not touched.)')) return;
    await send({ action: 'clearVideos' }); selected.clear(); known.clear();
  });
  const savePrefs = () => chrome.storage.local.get('videoPrefs', (d) => chrome.storage.local.set({ videoPrefs: Object.assign(d.videoPrefs || {}, prefs) }));
  $('vid-prefix').addEventListener('change', (e) => { prefs.prefix = e.target.checked; savePrefs(); });
  $('vid-subs').addEventListener('change', (e) => { prefs.withSubs = e.target.checked; savePrefs(); updateButtons(); });
  $('vid-folder').addEventListener('change', (e) => { prefs.folder = e.target.value; savePrefs(); });

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.action !== 'videoBatchProgress') return;
    if (m.done) {
      running = false; Object.keys(progress).forEach((k) => delete progress[k]); render();
      return;
    }
    running = true;
    if (m.waiting) { status(m.statusText); updateButtons(); return; }
    const pct = m.percent ? ' — ' + Math.round(m.percent) + '%' : '';
    status('Downloading ' + m.index + ' of ' + m.total + ': ' + m.name + pct + (m.statusText && /MB/.test(m.statusText) ? ' · ' + m.statusText.replace(/^Downloading /, '') : '') + (m.failed ? ' (' + m.failed + ' failed)' : ''));
    if (m.vid) { progress[m.vid] = 'downloading' + pct; }
    updateButtons();
  });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch[VLIB_KEY]) { vlib = ch[VLIB_KEY].newValue || []; render(); } });
  document.addEventListener('focusout', () => { if (renderPending) setTimeout(render, 0); });

  (async function init() {
    try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t ? t.id : null; } catch (e) { /* ignore */ }
    const d = await chrome.storage.local.get([VLIB_KEY, 'videoPrefs', UNTICK_KEY]);
    (d[UNTICK_KEY] || []).forEach((id) => unticked.add(id));
    vlib = d[VLIB_KEY] || [];
    if (d.videoPrefs) prefs = Object.assign(prefs, d.videoPrefs);
    $('vid-prefix').checked = prefs.prefix !== false; $('vid-subs').checked = prefs.withSubs !== false; $('vid-folder').value = prefs.folder || 'eJPT';
    const st = await send({ action: 'videoBatchState' });
    running = !!(st && st.running);
    render();
  })();
})();
