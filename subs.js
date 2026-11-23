// ============================================================================
// Subtitles tab. Reads the global subtitle library from chrome.storage.local
// (filled by subs-library.js in the background) and lets you rename, reorder,
// and download one or many (files or a ZIP). All downloading happens in the
// background worker, so closing the popup never interrupts a batch.
// ============================================================================
(function () {
  'use strict';
  const U = window.SubUtils;
  const LIB_KEY = 'subtitleLibrary';
  const CAND_KEY = 'subtitleCandidates';
  const PREFS_KEY = 'subtitlePrefs';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---- tabs -------------------------------------------------------------------
  const tabs = document.querySelectorAll('.tab');
  function showTab(name) {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('tab-subs').hidden = name !== 'subs';
    $('tab-videos').hidden = name !== 'videos';
    $('tab-auto').hidden = name !== 'auto';
    try { chrome.storage.local.set({ popupTab: name }); } catch (e) { /* ignore */ }
  }
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // ---- state --------------------------------------------------------------------
  let lib = [];
  let prefs = { englishOnly: true, format: 'txt', prefix: true, combine: false, zip: false, structure: true, folder: 'eJPT' };
  let tabId = null;
  const UNTICK_KEY = 'subsUnticked';   // ids you unticked; kept across popup closes (v1.11.1)
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
  let renderPending = false;

  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));
  const savePrefs = () => chrome.storage.local.set({ [PREFS_KEY]: prefs });
  const isEn = (e) => U.isEnglish(e.langCode, e.langName);

  // What the list shows. With "English only" on: only subtitles confirmed to be English.
  function visibleEntries() {
    return U.sortByPlace(lib.filter((e) => !prefs.englishOnly || isEn(e)));   // always in course order
  }
  // "Sort by course order" — section number, then lecture number (from the page)
  function courseSort() {
    const firstSeen = new Map();
    visibleEntries().forEach((e) => { const k = (e.course || '') + '|' + (e.category || '') + '|' + (e.section || ''); if (!firstSeen.has(k)) firstSeen.set(k, firstSeen.size); });
    const cmp = (x, y) => (x || '').localeCompare(y || '');
    return visibleEntries().slice().sort((a, b) => cmp(a.course, b.course) || ((a.categoryIndex || 999) - (b.categoryIndex || 999)) || ((a.sectionIndex || 999) - (b.sectionIndex || 999)) ||
      (firstSeen.get((a.course || '') + '|' + (a.category || '') + '|' + (a.section || '')) - firstSeen.get((b.course || '') + '|' + (b.category || '') + '|' + (b.section || ''))) ||
      ((a.lessonIndex || 999) - (b.lessonIndex || 999)) || ((a.order || a.detectedAt) - (b.order || b.detectedAt)));
  }
  const hiddenCount = () => lib.length - visibleEntries().length;

  // ---- list rows ----------------------------------------------------------------------
  const SOURCE_HINT = {
    manifest: 'Language read from the stream manifest',
    player: 'Language reported by the video player',
    url: 'Language guessed from the file name — double-check',
    text: 'Language detected from the subtitle text'
  };

  function renderRow(e, num, rows) {
    const row = el('div', 'sub-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.className = 'sel'; cb.checked = selected.has(e.id);
    cb.addEventListener('change', () => { cb.checked ? selected.add(e.id) : selected.delete(e.id); updateBatchButton(); });

    const numEl = el('div', 'sub-num', two(e.lessonIndex || num));
    numEl.title = 'Lecture number inside its section (used in the file name)';

    const main = el('div', 'sub-main');
    const defaultName = U.isJunkName(e.name) ? 'Lecture' : e.name;
    const name = el('input', 'name'); name.type = 'text'; name.value = e.userName || defaultName; name.spellcheck = false;
    name.title = 'Click to rename. This becomes the file name.';
    name.addEventListener('change', () => { e.userName = name.value.trim() === e.name ? '' : name.value.trim(); send({ action: 'renameSubtitle', id: e.id, name: e.userName }); });
    name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') name.blur(); });

    const meta = el('div', 'sub-meta');
    const badge = el('span', 'lang-badge' + (e.langName ? '' : ' unknown'), e.langName || 'Language unknown');
    if (e.langSource === 'url') badge.textContent += ' ~';
    badge.title = e.langSource ? SOURCE_HINT[e.langSource] : 'Could not tell the language';
    meta.appendChild(badge);
    const bits = [e.type === 'HLS-VTT' ? 'VTT (stream)' : e.type];
    if (e.cues) bits.push(e.cues + ' lines');
    const d = U.formatDuration(e.durationSec); if (d) bits.push(d);
    meta.appendChild(el('span', 'bit', bits.join(' · ')));
    if (!e.hasContent) { const w = el('span', 'warn', e.error ? 'not cached: ' + e.error : 'not cached'); w.title = 'The text could not be saved when it was detected. Original-file download may still work; clean text may not.'; meta.appendChild(w); }
    main.appendChild(name); main.appendChild(meta);

    const move = el('div', 'sub-reorder');
    const up = el('button', 'mini', '▲'), dn = el('button', 'mini', '▼');
    up.title = 'Move up'; dn.title = 'Move down';
    const visibleIds = rows.map((r) => r.id);
    up.addEventListener('click', () => send({ action: 'moveSubtitle', id: e.id, dir: -1, visibleIds }));
    dn.addEventListener('click', () => send({ action: 'moveSubtitle', id: e.id, dir: 1, visibleIds }));
    move.appendChild(up); move.appendChild(dn);

    const act = el('div', 'sub-actions');
    const one = (label, fmt, title) => {
      const b = el('button', 'mini', label); b.title = title;
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await send({ action: 'downloadSubtitles', ids: [e.id], options: { format: fmt, prefix: prefs.prefix, combine: false, zip: false, folder: prefs.folder, structure: prefs.structure } });
        b.disabled = false;
        const ok = r && r.ok && !(r.failed && r.failed.length);
        flash(ok ? 'Saved ' + (e.userName || e.name) : 'Failed: ' + ((r && r.failed && r.failed[0] && r.failed[0].error) || (r && r.error) || 'unknown error'), !ok);
      });
      return b;
    };
    act.appendChild(one('TXT', 'txt', 'Save the transcript (.txt) into Transcripts/…'));
    act.appendChild(one('SRT', 'srt', 'Save the subtitle (.srt) into Lectures/… next to the video'));
    const x = el('button', 'mini danger', '×'); x.title = 'Remove from list';
    x.addEventListener('click', async () => { await send({ action: 'removeSubtitles', ids: [e.id] }); selected.delete(e.id); });
    act.appendChild(x);

    const bar = el('div', 'sub-bar'); bar.appendChild(el('span', 'bit', '')); bar.appendChild(act); main.appendChild(bar);
    row.appendChild(cb); row.appendChild(numEl); row.appendChild(main);
    return row;
  }

  const two = (n) => String(n).padStart(2, '0');

  function render() {
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains('name')) { renderPending = true; return; } // don't wipe a name being typed
    renderPending = false;

    $('subs-count').textContent = visibleEntries().length;
    lib.forEach((e) => { if (!unticked.has(e.id)) Set.prototype.add.call(selected, e.id); });   // new items start ticked, your unticks stay
    for (const id of [...selected]) if (!lib.some((e) => e.id === id)) Set.prototype.delete.call(selected, id);

    const list = $('subs-list');
    list.textContent = '';
    const rows = visibleEntries();
    if (!rows.length) {
      const empty = el('div', 'empty-state');
      empty.appendChild(el('p', 'empty-title', 'No subtitles captured yet'));
      empty.appendChild(el('p', 'empty-desc', 'Open a lecture, switch captions (CC) on, and let it play for 5–10 seconds. Each lecture you play is added here.'));
      list.appendChild(empty);
    } else {
      // group headers: Course, then "01 Windows › 03 Windows Credential Dumping"
      let lastCourse = null, lastGroup = null, n = 0;
      rows.forEach((e) => {
        if ((e.course || '') !== lastCourse) {
          lastCourse = e.course || ''; lastGroup = null;
          if (lastCourse) list.appendChild(el('div', 'grp-course', '🎓 ' + U.courseDir(lastCourse).split('/').join('  ›  ')));
        }
        const g = (e.category || '') + '|' + (e.section || '');
        if (g !== lastGroup) {
          lastGroup = g; n = 0;
          const h = el('div', 'grp-sec' + (e.section ? '' : ' missing'));
          const parts = [];
          if (e.category) parts.push((e.categoryIndex ? two(e.categoryIndex) + ' ' : '') + e.category);
          if (e.section) parts.push((e.sectionIndex ? two(e.sectionIndex) + ' ' : '') + e.section);
          h.textContent = '📁 ' + (parts.length ? parts.join('  ›  ') : 'Section not found — open "Names & folders" below');
          list.appendChild(h);
        }
        list.appendChild(renderRow(e, ++n, rows));
      });
    }

    const hidden = hiddenCount();
    const note = $('hidden-note');
    note.hidden = hidden === 0;
    note.textContent = '';
    if (hidden) {
      note.appendChild(el('span', null, hidden + ' hidden (not English, or language unknown).'));
      const b = el('button', 'mini danger', 'Delete them');
      b.addEventListener('click', async () => { await send({ action: 'removeNonEnglish' }); });
      note.appendChild(b);
    }
    updateBatchButton();
  }

  function updateBatchButton() {
    const all = visibleEntries().length;
    const ba = $('btn-all-txt');
    ba.textContent = (prefs.zip ? 'Download all transcripts as .zip (' : 'Download all transcripts (') + all + ') — .txt';
    ba.disabled = all === 0;
    const n = visibleEntries().filter((e) => selected.has(e.id)).length;
    const b = $('btn-batch');
    b.textContent = (prefs.zip ? 'Download selected as .zip (' : 'Download selected (') + n + ')';
    b.disabled = n === 0;
  }

  function flash(text, isError) {
    const s = $('batch-status');
    s.textContent = text;
    s.className = 'batch-status' + (isError ? ' error' : '');
  }

  // ---- toolbar + options ------------------------------------------------------------------
  $('english-only').addEventListener('change', (ev) => {
    prefs.englishOnly = ev.target.checked; savePrefs();
    render();
  });
  $('sel-all').addEventListener('click', () => { visibleEntries().forEach((e) => selected.add(e.id)); render(); });
  $('sel-none').addEventListener('click', () => { selected.clear(); render(); });
  $('subs-clear').addEventListener('click', async () => {
    if (!lib.length) return;
    if (!confirm('Remove all ' + lib.length + ' captured subtitles from this list?\n(Files you already downloaded are not touched.)')) return;
    await send({ action: 'clearSubtitles' });
    selected.clear(); known.clear();
  });

  const bind = (id, key, type) => {
    const node = $(id);
    node.addEventListener('change', () => { prefs[key] = type === 'check' ? node.checked : node.value; savePrefs(); if (key === 'zip') updateBatchButton(); });
  };
  bind('opt-format', 'format'); bind('opt-prefix', 'prefix', 'check'); bind('opt-combine', 'combine', 'check');
  bind('opt-zip', 'zip', 'check'); bind('opt-structure', 'structure', 'check'); bind('opt-folder', 'folder');

  $('btn-all-txt').addEventListener('click', async () => {
    const ids = visibleEntries().map((e) => e.id);
    if (!ids.length) return;
    $('btn-all-txt').disabled = true;
    flash('Saving ' + ids.length + ' transcripts in course order ...');
    const r = await send({ action: 'downloadSubtitles', ids,
      options: { format: 'txt', prefix: prefs.prefix, combine: prefs.combine, zip: prefs.zip, folder: (prefs.folder || '').trim(), structure: prefs.structure } });
    updateBatchButton();
    if (!r || !r.ok) { flash('Failed: ' + ((r && r.error) || 'no response from the extension'), true); return; }
    if (r.failed && r.failed.length) flash('Finished with problems — ' + r.failed.map((f) => f.name + ' (' + f.error + ')').join('; '), true);
    else flash('Done — ' + ids.length + ' transcripts saved to Downloads/' + (prefs.folder || 'eJPT').trim() + (prefs.zip ? '.zip' : '/Transcripts'));
  });

  $('btn-batch').addEventListener('click', async () => {
    const ids = visibleEntries().filter((e) => selected.has(e.id)).map((e) => e.id);
    if (!ids.length) return;
    const btn = $('btn-batch');
    btn.disabled = true;
    flash('Starting ' + ids.length + ' ...');
    const r = await send({
      action: 'downloadSubtitles', ids,
      options: { format: prefs.format, prefix: prefs.prefix, combine: prefs.combine, zip: prefs.zip, folder: (prefs.folder || '').trim(), structure: prefs.structure }
    });
    updateBatchButton();
    if (!r || !r.ok) { flash('Failed: ' + ((r && r.error) || 'no response from the extension'), true); return; }
    const where = prefs.zip ? 'Downloads/' + (prefs.folder || 'Subtitles').trim() + '.zip' : 'Downloads/' + (prefs.folder || '').trim();
    if (r.failed && r.failed.length) {
      flash('Finished with problems — ' + r.failed.map((f) => f.name + ' (' + f.error + ')').join('; '), true);
    } else {
      flash(prefs.zip ? 'Done — ' + r.files + ' files in ' + where : 'Done — ' + r.total + ' file' + (r.total === 1 ? '' : 's') + ' saved to ' + where);
    }
  });

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.action === 'subBatchProgress') flash('Saving ' + m.done + ' / ' + m.total + (m.failed ? ' — ' + m.failed + ' failed' : '') + ' ...', false);
  });

  // ---- lecture-name source -----------------------------------------------------------------------
  const SRC_LABEL = {
    selector: 'Element you picked on the page', row: 'Open lecture in the course list (INE)', mediaSession: 'Title published by the player', active: 'Highlighted item in the lecture list',
    h1: 'Main heading on the page', breadcrumb: 'Last breadcrumb', videoLabel: 'Video label', ogtitle: 'Page meta title', h2: 'Sub-heading on the page', doctitle: 'Browser tab title'
  };
  let nameInfo = null;

  async function loadNaming() {
    if (tabId == null) return;
    const info = await send({ action: 'getNameInfo', tabId });
    nameInfo = info && info.ok ? info : null;
    const box = $('name-cands');
    box.textContent = '';
    if (!nameInfo) { box.appendChild(el('p', 'diag-help', 'Could not read this page. Open a lecture tab and try again.')); return; }

    const addOpt = (value, label, text) => {
      const l = el('label', nameInfo.naming.source === value ? 'on' : '');
      const r = el('input'); r.type = 'radio'; r.name = 'name-src'; r.value = value; r.checked = nameInfo.naming.source === value;
      r.addEventListener('change', async () => { await send({ action: 'setNameSource', host: nameInfo.host, source: value }); loadNaming(); });
      const t = el('div');
      t.appendChild(el('span', 'txt', text));
      t.appendChild(el('span', 'src', label));
      l.appendChild(r); l.appendChild(t);
      box.appendChild(l);
    };
    addOpt('auto', 'Automatic (best guess)', nameInfo.chosen || '(nothing found)');
    nameInfo.candidates.forEach((c) => addOpt(c.src, SRC_LABEL[c.src] || c.src, c.text));
    renderPlace(nameInfo.place || {});
    $('naming-chosen').textContent = nameInfo.chosen ? '— “' + nameInfo.chosen.slice(0, 32) + (nameInfo.chosen.length > 32 ? '…' : '') + '”' : '';
    const bits = [];
    if (nameInfo.naming.titleSel) bits.push('Title element saved.');
    ['sectionSel', 'categorySel', 'courseSel'].forEach((k) => { if (nameInfo.naming[k]) bits.push(k.replace('Sel', '') + ' element saved.'); });
    $('naming-note').textContent = bits.join(' ');
  }
  $('naming-panel').addEventListener('toggle', (ev) => { if (ev.target.open) loadNaming(); });
  const KIND_LABEL = { course: 'Course', category: 'Category', section: 'Section', title: 'Lecture' };
  function renderPlace(p) {
    const box = $('place-box');
    box.textContent = '';
    const rows = [
      ['course', p.course, null],
      ['category', p.category, p.categoryIndex],
      ['section', p.section, p.sectionIndex],
      ['title', p.name, p.lessonIndex]
    ];
    rows.forEach(([kind, text, idx]) => {
      const r = el('div', 'place-row');
      r.appendChild(el('span', 'place-k', KIND_LABEL[kind]));
      const v = el('span', 'place-v' + (text ? '' : ' missing'), text ? (idx ? two(idx) + ' ' : '') + text : 'not found');
      if (text && !idx && kind !== 'course') { const w = el('span', 'place-warn', '  · number not found on the page'); v.appendChild(w); }
      r.appendChild(v);
      const b = el('button', 'mini', 'Pick'); b.title = 'Click the ' + KIND_LABEL[kind].toLowerCase() + ' on the page to teach the extension where it is';
      b.addEventListener('click', () => startPicker(kind));
      r.appendChild(b);
      box.appendChild(r);
    });
    const two_ = (n) => (n ? two(n) + ' ' : '');
    const ex = [(prefs.folder || 'eJPT').trim(), 'Transcripts', p.course ? U.courseDir(p.course).split('/').join(' / ') : '', p.category ? two_(p.categoryIndex || 1) + p.category : '', p.section ? two_(p.sectionIndex || 1) + p.section : ''].filter(Boolean).join(' / ');
    $('place-path').textContent = 'Will be saved as:  ' + ex + ' / ' + two_(p.lessonIndex || 1) + (p.name || 'Lecture') + '.txt';
  }
  const startPicker = async (kind) => {
    await send({ action: 'startPicker', tabId, kind });
    $('naming-note').textContent = 'Now click the ' + KIND_LABEL[kind].toLowerCase() + ' on the page. Then reopen this popup to check.';
  };
  $('naming-reset').addEventListener('click', async () => { if (nameInfo) { await send({ action: 'resetNaming', host: nameInfo.host }); loadNaming(); } });

  // ---- diagnostics ----------------------------------------------------------------------------
  async function renderDiag() {
    const d = (await chrome.storage.local.get(CAND_KEY))[CAND_KEY] || [];
    $('diag-out').textContent = d.length
      ? d.slice().reverse().map((c) => '[' + new Date(c.t).toLocaleTimeString() + '] ' + c.via + '  ' + c.url).join('\n')
      : '(nothing caption-like seen yet)';
  }
  document.querySelector('details.diag').addEventListener('toggle', (ev) => { if (ev.target.open) renderDiag(); });
  $('diag-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('diag-out').textContent); $('diag-copy').textContent = 'Copied'; setTimeout(() => ($('diag-copy').textContent = 'Copy'), 1200); } catch (e) { /* ignore */ }
  });

  // ---- boot --------------------------------------------------------------------------------------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[LIB_KEY]) { lib = changes[LIB_KEY].newValue || []; render(); }
    if (changes[CAND_KEY] && document.querySelector('details.diag').open) renderDiag();
  });
  document.addEventListener('focusout', () => { if (renderPending) setTimeout(render, 0); });

  (async function init() {
    try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t ? t.id : null; } catch (e) { /* ignore */ }
    const d = await chrome.storage.local.get([PREFS_KEY, 'popupTab', UNTICK_KEY]);
    (d[UNTICK_KEY] || []).forEach((id) => unticked.add(id));
    if (d[PREFS_KEY]) prefs = Object.assign(prefs, d[PREFS_KEY]);
    if (prefs.englishOnly === undefined) prefs.englishOnly = true;
    if (!prefs.v15) { prefs.v15 = true; if (!prefs.folder || prefs.folder === 'Subtitles') prefs.folder = 'eJPT'; }
    if (!prefs.v16) { prefs.v16 = true; prefs.structure = true; prefs.format = 'both'; }
    if (!prefs.v17) { prefs.v17 = true; prefs.format = 'txt'; }   // .srt files come with the videos (Videos tab)
    $('english-only').checked = !!prefs.englishOnly;
    $('opt-format').value = prefs.format; $('opt-prefix').checked = !!prefs.prefix; $('opt-combine').checked = !!prefs.combine;
    $('opt-zip').checked = !!prefs.zip; $('opt-structure').checked = prefs.structure !== false; $('opt-folder').value = prefs.folder || 'eJPT';
    savePrefs();   // makes sure the background sees the English-only setting from the start
    await send({ action: 'cleanupLibrary' });   // merges duplicates captured earlier
    lib = (await chrome.storage.local.get(LIB_KEY))[LIB_KEY] || [];
    render();
    showTab(['videos', 'auto'].includes(d.popupTab) ? d.popupTab : 'subs');
  })();
})();
