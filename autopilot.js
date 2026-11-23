// ============================================================================
// AUTOPILOT (v1.12.0) — loaded by background.js via importScripts.
// Works through a queue of courses from an INE learning path, one after another:
//   learning path page -> click course -> open each lecture -> watch 35-60% of it
//   -> close -> auto-download new transcripts (and videos) -> next lecture
//   -> next course ... until the queue is finished.
// Built to run overnight: progress is saved after every lecture, a heartbeat keeps
// the background alive during long watches, and a 1-minute alarm restarts the run
// if Chrome ever stops the background script. Resume always continues where it was.
// ============================================================================
(function () {
  'use strict';
  const AP_KEY = 'autopilot';
  const DEFAULT_SETTINGS = {
    minPct: 35, maxPct: 60,     // how much of each lecture to watch (longer lectures -> closer to min)
    lowestQuality: true,        // set INE's player to its lowest quality (saves a lot of data)
    mute: true,
    autoTxt: true,              // download each new transcript right after its lecture
    autoVid: true,              // also download each lecture video (Data & speed saver settings apply)
    skipWatched: false,         // skip lectures INE already shows as completed
    maxPerDay: 0,               // optional: stop after this many lectures per calendar day (0 = off)
    runLimitMin: 0              // optional: stop this run after N minutes (0 = off), e.g. 120 = 2 hours
    // (no daily data limit for autopilot: it never stops on its own — only the Stop button ends a run)
  };
  const fresh = () => ({ settings: Object.assign({}, DEFAULT_SETTINGS), courses: [], pathUrl: '', pathName: '', running: false,
    tabId: null, current: -1, status: 'Idle', log: [], stats: { lectures: 0, txt: 0, notebooks: 0, videos: 0, startedAt: 0 }, dlTxt: null, dlVid: null, dlNb: [] });

  let ap = null;
  let loopActive = false;
  let stopReq = false;
  let live = null;              // current lecture info for the popup
  let stopReason = '';          // 'limit' | 'cap' | 'time' | '' (user)
  const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const todayCount = () => (ap.daily && ap.daily.day === dayKey() ? ap.daily.count : 0);
  // INE's own message when an account has watched its daily maximum, e.g.
  // "The user has watched the maximum number of minutes. Please wait 24 hours or contact support".
  const LIMIT_RE = /maximum (number of )?(minutes|hours|videos)|watched the maximum|wait (for )?24 hours|daily (viewing|watch(ing)?|video) limit|viewing limit (has been )?(reached|exceeded)/i;
  function apLimitCheck(reSrc) {
    const re = new RegExp(reSrc, 'i');
    // innerText can miss parts of the page (seen in tests), so also read every rendered text node
    // (scripts/styles skipped, so text inside INE's code bundles never counts).
    let t = (document.body && document.body.innerText) || '';
    let m = t.match(re);
    if (!m && document.body) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const el = n.parentElement;
        if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
        const v = n.nodeValue; if (!v || v.length < 10 || !re.test(v)) continue;
        if (!el.getClientRects().length) continue;
        const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        t = (el.textContent || v); m = t.match(re); if (m) break;
      }
    }
    return m ? { limitHit: true, text: t.substr(Math.max(0, m.index - 60), 200).replace(/\s+/g, ' ').trim() } : { limitHit: false };
  }
  // Run-time limit ("Stop after 2 h"): the deadline is set when you press Start/Resume and
  // survives a background restart. Checked between lectures, so the current lecture finishes.
  function runTimeUp() { return !!(ap.runEndsAt && Date.now() >= ap.runEndsAt); }
  async function stopForTime() {
    const mins = ap.settings.runLimitMin;
    ap.running = false; stopReason = 'time'; stopReq = true; ap.runEndsAt = 0;
    say('⏱ Run time of ' + (mins >= 60 ? (mins / 60) + ' h' : mins + ' min') + ' reached — Autopilot stopped. Press Resume to continue from here.');
    await save();
  }
  async function pageLimitHit() {
    const r = await run(ap.tabId, apLimitCheck, [LIMIT_RE.source]);
    return r && r.limitHit ? r : null;
  }
  async function stopForLimit(r) {
    ap.blockedUntil = Date.now() + 24 * 3600 * 1000;
    ap.running = false; stopReason = 'limit'; stopReq = true;
    say('⛔ INE daily viewing limit reached — Autopilot stopped. It will not start again before ' + new Date(ap.blockedUntil).toLocaleString() + '.' + (r && r.text ? ' (INE said: "' + r.text.slice(0, 120) + '")' : ''));
    await save();
  }

  const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));
  const U = () => self.SubUtils;

  async function load() {
    const d = await chrome.storage.local.get(AP_KEY);
    ap = Object.assign(fresh(), d[AP_KEY] || {});
    ap.settings = Object.assign({}, DEFAULT_SETTINGS, ap.settings || {});
    if (!ap.settings.v1121) { ap.settings.v1121 = true; ap.settings.autoVid = true; }
    // v1.12.4: "already downloaded" now means downloaded in THIS queue; only items captured after the queue started count.
    if (!ap.v1124) { ap.v1124 = true; ap.dlTxt = []; ap.dlVid = []; if (!ap.since) ap.since = ap.stats.startedAt || Date.now(); }
    ap.stats = Object.assign({ lectures: 0, txt: 0, notebooks: 0, startedAt: 0 }, ap.stats || {});
    if (!Array.isArray(ap.dlNb)) ap.dlNb = [];
    return ap;
  }
  async function save() { if (ap) await chrome.storage.local.set({ [AP_KEY]: ap }); }
  function emit(extra) { try { chrome.runtime.sendMessage(Object.assign({ action: 'autopilotProgress', live }, extra || {})).catch(() => {}); } catch (e) { /* popup closed */ } }
  function say(text) {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
    ap.status = text;
    ap.log.push(hh + '  ' + text);
    if (ap.log.length > 80) ap.log = ap.log.slice(-80);
    emit({ status: text });
  }

  // Sleep that keeps the background script alive (an extension API call every <=15 s)
  // and wakes up early when Stop is pressed. Returns false if stopped.
  async function nap(ms) {
    const scale = (ap && ap.settings && ap.settings.timeScale) || 1;   // hidden, for testing only
    const end = Date.now() + ms * scale;
    while (Date.now() < end) {
      if (stopReq) return false;
      await new Promise((r) => setTimeout(r, Math.min(15000, Math.max(0, end - Date.now()))));
      try { await chrome.storage.local.get('__hb'); } catch (e) { /* ignore */ }
    }
    return !stopReq;
  }

  async function run(tabId, func, args, world) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [], world: world || 'ISOLATED' });
      return r && r[0] ? r[0].result : null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- in-page functions (self-contained)
  // Learning path page: every tile in order with its section, type and progress.
  function apScanPath() {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const txt = (root, sel) => { const e = root && root.querySelector(sel); return e ? clean(e.textContent) : ''; };
    const items = [];
    document.querySelectorAll('.content-tile').forEach((t, i) => {
      const topic = t.closest('.topic');
      const bar = t.querySelector('.content-img__progress__completed');
      items.push({
        name: txt(t, '.content-info__name'),
        type: txt(t, '.content-info__header__content-type').toLowerCase() || 'course',
        section: txt(topic, '.topic__info-name'),
        sectionNo: txt(topic, '.topic__info-section-number').replace(/section/i, '').trim(),
        pct: bar ? (parseFloat(bar.style.width) || 0) : 0,
        dur: txt(t, '.content-info__data-duration'),
        tileIndex: i
      });
    });
    const title = txt(document, '.overview__title') || txt(document, 'h1') || document.title;
    return { title, url: location.href, items };
  }

  // Learning path page: click the course tile (by name, falling back to its position).
  function apClickTile(name, idx) {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const tiles = [...document.querySelectorAll('.content-tile')];
    if (!tiles.length) return { ready: false };
    const t = tiles.find((x) => clean((x.querySelector('.content-info__name') || {}).textContent) === clean(name)) || tiles[idx];
    if (!t) return { ready: true, found: false };
    const target = t.querySelector('.content-info__name') || t.querySelector('.content-tile__overview') || t;
    try { target.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    target.click();
    return { ready: true, found: true };
  }

  // Course page: is the lecture list there yet? Also reports login pages.
  function apCourseReady() {
    if (/\/(login|signin|sign-in)\b/i.test(location.pathname)) return { loggedOut: true };
    const rows = document.querySelectorAll('.level').length;
    const btn = [...document.querySelectorAll('button, .topic__toggle')].some((b) => /^(start|restart|resume|watch) video$|^show details$|^hide details$/i.test((b.textContent || '').trim()));
    return { ready: rows > 0 || btn, url: location.href };
  }

  // Course page: ONE step. Close an open lecture / open the next lecture / expand a section / done.
  function apStep(doneKeys, skipWatched) {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const done = new Set(doneKeys || []);
    const VIDEO_OPEN = /^(start video|restart video|resume video|watch video)$/i;
    const parseDur = (s) => { s = clean(s); let m = s.match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i); let sec = 0;
      if (m && (m[1] || m[2] || m[3])) sec = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
      else if ((m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) sec = m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
      return sec; };
    const inChrome = (el) => !!el.closest('header, nav, footer, [role="navigation"], [role="banner"]');
    const courseTitle = clean((document.querySelector('.course__title, .course-header__title, h1') || {}).textContent) || '';

    // an open lecture (its row offers "Close")
    for (const b of document.querySelectorAll('button, a, [role="button"]')) {
      if (/^close$/i.test(clean(b.textContent)) && !inChrome(b)) return { hasOpen: true, courseTitle };
    }

    // INE lecture rows
    const rows = [...document.querySelectorAll('.level.video')];
    for (const row of rows) {
      const title = clean((row.querySelector('.level__title-text-wrapper') || {}).textContent);
      const durTxt = clean((row.querySelector('.level__title__label-detail') || {}).textContent);
      const key = title + '|' + durTxt;
      if (!title || done.has(key) || row.dataset.apOpened) continue;
      if (skipWatched && /\b(completed|finished)\b/i.test(row.className)) continue;
      const btn = [...row.querySelectorAll('button')].find((b) => VIDEO_OPEN.test(clean(b.textContent))) || row.querySelector('#state-control');
      if (!btn) continue;
      row.dataset.apOpened = '1';
      try { btn.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
      btn.click();
      return { opened: true, title, key, durSec: parseDur(durTxt), courseTitle };
    }

    // fallback for pages without INE's row classes: any "Start video" button
    if (!rows.length) {
      for (const b of document.querySelectorAll('button, a, [role="button"]')) {
        const t = clean(b.textContent);
        if (!VIDEO_OPEN.test(t) || inChrome(b) || b.dataset.apOpened) continue;
        let title = '', durSec = 0;
        for (let p = b.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) {
          const leaves = [...p.querySelectorAll('span, div, label, h3, h4, p')].map((e) => clean(e.childElementCount ? '' : e.textContent)).filter(Boolean);
          if (!durSec) { const d = leaves.find((x) => /^\d+\s*m(\s*\d+\s*s)?$|^\d{1,2}:\d{2}(:\d{2})?$/i.test(x)); if (d) durSec = parseDur(d); }
          const h = leaves.find((x) => x.length > 3 && x.length <= 140 && !VIDEO_OPEN.test(x) && !/^\d/.test(x));
          if (h) { title = h; break; }
        }
        const key = (title || 'Lecture') + '|' + durSec;
        if (done.has(key)) { b.dataset.apOpened = '1'; continue; }
        b.dataset.apOpened = '1';
        try { b.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        b.click();
        return { opened: true, title: title || 'Lecture', key, durSec, courseTitle };
      }
    }

    // expand the next collapsed section
    for (const el of document.querySelectorAll('.topic__toggle, button, [role="button"]')) {
      if (/^show details$/i.test(clean(el.textContent)) && !inChrome(el) && !el.dataset.apExpanded) {
        el.dataset.apExpanded = '1';
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        el.click();
        return { expanded: true, courseTitle };
      }
    }
    return { done: true, courseTitle };
  }

  function apClose() {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    for (const b of document.querySelectorAll('button, a, [role="button"]')) {
      if (/^close$/i.test(clean(b.textContent)) && !b.closest('header, nav, footer')) { b.click(); return { ok: true }; }
    }
    return { ok: false };
  }

  // Runs in the page's MAIN world so it can reach INE's JW Player directly.
  // Every INE course page has a TRAILER player in the header (above the lecture list).
  // We must control the LECTURE's player, never the trailer: the lecture player is the
  // one inside a lecture row (or below the first section of the lecture list). Every
  // other player (the trailer) is paused and muted each time this runs.
  function apPlayer(o) {
    const r = {};
    const firstTopic = document.querySelector('.topic, .course__content, .level');
    const isLecture = (el) => {
      if (!el) return false;
      if (el.closest('.level, .level-row, .video-level, .topic__level-wrapper')) return true;
      // below the start of the lecture list = lecture area; above it = header / trailer
      return !!(firstTopic && (firstTopic.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    };
    // collect JW Player instances
    const insts = [];
    try {
      if (typeof window.jwplayer === 'function') {
        const seen = new Set();
        const add = (p) => { try { if (p && typeof p.getState === 'function' && typeof p.getContainer === 'function') { const c = p.getContainer(); if (c && !seen.has(c)) { seen.add(c); insts.push(p); } } } catch (e) { /* ignore */ } };
        document.querySelectorAll('.jwplayer, [id^="jwplayer"], .jw-wrapper').forEach((el) => add(window.jwplayer(el.closest('.jwplayer') || el)));
        for (let i = 0; i < 12; i++) add(window.jwplayer(i));
      }
    } catch (e) { r.err = String(e); }
    let lecture = null;
    for (const p of insts) {
      const c = p.getContainer();
      if (isLecture(c) && !lecture) lecture = p;
      else { try { if (p.getState() === 'playing' || p.getState() === 'buffering') p.pause(true); p.setMute(true); } catch (e) { /* ignore */ } }   // the trailer
    }
    // plain <video> elements that are not the lecture (e.g. the trailer): pause + mute
    const vids = [...document.querySelectorAll('video')];
    const lectureVid = vids.find((v) => isLecture(v) && (!lecture || lecture.getContainer().contains(v))) || null;
    vids.forEach((v) => { if (v !== lectureVid && !(lecture && lecture.getContainer().contains(v))) { try { v.muted = true; if (!v.paused) v.pause(); } catch (e) { /* ignore */ } } });
    r.trailerPaused = insts.length - (lecture ? 1 : 0);

    if (lecture) {
      try {
        const jw = lecture;
        if (o.mute && !jw.getMute()) jw.setMute(true);
        if (o.lowest && jw.getQualityLevels) {
          const q = jw.getQualityLevels() || [];
          let best = -1, low = Infinity;
          q.forEach((l, i) => { if (/auto/i.test(l.label || '')) return; const h = parseInt(l.height || l.label, 10); const v = isNaN(h) ? (l.bitrate || 1e12) : h; if (v < low) { low = v; best = i; } });
          if (best >= 0 && jw.getCurrentQuality() !== best) jw.setCurrentQuality(best);
          if (best >= 0) r.quality = q[best].label;
        }
        const st = jw.getState();
        if (st !== 'playing' && st !== 'buffering') jw.play(true);
        r.state = jw.getState(); r.pos = jw.getPosition() || 0; r.dur = jw.getDuration() || 0; r.jw = true;
        return r;
      } catch (e) { r.err = String(e); }
    }
    if (lectureVid) {
      const v = lectureVid;
      if (o.mute) v.muted = true;
      if (v.paused) v.play().catch(() => {});
      r.pos = v.currentTime || 0; r.dur = isFinite(v.duration) ? v.duration : 0; r.state = v.paused ? 'paused' : 'playing';
      return r;
    }
    r.noLecturePlayer = true;     // lecture player not loaded yet
    return r;
  }

  // ---------------------------------------------------------------- helpers
  async function tabAlive(tabId) { try { return await chrome.tabs.get(tabId); } catch (e) { return null; } }

  async function waitLoaded(tabId, ms) {
    const end = Date.now() + (ms || 60000);
    if (!(await nap(1500))) return false;
    while (Date.now() < end) {
      const t = await tabAlive(tabId);
      if (!t) return false;
      if (t.status === 'complete') return true;
      if (!(await nap(1000))) return false;
    }
    return false;
  }

  async function waitCourseReady(tabId, ms) {
    const end = Date.now() + (ms || 60000);
    while (Date.now() < end) {
      const r = await run(tabId, apCourseReady);
      if (r && r.loggedOut) return { loggedOut: true };
      if (r && r.ready) return { ready: true, url: r.url };
      if (!(await nap(1500))) return {};
    }
    return {};
  }

  // Watch percentage: short lectures closer to maxPct, long ones closer to minPct, plus a little randomness.
  function pickPct(durSec) {
    const lo = Math.max(5, Math.min(95, ap.settings.minPct)), hi = Math.max(lo, Math.min(95, ap.settings.maxPct));
    const m = (durSec || 600) / 60;
    const t = Math.max(0, Math.min(1, (m - 3) / (20 - 3)));            // 0 at <=3 min, 1 at >=20 min
    const base = hi - (hi - lo) * t;
    return Math.max(lo, Math.min(hi, base + (Math.random() * 10 - 5))) / 100;
  }

  // The INE tab was closed (or Chrome restarted): open a fresh tab and carry on there.
  async function ensureTab() {
    if (ap.tabId && (await tabAlive(ap.tabId))) return ap.tabId;
    const c = ap.courses.find((x) => x.on && x.status !== 'done' && x.status !== 'error');
    const url = (c && c.url) || ap.pathUrl || 'https://my.ine.com/';
    const t = await chrome.tabs.create({ url, active: true });
    ap.tabId = t.id;
    say('The INE tab was closed — opened a new one and continuing');
    await save();
    await waitLoaded(ap.tabId);
    return ap.tabId;
  }

  // Logged out: never stop — check again every 5 minutes until INE works again.
  async function waitForLogin() {
    say('INE seems logged out — waiting and retrying every 5 minutes (log in again whenever you can)');
    for (;;) {
      if (!(await nap(300000))) return false;
      await ensureTab();
      const target = ap.pathUrl || 'https://my.ine.com/';
      try { await chrome.tabs.update(ap.tabId, { url: target }); } catch (e) { /* ignore */ }
      await waitLoaded(ap.tabId);
      const t = await tabAlive(ap.tabId);
      if (t && !/\/(login|signin|sign-in)\b|auth\./i.test(t.url || '')) { say('INE is reachable again — continuing'); return true; }
    }
  }

  async function openCourse(c) {
    await ensureTab();
    const tabId = ap.tabId;
    if (c.url) {
      await chrome.tabs.update(tabId, { url: c.url });
      await waitLoaded(tabId);
    } else {
      if (!ap.pathUrl) return { error: 'no learning path page saved' };
      say('Going back to the learning path to open: ' + c.name);
      await chrome.tabs.update(tabId, { url: ap.pathUrl });
      await waitLoaded(tabId);
      let clicked = null;
      for (let i = 0; i < 30 && !stopReq; i++) {               // tiles render after the page loads
        clicked = await run(tabId, apClickTile, [c.name, c.tileIndex]);
        if (clicked && clicked.ready) break;
        await nap(1500);
      }
      if (!clicked || !clicked.found) return { error: 'could not find "' + c.name + '" on the learning path page' };
      for (let i = 0; i < 30 && !stopReq; i++) {               // wait for INE to switch to the course page
        const t = await tabAlive(tabId);
        if (t && /\/courses?\//i.test(t.url || '')) { c.url = t.url.split('#')[0]; break; }
        await nap(1000);
      }
    }
    if (stopReq) return { error: 'stopped' };
    const r = await waitCourseReady(tabId, 60000);
    if (r.loggedOut) return { loggedOut: true };
    if (!r.ready) return { error: 'the course page did not show its lecture list' };
    if (!c.url && r.url && /\/courses?\//i.test(r.url)) c.url = r.url.split('#')[0];
    await save();
    return { ok: true };
  }

  // Watch the open lecture for pct of its length; keeps it playing, muted, lowest quality.
  async function watch(c, res) {
    const tabId = ap.tabId;
    const opt = { mute: ap.settings.mute, lowest: ap.settings.lowestQuality };
    await nap(2500);
    let p = (await run(tabId, apPlayer, [opt], 'MAIN')) || {};
    for (let i = 0; i < 6 && p.noLecturePlayer && !stopReq; i++) { await nap(2500); p = (await run(tabId, apPlayer, [opt], 'MAIN')) || {}; }   // lecture player still loading
    // the row's own length is the truth; only accept the player's length if it roughly agrees
    const rowDur = res.durSec || 0;
    let dur = rowDur || (p.dur > 30 ? p.dur : 0);
    if (rowDur && p.dur > 30 && Math.abs(p.dur - rowDur) <= Math.max(20, rowDur * 0.1)) dur = p.dur;
    const pct = pickPct(dur || res.durSec);
    if (!dur) dur = 300;
    const targetSec = Math.round(dur * pct);
    const wallLimit = targetSec * 1.6 + 120;     // never get stuck on one lecture
    const t0 = Date.now();
    let lastPos = -1, stuckSince = Date.now();
    live = { course: c.name, lecture: res.title, targetSec, durSec: Math.round(dur), pct: Math.round(pct * 100), pos: 0, quality: p.quality || '' };
    say('Watching "' + res.title + '" — ' + Math.round(pct * 100) + '% of ' + fmt(dur) + ' (' + fmt(targetSec) + ')' + (p.quality ? ' at ' + p.quality : ''));
    { const lim = await pageLimitHit(); if (lim) { live = null; await stopForLimit(lim); return; } }
    for (;;) {
      if (!(await nap(15000))) return;
      { const lim = await pageLimitHit(); if (lim) { live = null; await stopForLimit(lim); return; } }
      p = (await run(tabId, apPlayer, [opt], 'MAIN')) || {};
      const elapsed = (Date.now() - t0) / 1000;
      // use the player's position only when it is clearly the lecture (its length matches the row)
      const trusted = !p.noLecturePlayer && typeof p.pos === 'number' && (!rowDur || !p.dur || Math.abs(p.dur - rowDur) <= Math.max(20, rowDur * 0.1));
      const pos = trusted ? p.pos : elapsed;
      live.pos = Math.round(pos); live.quality = p.quality || live.quality;
      emit({ status: ap.status });
      if (pos >= targetSec) break;
      if (elapsed >= wallLimit) { say('Moving on — "' + res.title + '" did not reach its target in time'); break; }
      if (Math.abs(pos - lastPos) > 1) { lastPos = pos; stuckSince = Date.now(); }
      else if (Date.now() - stuckSince > 180000) { say('Moving on — the player seems stuck on "' + res.title + '"'); break; }
    }
    live = null;
  }
  const fmt = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };

  // Download transcripts captured since the last check (English only if that is the Subtitles-tab setting).
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const sameLecture = (name, title) => { const a = norm(name), b = norm(title); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };
  const capturedSince = (t) => (t || 0) >= (ap.since || 0) - 60000;

  // Download every transcript captured since this queue started that isn't downloaded yet.
  // Returns { saved, matched } — matched = a transcript exists for this lecture.
  async function autoDownloadTranscripts(title) {
    let lib = [], matched = false;
    for (let i = 0; i < 5; i++) {                       // captions can arrive a little late
      lib = await self.SubLib.readLib();
      matched = lib.some((e) => e.hasContent && sameLecture(e.userName || e.name, title));
      if (matched || !title) break;
      await nap(4000);
    }
    const prefs = (await chrome.storage.local.get('subtitlePrefs')).subtitlePrefs || {};
    const en = prefs.englishOnly !== false;
    const have = new Set(ap.dlTxt || []);
    const todo = lib.filter((e) => e.hasContent && !have.has(e.id) && capturedSince(e.order || e.detectedAt) && (!en || U().isEnglish(e.langCode, e.langName)));
    if (todo.length) {
      const ids = todo.map((e) => e.id);
      await self.SubLib.downloadSubtitles(ids, { format: prefs.format || 'txt', prefix: prefs.prefix !== false, combine: false, zip: false,
        folder: (prefs.folder || 'eJPT').trim(), structure: prefs.structure !== false });
      ap.dlTxt = (ap.dlTxt || []).concat(ids).slice(-6000);
      ap.stats.txt += ids.length;
      await save();
    }
    return { saved: todo.length, matched, listSize: lib.length };
  }


  // Videos download in the BACKGROUND, one after another, while autopilot carries on with the
  // next lecture (waiting for each video would roughly double the night). A video is marked as
  // done only after its download finished, so after a restart unfinished ones are queued again.
  let vidChain = Promise.resolve();
  const vidQueued = new Set();
  let vidPending = 0;
  let vidList = [];
  async function autoDownloadVideos() {
    vidList = vidList || [];
    const vlib = await self.SubLib.readVLib();
    const have = new Set(ap.dlVid || []);
    const todo = vlib.filter((v) => !have.has(v.id) && !vidQueued.has(v.id) && capturedSince(v.detectedAt));
    if (!todo.length) return 0;
    todo.forEach((v) => vidQueued.add(v.id));
    vidPending += todo.length;
    const vp = (await chrome.storage.local.get('videoPrefs')).videoPrefs || {};
    vidChain = vidChain.then(async () => {
      for (const v of todo) {
        let r = null;
        // wait while the Videos tab is running its own batch
        for (let i = 0; i < 720 && self.SubLib.isVideoBatchRunning && self.SubLib.isVideoBatchRunning(); i++) await new Promise((x) => setTimeout(x, 5000));
        try {
          r = await self.SubLib.runVideoBatch(ap.tabId, [{ video: v, name: v.userName || '' }],
            { prefix: vp.prefix !== false, folder: vp.folder || 'eJPT', structure: true, withSubs: vp.withSubs !== false, noDelay: true, ignoreLimit: true });
        } catch (e) { r = null; }
        vidPending--;
        vidQueued.delete(v.id);
        const ok = r && r.ok > 0;
        if (ok) { ap.dlVid = (ap.dlVid || []).concat(v.id).slice(-6000); ap.stats.videos = (ap.stats.videos || 0) + 1; }
        else { ap.dlVid = (ap.dlVid || []).concat(v.id).slice(-6000); ap.stats.videoFails = (ap.stats.videoFails || 0) + 1; }   // don't retry a broken one forever
        await save();
        say((ok ? 'Video saved: ' : 'Video not saved: ') + ((v.place && v.place.name) || v.userName || 'lecture') + (vidPending ? ' (' + vidPending + ' more queued)' : ''));
      }
    }).catch(() => {});
    return todo.length;
  }

  // ---------------------------------------------------------------- main loop
  async function loop() {
    if (loopActive) return;
    loopActive = true; stopReq = false; stopReason = '';
    try {
      if (!ap) await load();
      await ensureTab();
      ap.running = true;
      if (!ap.stats.startedAt) ap.stats.startedAt = Date.now();
      if (ap.dlTxt === null) ap.dlTxt = (await self.SubLib.readLib()).map((e) => e.id);   // don't re-download what was already in the list
      if (ap.dlVid === null) ap.dlVid = (await self.SubLib.readVLib()).map((v) => v.id);
      await save();
      chrome.alarms.create('autopilot-watchdog', { periodInMinutes: 1 });

      for (;;) {
        if (stopReq) break;
        if (runTimeUp()) { await stopForTime(); break; }
        let i = ap.courses.findIndex((c) => c.on && c.status !== 'done' && c.status !== 'error');
        if (i < 0 && !ap.retriedErrors && ap.courses.some((c) => c.on && c.status === 'error')) {
          ap.retriedErrors = true;
          ap.courses.forEach((c) => { if (c.on && c.status === 'error') { c.status = 'waiting'; c.tries = 0; } });
          say('Giving the courses that had problems one more try ...');
          await save();
          i = ap.courses.findIndex((c) => c.on && c.status !== 'done' && c.status !== 'error');
        }
        if (i < 0) { say('All queued courses are finished ✅  (' + ap.stats.lectures + ' lectures, ' + ap.stats.txt + ' transcripts' + (ap.settings.autoVid ? ', videos: ' + (ap.stats.videos || 0) + ' saved' + (vidPending ? ' + ' + vidPending + ' still downloading' : '') : '') + ')'); ap.running = false; break; }
        ap.current = i;
        const c = ap.courses[i];
        c.status = 'running'; c.done = c.done || [];
        await save();
        say('Course ' + (i + 1) + '/' + ap.courses.length + ': ' + c.name);
        const o = await openCourse(c);
        { const lim = await pageLimitHit(); if (lim) { c.status = 'waiting'; await stopForLimit(lim); break; } }
        if (o.loggedOut) { c.status = 'waiting'; await save(); if (!(await waitForLogin())) break; continue; }
        if (o.error) {
          if (stopReq) break;
          c.tries = (c.tries || 0) + 1;
          say('Problem opening "' + c.name + '": ' + o.error + (c.tries < 3 ? ' — will retry' : ' — skipping it'));
          if (c.tries >= 3) c.status = 'error'; else c.status = 'waiting';
          await save(); await nap(jitter(20000, 40000)); continue;
        }

        let stall = 0, count = 0, reopen = 0;
        for (;;) {
          if (stopReq) break;
          if (runTimeUp()) { await stopForTime(); break; }
          const cap = parseInt(ap.settings.maxPerDay, 10) || 0;
          if (cap > 0 && todayCount() >= cap) {
            ap.running = false; stopReason = 'cap'; stopReq = true;
            say('🛑 Daily lecture cap reached (' + todayCount() + '/' + cap + ' today) — Autopilot stopped. Press Resume tomorrow (or raise the cap in settings).');
            break;
          }
          { const lim = await pageLimitHit(); if (lim) { await stopForLimit(lim); break; } }
          const res = await run(ap.tabId, apStep, [c.done, ap.settings.skipWatched]);
          if (!res) {                                         // page reloaded / navigated away: reopen the course
            await ensureTab();
            if (++reopen > 3) { c.status = 'waiting'; c.tries = (c.tries || 0) + 1; say('Lost the course page for "' + c.name + '" — will come back to it later'); if (c.tries >= 3) c.status = 'error'; break; }
            const r2 = await openCourse(c); if (r2.loggedOut && !(await waitForLogin())) break;
            continue;
          }
          if (res.hasOpen) { if (++stall > 40) { c.status = 'error'; break; } await run(ap.tabId, apClose); await nap(jitter(900, 1800)); continue; }
          if (res.expanded) { if (++stall > 60) { c.status = 'error'; break; } await nap(jitter(900, 2000)); continue; }
          if (res.done) { c.status = 'done'; break; }
          if (!res.opened) { c.status = 'error'; break; }
          stall = 0;

          await watch(c, res);
          if (stopReq) break;
          await run(ap.tabId, apClose);
          c.done.push(res.key);
          ap.stats.lectures++; count++;
          ap.daily = { day: dayKey(), count: todayCount() + 1 };
          await save();
          await nap(4000);                                    // let the transcript finish processing
          if (ap.settings.autoTxt) {
            try {
              const t = await autoDownloadTranscripts(res.title);
              if (t.saved) say('Transcript saved ✅ "' + res.title + '"' + (t.saved > 1 ? ' (+' + (t.saved - 1) + ' more)' : ''));
              else if (t.matched) say('Transcript for "' + res.title + '" was already saved earlier');
              else say('⚠️ No transcript was captured for "' + res.title + '" (Subtitles list has ' + t.listSize + ' items)');
            } catch (e) { say('⚠️ Transcript download problem: ' + e.message); }
          }
          if (ap.settings.autoVid) {
            try {
              const n = await autoDownloadVideos();
              if (n) say('Video queued 📥 "' + res.title + '" — ' + vidPending + ' in the download queue');
              else {
                const vl = await self.SubLib.readVLib();
                if (!vl.some((v) => v.place && sameLecture(v.userName || v.place.name, res.title))) say('⚠️ No video stream was captured for "' + res.title + '" (Videos list has ' + vl.length + ' items)');
              }
            } catch (e) { say('⚠️ Video download problem: ' + e.message); }
          }
          const longBreak = count % jitter(5, 8) === 0;
          if (longBreak) say('Short break before the next lecture ...');
          if (!(await nap(longBreak ? jitter(60000, 150000) : jitter(5000, 12000)))) break;
        }
        await save();
        if (stopReq) break;
        if (c.status === 'done') {
          say('Finished course: ' + c.name + ' ✅');
          if (ap.courses.some((x) => x.on && x.status !== 'done' && x.status !== 'error')) { say('Break between courses (2–5 min) ...'); await nap(jitter(120000, 300000)); }
        }
      }
    } catch (e) {
      say('Autopilot error: ' + ((e && e.message) || e) + ' — it will try to continue in a minute');
    } finally {
      loopActive = false;
      if (stopReq && ap) { ap.running = false; if (!stopReason) say('Stopped by you. Press Resume to continue from here.'); }
      live = null;
      if (ap && ap.courses.forEach) ap.courses.forEach((c) => { if (c.status === 'running' && !ap.running) c.status = 'waiting'; });
      await save();
      if (!ap || !ap.running) chrome.alarms.clear('autopilot-watchdog');
      emit({ done: true });
    }
  }

  // Watchdog: if Chrome stopped the background script mid-run, start again from the saved state.
  chrome.alarms.onAlarm.addListener(async (a) => {
    if (a.name !== 'autopilot-watchdog' || loopActive) return;
    await load();
    if (ap.running) loop();
    else chrome.alarms.clear('autopilot-watchdog');
  });

  // Count data used by the INE player during an autopilot run (towards the daily limit).
  chrome.webRequest.onCompleted.addListener((d) => {
    if (!loopActive || !ap || d.tabId !== ap.tabId || d.fromCache || typeof addDataUsage !== 'function') return;
    const h = (d.responseHeaders || []).find((x) => x.name.toLowerCase() === 'content-length');
    const n = h ? parseInt(h.value, 10) : 0;
    if (n > 0) addDataUsage(n);
  }, { urls: ['<all_urls>'] }, ['responseHeaders']);

  // NOTE (v1.12.2): no chrome.downloads.onDeterminingFilename listener here. While any such
  // listener exists, Chrome ignores the filename this extension gives its own downloads
  // (videos/transcripts were saved as random IDs in v1.12.0-1.12.1).

  // ---------------------------------------------------------------- messages from the popup
  chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m || typeof m.action !== 'string' || !m.action.startsWith('ap:')) return false;
    (async () => {
      if (!loopActive || !ap) await load();   // never replace the state a running loop is using
      switch (m.action) {
        case 'ap:state': {
          let video = null;
          try {
            for (const d of Object.values(typeof downloadState === 'object' ? downloadState : {})) {
              if (!d || d.isTranscript || !['starting', 'downloading'].includes(d.status)) continue;
              video = { name: String(d.filename || '').split('/').pop().replace(/\.[^.]+$/, ''), percent: d.percent || 0, text: d.statusText || '' };
              break;
            }
          } catch (e) { /* ignore */ }
          return { ap, live, active: loopActive, video, vidPending, today: todayCount(), blockedUntil: ap.blockedUntil || 0, runEndsAt: ap.runEndsAt || 0 };
        }
        case 'ap:scan': {
          const r = await run(m.tabId, apScanPath);
          if (!r) return { ok: false, error: 'Could not read this page. Reload it and try again.' };
          if (!r.items.length) return { ok: false, error: 'No courses found here. Open the learning path page (the one listing all courses), scroll to the bottom once, then try again.' };
          if (ap.running || loopActive) return { ok: false, error: 'Stop the autopilot before scanning a new path.' };
          const old = new Map((ap.courses || []).map((c) => [c.name, c]));
          ap.pathUrl = r.url.split('#')[0]; ap.pathName = r.title;
          ap.courses = r.items.filter((x) => x.name).map((x) => {
            const prev = old.get(x.name);
            const isCourse = x.type === 'course';
            return Object.assign({ name: x.name, type: x.type, section: x.section, sectionNo: x.sectionNo, tileIndex: x.tileIndex, pct: x.pct, dur: x.dur,
              on: isCourse && x.pct < 100, status: 'waiting', done: [], url: '' }, prev ? { on: prev.on, status: prev.status === 'running' ? 'waiting' : prev.status, done: prev.done || [], url: prev.url || '' } : {});
          });
          ap.current = -1; ap.tabId = m.tabId;
          ap.since = Date.now(); ap.dlTxt = []; ap.dlVid = [];
          say('Queued ' + ap.courses.filter((c) => c.on).length + ' of ' + ap.courses.length + ' items from "' + ap.pathName + '"');
          await save();
          return { ok: true };
        }
        case 'ap:addCourse': {      // just the course page that is open now
          if (ap.running || loopActive) return { ok: false, error: 'Stop the autopilot first.' };
          const t = await tabAlive(m.tabId);
          const r = await run(m.tabId, apCourseReady);
          if (!t || !r || !r.ready) return { ok: false, error: 'Open a course page (with its lecture list) first.' };
          const name = (t.title || 'Course').replace(/\s*[|-]\s*INE.*$/i, '').trim();
          const url = t.url.split('#')[0];
          if (!ap.courses.some((c) => c.url === url)) ap.courses.push({ name, type: 'course', section: '', sectionNo: '', tileIndex: -1, pct: 0, on: true, status: 'waiting', done: [], url });
          ap.tabId = m.tabId;
          say('Added this course: ' + name);
          await save();
          return { ok: true };
        }
        case 'ap:toggle': {
          const c = ap.courses[m.index]; if (c) { c.on = !!m.on; if (m.on && c.status === 'error') { c.status = 'waiting'; c.tries = 0; } }
          await save(); return { ok: true };
        }
        case 'ap:all': ap.courses.forEach((c) => { c.on = m.on && (m.coursesOnly ? c.type === 'course' : true); }); await save(); return { ok: true };
        case 'ap:redo': { const c = ap.courses[m.index]; if (c) { c.status = 'waiting'; c.done = []; c.tries = 0; c.on = true; } await save(); return { ok: true }; }
        case 'ap:settings': ap.settings = Object.assign({}, DEFAULT_SETTINGS, ap.settings, m.settings || {}); await save(); return { ok: true };
        case 'ap:start': {
          if (loopActive) return { ok: false, error: 'Already running' };
          if (self.SubLib.isAutoCapRunning && self.SubLib.isAutoCapRunning()) return { ok: false, error: 'Stop the quick "Auto-capture" run first.' };
          if (!ap.courses.some((c) => c.on && c.status !== 'done')) return { ok: false, error: 'Nothing queued. Scan a learning path or add a course first.' };
          if (ap.blockedUntil && Date.now() < ap.blockedUntil) {
            const h = Math.ceil((ap.blockedUntil - Date.now()) / 3600000);
            return { ok: false, error: '⛔ INE\'s daily viewing limit was reached. Autopilot is blocked until ' + new Date(ap.blockedUntil).toLocaleString() + ' (about ' + h + ' h). Watching more now would only hit the limit again.' };
          }
          { const cap = parseInt(ap.settings.maxPerDay, 10) || 0;
            if (cap > 0 && todayCount() >= cap) return { ok: false, error: '🛑 Daily lecture cap reached (' + todayCount() + '/' + cap + ' today). Resume tomorrow, or raise "Max lectures per day".' }; }
          ap.tabId = m.tabId || ap.tabId;
          if (!ap.since) ap.since = Date.now();
          { const rl = parseInt(ap.settings.runLimitMin, 10) || 0; ap.runEndsAt = rl > 0 ? Date.now() + rl * 60000 : 0; }
          ap.running = true; ap.retriedErrors = false; await save();
          loop();
          return { ok: true };
        }
        case 'ap:stop':
          stopReq = true;
          if (!loopActive) { ap.running = false; await save(); }
          return { ok: true };
        case 'ap:clear':
          if (loopActive) return { ok: false, error: 'Stop it first.' };
          { const keep = { settings: ap.settings, dlTxt: ap.dlTxt, dlVid: ap.dlVid, dlNb: ap.dlNb }; ap = Object.assign(fresh(), keep); }
          await save(); return { ok: true };
        default: return { ok: false, error: 'unknown' };
      }
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });

  // Background restarted (e.g. Chrome woke it up again) while a run was active: continue it.
  load().then(() => { if (ap.running) setTimeout(loop, 3000); });
})();
