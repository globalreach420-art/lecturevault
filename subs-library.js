// ============================================================================
// SUBTITLE LIBRARY (loaded by background.js via importScripts)
//
// While you play lectures, every subtitle/transcript the page loads is captured,
// labelled with a language, and its TEXT is cached in chrome.storage.local right
// away (signed URLs expire; this way batch downloads still work later).
// Entries live in ONE global list, so they survive page navigations and tab
// switches until you clear them.
//
// Storage keys
//   subtitleLibrary     [ { id, url, type, name, userName, order, fp, section, pageTitle,
//                           pageUrl, tabId, langCode, langName, langSource, cues,
//                           durationSec, chars, hasContent, error, detectedAt } ]
//   subtext_<id>        raw subtitle text (HLS subtitle tracks are assembled into one VTT)
//   subtitleCandidates  last requests that *looked* like captions (diagnostics)
//   subtitleNaming      { [host]: { source, titleSel, sectionSel } }  how lecture names are read per site
//   subtitlePrefs       popup settings (englishOnly, format, folder ...)
// ============================================================================
(function () {
  'use strict';
  const U = self.SubUtils;
  const LIB_KEY = 'subtitleLibrary';
  const CAND_KEY = 'subtitleCandidates';
  const NAMING_KEY = 'subtitleNaming';
  const PREFS_KEY = 'subtitlePrefs';
  const TEXT_PREFIX = 'subtext_';
  const MAX_ENTRIES = 600;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- serialised access to the library (service workers can run handlers concurrently)
  let chain = Promise.resolve();
  function withLock(fn) {
    const p = chain.then(() => fn());
    chain = p.catch(() => {});
    return p;
  }
  async function readLib() {
    const d = await chrome.storage.local.get(LIB_KEY);
    return d[LIB_KEY] || [];
  }
  function writeLib(list) { return chrome.storage.local.set({ [LIB_KEY]: list }); }
  function updateEntry(id, patch) {
    return withLock(async () => {
      const lib = await readLib();
      const e = lib.find((x) => x.id === id);
      if (!e) return null;
      Object.assign(e, patch);
      await writeLib(lib);
      return e;
    });
  }

  async function getPrefs() {
    const p = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] || {};
    return { englishOnly: p.englishOnly !== false };
  }
  async function getNamingAll() { return (await chrome.storage.local.get(NAMING_KEY))[NAMING_KEY] || {}; }
  async function getNaming(host) {
    const all = await getNamingAll();
    return Object.assign({ source: 'auto', titleSel: '', sectionSel: '', categorySel: '', courseSel: '' }, all[host] || {});
  }
  function setNaming(host, patch) {
    return withLock(async () => {
      const all = await getNamingAll();
      all[host] = Object.assign({ source: 'auto', titleSel: '', sectionSel: '' }, all[host] || {}, patch);
      await chrome.storage.local.set({ [NAMING_KEY]: all });
      return all[host];
    });
  }

  // ---- what looks like a subtitle? ------------------------------------------
  const SEGMENT_NAME = /(seg|segment|chunk|frag|fragment|part)[-_]?\d+\.(web)?vtt/i;
  function looksLikeSegment(url) {
    try { return SEGMENT_NAME.test(new URL(url).pathname); } catch (e) { return false; }
  }

  function sniffSubtitleType(url) {
    let path = '', query = '';
    try { const u = new URL(url); path = u.pathname.toLowerCase(); query = u.search.toLowerCase(); } catch (e) { return null; }
    if (/\.(web)?vtt$/.test(path)) return 'VTT';
    if (/\.srt$/.test(path)) return 'SRT';
    if (/\.(ttml|dfxp)$/.test(path)) return 'TTML';
    if (/\.txt$/.test(path) && /(subtitle|caption|transcript)/.test(path + query)) return 'TXT';
    if (/[?&](format|fmt|type|ext)=(web)?vtt\b/.test(query) || /\.vtt(\?|&|$)/.test(query)) return 'VTT';
    if (/[?&](format|fmt|type|ext)=srt\b/.test(query)) return 'SRT';
    return null;
  }

  // ---- diagnostics: remember anything that smells like captions ----------------
  const CAND_RE = /(caption|subtitle|transcript|\.vtt|\.srt|webvtt|texttrack|text_track|timedtext|\.ttml|\.dfxp|closed.?caption)/i;
  const NOISE_RE = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|css|js|map)(\?|$)/i;
  let candCache = null, candTimer = null;
  async function noteCandidate(url, tabId, via) {
    try {
      if (!CAND_RE.test(url) || NOISE_RE.test(url.split('#')[0])) return;
      if (!candCache) candCache = (await chrome.storage.local.get(CAND_KEY))[CAND_KEY] || [];
      if (candCache.some((c) => c.url === url)) return;
      candCache.push({ t: Date.now(), tabId, via, url: url.slice(0, 400) });
      if (candCache.length > 40) candCache.shift();
      clearTimeout(candTimer);
      candTimer = setTimeout(() => chrome.storage.local.set({ [CAND_KEY]: candCache }), 500);
    } catch (e) { /* diagnostics only */ }
  }

  // ---- reading the lecture page --------------------------------------------------
  // Runs INSIDE the page; must be fully self-contained. cfg = { titleSel, sectionSel }.
  // Returns every plausible "lecture name" with the place it came from, so the user
  // can choose which source is right for this site.
  function pageSnapshot(cfg) {
    cfg = cfg || {};
    const out = { isTop: window === window.top, host: location.hostname, pageTitle: document.title || '', pageUrl: location.href, cands: [], section: '', tracks: [] };
    try {
      document.querySelectorAll('video').forEach((v) => {
        for (const t of (v.textTracks || [])) {
          if (t.kind === 'subtitles' || t.kind === 'captions') out.tracks.push({ label: t.label || '', language: t.language || '', mode: t.mode || '' });
        }
      });
    } catch (e) { /* ignore */ }
    if (!out.isTop) return out;

    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const short = (s) => { s = clean(s); return s && s.length <= 140 ? s : ''; };
    const firstLine = (el) => ((el.innerText || el.textContent || '').split('\n').map(clean).filter(Boolean)[0]) || '';
    // player menu entries ("1080p", "Auto", "1.5x"), player labels ("Video: ine-videos/..."), URLs and ids are never lecture names
    const JUNK_WORD = /^(auto|\d{3,4}p|\d+(\.\d+)?x|normal|off|on|captions?|subtitles?|english|settings|quality|speed|default|play|pause|mute|fullscreen|cc|video|lecture|\d+\s*(videos?|lessons?|items?)|\d{1,2}:\d{2}(:\d{2})?|completed?|in progress|locked|test your skills|(jump|skip|go) to( the)? [\w ]{2,20})$/i;
    const isJunk = (t) => !t || t.length < 3 || JUNK_WORD.test(t) || /^(video|player|media)\s*:/i.test(t) || /^https?:\/\//i.test(t) ||
      /^[\w.-]+\/[\w./-]+$/.test(t) || (!/\s/.test(t) && t.length >= 24);
    const IN_MENU = '[role="menu"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="listbox"],[class*="quality"],[class*="settings"],[class*="speed"],[class*="volume"],[class*="tooltip"]';
    const add = (src, text) => {
      text = short(text);
      if (text && !isJunk(text) && !out.cands.some((c) => c.src === src)) out.cands.push({ src, text });
    };
    const tryQ = (sel) => { try { return sel ? document.querySelector(sel) : null; } catch (e) { return null; } };
    const HEADISH = 'h1,h2,h3,h4,h5,h6,summary,button,[role="button"],[class*="title" i],[class*="header" i],[class*="heading" i],[class*="name" i]';

    // Where is this lecture inside the course outline? -> section title, section number, lecture number.
    function outlineOf(item) {
      const res = { section: '', sectionIndex: null, lessonIndex: null };
      const li = item.closest('li') || item;
      const peers = li.parentElement ? [...li.parentElement.children].filter((c) => c.tagName === li.tagName) : [];
      if (peers.length > 1) res.lessonIndex = peers.indexOf(li) + 1;
      let node = li.parentElement;
      for (let depth = 0; node && node !== document.body && depth < 7; depth++, node = node.parentElement) {
        // (a) header right before the list:  <h3>Section</h3><ul>...</ul>
        let h = node.previousElementSibling;
        if (h && !h.querySelector('video') && !isJunk(short(firstLine(h)))) {
          res.section = short(firstLine(h));
          const same = [...h.parentElement.children].filter((c) => c.tagName === h.tagName && c.className === h.className);
          if (same.length > 1) res.sectionIndex = same.indexOf(h) + 1;
          else {
            const box = h.parentElement, boxes = box.parentElement ? [...box.parentElement.children].filter((c) => c.tagName === box.tagName) : [];
            if (boxes.length > 1) res.sectionIndex = boxes.indexOf(box) + 1;
          }
          break;
        }
        // (b) header inside the same wrapper:  <div class="section"><button>Section</button><ul>...</ul></div>
        h = [...node.children].find((c) => !c.contains(li) && c.matches(HEADISH) && !isJunk(short(firstLine(c))));
        if (h) {
          res.section = short(firstLine(h));
          const boxes = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
          if (boxes.length > 1) res.sectionIndex = boxes.indexOf(node) + 1;
          break;
        }
      }
      return res;
    }

    // ---- course outline in the INE style:  Course > Category ("Windows") > Section card > activity rows ----
    // Every activity row shows a title and a duration ("17m 25s") or "1 question". The open one has a "Close" button.
    const DUR = /^(?:\d+\s*h(?:ours?)?\s*)?(?:\d+\s*m(?:in)?\s*)?(?:\d+\s*s(?:ec)?)?$/i;
    const isDur = (t) => !!t && /\d/.test(t) && (DUR.test(t) || /^\d{1,2}:\d{2}(:\d{2})?$/.test(t) || /^\d+\s+questions?$/i.test(t));
    const isQuiz = (t) => /^\d+\s+questions?$/i.test(t);
    const BTN = /^(close|restart( video)?|retake( quiz)?|resume|start|watch|play|continue|open|launch( lab)?|review|begin|start lab|completed?)$/i;
    const NOISE = /^(activities\s*:?\s*\d+|\d+\s*\/\s*\d+\s*items? finished|report an issue|jump to category|test your (knowledge|skills)\b.*|\d+\s*%|cyber security|networking|cloud|data science|development|it essentials|(volume|muted?|unmute|speed|playback( speed| rate)?|quality|captions?|subtitles?|settings|picture.in.picture|full ?screen|seek|progress|current time|duration|remaining time|chapters?|transcript)\b.*|\d+(\.\d+)?x|\d{1,2}:\d{2}(:\d{2})?\s*(\/\s*\d{1,2}:\d{2}(:\d{2})?)?)$/i;
    const ACTION = /^(close|restart( video)?|retake( quiz| lab)?|resume( video| lab)?|start( video| quiz| lab)?|continue|launch( lab)?|review( quiz)?|begin|open lab|view lab|watch( video)?)$/i;
    const meaningful = (t) => t && t.length > 2 && t.length <= 140 && /\p{L}{2}/u.test(t) && !isDur(t) && !BTN.test(t) && !NOISE.test(t) && !isJunk(t);
    const leavesOf = (root) => {
      const outL = []; if (!root) return outL;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const t = clean(n.nodeValue);
        if (!t || !n.parentElement || n.parentElement.closest('script,style,noscript,[aria-hidden="true"]')) continue;
        outL.push({ t, el: n.parentElement });
      }
      return outL;
    };
    const firstMeaningful = (root, skip) => { for (const l of leavesOf(root)) if (meaningful(l.t) && !(skip && skip(l.el))) return l; return null; };
    const inSiteChrome = (el) => !!el.closest('header, nav, footer, [role="navigation"], [role="banner"]');

    function ineOutline() {
      // the video player and its controls ("Volume 100%", "1x" ...) are never part of the names
      const players = [];
      document.querySelectorAll('video, iframe').forEach((m) => {
        let p = m;
        while (p.parentElement && p.parentElement !== document.body && !/\d+\s*m\s*\d*\s*s?\b|\bquestions?\b/i.test(p.parentElement.innerText || '')) p = p.parentElement;
        players.push(p);
      });
      const inPlayer = (el) => players.some((p) => p.contains(el));
      const all = leavesOf(document.body).filter((l) => !inSiteChrome(l.el) && !inPlayer(l.el));

      // every activity (video, quiz, lab) has exactly one action button: "Restart video", "Start quiz", "Start lab", "Close" ...
      // (INE's buttons are not always <button>: any element whose own text is an action word counts)
      const actions = [];
      for (const l of leavesOf(document.body)) {
        if (!ACTION.test(l.t) || inSiteChrome(l.el) || inPlayer(l.el)) continue;
        const b = l.el.closest('button, a, [role="button"]') || l.el;
        if (!actions.includes(b)) actions.push(b);
      }
      const rows = [];
      const meaningCount = (el) => leavesOf(el).filter((x) => meaningful(x.t) && !inPlayer(x.el)).length;
      const rowOf = (start, anchors) => {
        let r = start;
        for (let i = 0; i < 9 && r.parentElement && r.parentElement !== document.body; i++) {
          const p = r.parentElement;
          if (anchors.filter((x) => p.contains(x)).length > 1) break;
          // a card with a single activity: stop before swallowing the card title ("Linux Vulnerabilities")
          const mine = meaningCount(r);
          if (mine > 0 && meaningCount(p) > mine) break;
          r = p;
        }
        return r;
      };
      const kindOf = (el) => {
        const t = leavesOf(el).filter((l) => !inPlayer(l.el)).map((l) => l.t);
        if (t.some((x) => /^\d+\s+questions?$/i.test(x))) return 'quiz';
        if (t.some((x) => isDur(x) && !/question/i.test(x))) return 'video';
        return 'other';
      };
      if (actions.length >= 1) {
        for (const b of actions) {
          const r = rowOf(b, actions);
          if (!rows.some((x) => x.el === r)) rows.push({ el: r, btn: b, kind: kindOf(r) });
        }
      } else {
        const durEls = all.filter((l) => isDur(l.t)).map((l) => l.el);
        for (const d of durEls) { const r = rowOf(d, durEls); if (!rows.some((x) => x.el === r)) rows.push({ el: r, btn: null, kind: kindOf(r) }); }
      }
      // INE course page where no card is opened yet: only the course trailer can be playing
      const pageHasCards = leavesOf(document.body).some((l) => /^(show|hide) details$/i.test(l.t));
      if (!rows.length) return pageHasCards ? { noCurrent: true } : null;
      // anything that sits in the same list as an activity and looks like one is an activity too (labs, readings ...)
      const cls = (el) => new Set(String(el.className || '').split(/\s+/).filter(Boolean));
      const looksSame = (a, b) => a.tagName === b.tagName && ([...cls(a)].some((c) => cls(b).has(c)) || (!cls(a).size && !cls(b).size));
      for (const r of rows.slice()) {
        const par = r.el.parentElement; if (!par) continue;
        for (const sib of par.children) {
          if (sib === r.el || rows.some((x) => x.el === sib) || !looksSame(sib, r.el) || sib.contains(r.el)) continue;
          rows.push({ el: sib, btn: null, kind: kindOf(sib) });
        }
      }
      rows.forEach((r) => { const h = firstMeaningful(r.el, inPlayer); r.title = h ? h.t : ''; });
      const inRow = (el) => rows.some((r) => r.el.contains(el));

      // which activity is open? the one whose button says "Close", else expanded/active.
      // (No fallback to "the row above the player": the course trailer at the top of the page is a player too.)
      let cur = rows.find((r) => r.btn && /^close$/i.test(clean(r.btn.innerText || r.btn.textContent))) ||
        rows.find((r) => leavesOf(r.el).some((l) => /^close$/i.test(l.t)));
      if (!cur) cur = rows.find((r) => r.el.querySelector('[aria-expanded="true"],[aria-current]') || /\b(active|current|playing|selected|is-open|expanded)\b/i.test(r.el.className || ''));
      if (!cur || !cur.title) return { noCurrent: true };

      const res = { title: cur.title, section: '', sectionIndex: null, lessonIndex: null, category: '', categoryIndex: null, durationSec: null };
      // the row's own length ("16m 27s"): used to tell this lecture's stream from the course trailer
      const durLeaf = leavesOf(cur.el).find((l) => isDur(l.t) && !/question/i.test(l.t));
      if (durLeaf) {
        const t = durLeaf.t.toLowerCase(); let sec = 0;
        const h = t.match(/(\d+)\s*h/), m = t.match(/(\d+)\s*m/), s2 = t.match(/(\d+)\s*s/), c = t.match(/^(\d+):(\d+)(?::(\d+))?$/);
        if (c) sec = c[3] ? (+c[1]) * 3600 + (+c[2]) * 60 + (+c[3]) : (+c[1]) * 60 + (+c[2]);
        else sec = (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s2 ? +s2[1] : 0);
        if (sec > 0) res.durationSec = sec;
      }

      // Every INE card (sub-section) has a "Show details" / "Hide details" link, open or collapsed.
      const MARK = /^(show|hide) details$/i;
      let markers = leavesOf(document.body).filter((l) => MARK.test(l.t) && !inSiteChrome(l.el)).map((l) => l.el);
      if (!markers.length) markers = leavesOf(document.body).filter((l) => /^activities\s*:?\s*\d+$/i.test(l.t)).map((l) => l.el);
      const markersIn = (el) => markers.filter((m) => el.contains(m)).length;
      const skipRP = (el) => inRow(el) || inPlayer(el);
      const cardOf = (marker) => {
        // smallest ancestor holding a real title (the card's left-panel title) ...
        let a = marker.parentElement, title = null;
        for (let i = 0; a && a !== document.body && i < 8; i++, a = a.parentElement) { const h = firstMeaningful(a, skipRP); if (h) { title = h; break; } }
        if (!title) return null;
        // ... grown while it still has only this card in it and still starts with that title
        while (a.parentElement && a.parentElement !== document.body && markersIn(a.parentElement) === 1) {
          const h = firstMeaningful(a.parentElement, skipRP);
          if (!h || h.el !== title.el) break;
          a = a.parentElement;
        }
        return { el: a, title };
      };
      const catOf = (card) => {
        for (let bx = card.el, i = 0; bx && bx !== document.body && i < 10; i++, bx = bx.parentElement) {
          for (let sib = bx.previousElementSibling; sib; sib = sib.previousElementSibling) {
            if (markersIn(sib) || inSiteChrome(sib) || inRow(sib)) continue;
            const h = firstMeaningful(sib, skipRP);
            if (h) return h;
          }
        }
        return null;
      };

      if (markers.length) {
        let myMarker = null;
        for (let n = cur.el.parentElement; n && n !== document.body; n = n.parentElement) {
          const inside = markers.filter((m) => n.contains(m));
          if (inside.length === 1) { myMarker = inside[0]; break; }
          if (inside.length > 1) break;
        }
        if (myMarker) {
          const cards = markers.map((m) => { const c = cardOf(m); return c ? { marker: m, el: c.el, title: c.title, cat: catOf(c) } : null; }).filter(Boolean);
          const mine = cards.find((c) => c.marker === myMarker);
          if (mine) {
            res.section = mine.title.t;
            // categories in page order, counted through the cards (the sticky header at the top is never one of them)
            const cats = [];
            cards.forEach((c) => { if (c.cat && !cats.some((x) => x.el === c.cat.el)) cats.push(c.cat); });
            if (mine.cat) {
              res.category = mine.cat.t;
              res.categoryIndex = cats.findIndex((x) => x.el === mine.cat.el) + 1;
              const same = cards.filter((c) => c.cat && c.cat.el === mine.cat.el);
              res.sectionIndex = same.indexOf(mine) + 1;
            } else {
              res.sectionIndex = cards.indexOf(mine) + 1;
            }
            const vids = rows.filter((r) => r.kind === 'video' && mine.el.contains(r.el))
              .sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
            if (cur.kind === 'video' && vids.includes(cur)) res.lessonIndex = vids.indexOf(cur) + 1;
            return res;
          }
        }
      }

      // ---- other sites: card = first ancestor with a title outside the rows ----
      let card = null;
      for (let node = cur.el.parentElement, i = 0; node && node !== document.body && i < 10; i++, node = node.parentElement) {
        const h = firstMeaningful(node, skipRP);
        if (h) { card = node; res.section = h.t; break; }
      }
      const vids = rows.filter((r) => r.kind === 'video' && (card ? card.contains(r.el) : true))
        .sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      if (cur.kind === 'video' && vids.includes(cur)) res.lessonIndex = vids.indexOf(cur) + 1;
      if (!card) return res;
      const sibCards = [...card.parentElement.children].filter((c) => looksSame(c, card));
      if (sibCards.length > 1) res.sectionIndex = sibCards.indexOf(card) + 1;
      const h = catOf({ el: card });
      if (h) res.category = h.t;
      return res;
    }

    // 1) selectors the user picked on this site override everything
    const pickedTxt = (sel) => { const e = tryQ(sel); return e ? short(firstLine(e) || e.textContent) : ''; };
    const picked = tryQ(cfg.titleSel);
    if (picked) add('selector', firstLine(picked) || picked.textContent);

    // 2) course outline (INE style); fall back to a highlighted sidebar item for other sites
    let ine = null;
    try { ine = ineOutline(); } catch (e) { /* ignore */ }
    // INE course page with no lecture open (only the course trailer at the top can be playing)
    if (ine && ine.noCurrent) { out.noLecture = true; ine = null; }
    if (ine) add('row', ine.title);
    const ACTIVE = '[aria-current="true"],[aria-current="page"],[aria-current="step"],li.active,li.current,li.selected,a.active,a.current,a.selected,' +
      '[class*="lesson"][class*="active"],[class*="lesson"][class*="current"],[class*="item"][class*="active"],[class*="item"][class*="current"],' +
      '[class*="playing"],[class*="now-playing"],[class*="is-active"],[class*="is-current"],[class*="selected"]';
    let activeEl = null;
    try {
      for (const el of (out.noLecture ? [] : document.querySelectorAll(ACTIVE))) {
        if (el.closest('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, header, nav, [role="tablist"]') || el.closest(IN_MENU) || el.querySelector('video')) continue;
        const t = short(firstLine(el));
        if (!isJunk(t) && !NOISE.test(t)) { add('active', t); activeEl = el; break; }
      }
    } catch (e) { /* ignore */ }
    let outline = { section: '', sectionIndex: null, lessonIndex: null, category: '', categoryIndex: null };
    if (ine) outline = ine;
    else if (activeEl || picked) { try { Object.assign(outline, outlineOf(activeEl || picked)); } catch (e) { /* ignore */ } }
    if (cfg.sectionSel && pickedTxt(cfg.sectionSel)) outline.section = pickedTxt(cfg.sectionSel);
    if (cfg.categorySel && pickedTxt(cfg.categorySel)) outline.category = pickedTxt(cfg.categorySel);

    // course: picked > page heading (if it is not the category) > tab title ("Explore <course> | INE")
    let course = pickedTxt(cfg.courseSel);
    if (!course) {
      const h1el = document.querySelector('main h1, [role="main"] h1, h1');
      const h1t = h1el ? short(firstLine(h1el)) : '';
      if (h1t && meaningful(h1t) && h1t !== outline.category && h1t !== outline.section) course = h1t;
    }
    if (!course && /^explore\s+/i.test(clean(document.title))) course = clean(document.title).replace(/^explore\s+/i, '');   // INE: "Explore <course> | INE"
    outline.course = course.replace(/^explore\s+/i, '');
    out.outline = outline;
    out.section = outline.section || '';

    // 3) title the player itself publishes
    try { if (navigator.mediaSession && navigator.mediaSession.metadata) add('mediaSession', navigator.mediaSession.metadata.title); } catch (e) { /* ignore */ }

    // 4) headings, breadcrumb, video label, meta, document title
    const h1 = document.querySelector('main h1, [role="main"] h1, h1'); if (h1) add('h1', firstLine(h1));
    const bc = document.querySelector('[aria-label*="breadcrumb" i] li:last-child, .breadcrumb li:last-child, .breadcrumbs li:last-child, nav[aria-label*="breadcrumb" i] a:last-child');
    if (bc) add('breadcrumb', firstLine(bc));
    const vid = document.querySelector('video');
    if (vid) add('videoLabel', vid.getAttribute('aria-label') || vid.getAttribute('title') || '');
    const h2 = document.querySelector('main h2, [role="main"] h2, h2'); if (h2) add('h2', firstLine(h2));
    const og = document.querySelector('meta[property="og:title"]'); if (og) add('ogtitle', og.content);
    add('doctitle', document.title);
    return out;
  }

  const SOURCE_ORDER = ['selector', 'row', 'active', 'mediaSession', 'h1', 'breadcrumb', 'videoLabel', 'ogtitle', 'h2', 'doctitle'];
  function pickName(cands, source) {
    cands = cands || [];
    if (source && source !== 'auto') { const c = cands.find((x) => x.src === source); if (c) return c.text; }
    for (const s of SOURCE_ORDER) { const c = cands.find((x) => x.src === s); if (c) return c.text; }
    return '';
  }

  async function hostOfTab(tabId) {
    try { return new URL((await chrome.tabs.get(tabId)).url).hostname; } catch (e) { return ''; }
  }

  async function snapshotPage(tabId) {
    const snap = { host: '', cands: [], section: '', pageTitle: '', pageUrl: '', tracks: [] };
    if (tabId === undefined || tabId < 0) return snap;
    try {
      const host = await hostOfTab(tabId);
      const naming = await getNaming(host);
      const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageSnapshot, args: [{ titleSel: naming.titleSel, sectionSel: naming.sectionSel, categorySel: naming.categorySel, courseSel: naming.courseSel }] });
      for (const r of res || []) {
        const v = r && r.result;
        if (!v) continue;
        snap.tracks.push(...(v.tracks || []));
        if (v.isTop) { snap.host = v.host; snap.cands = v.cands; snap.section = v.section; snap.outline = v.outline || null; snap.noLecture = !!v.noLecture; snap.pageTitle = v.pageTitle; snap.pageUrl = v.pageUrl; }
      }
      snap.naming = naming;
      // remember the category order of each course, so numbers stay right even if INE shows one category at a time
      const o = snap.outline;
      if (o && o.course && o.category) {
        const store = (await chrome.storage.local.get('courseCategories')).courseCategories || {};
        let list = store[o.course] || [];
        if (o.categoryList && o.categoryList.includes(o.category)) list = o.categoryList;
        if (o.categoryIndex && !list[o.categoryIndex - 1]) { list = list.slice(); list[o.categoryIndex - 1] = o.category; }
        if (JSON.stringify(list) !== JSON.stringify(store[o.course] || [])) { store[o.course] = list; await chrome.storage.local.set({ courseCategories: store }); }
        if (!o.categoryIndex && list.indexOf(o.category) !== -1) o.categoryIndex = list.indexOf(o.category) + 1;
      }
    } catch (e) { /* restricted page or tab gone */ }
    return snap;
  }
  // Lecture title + place in the course, cleaned: { name, lessonIndex, section, sectionIndex }
  function placeFromSnap(snap) {
    const raw = pickName(snap.cands, snap.naming && snap.naming.source);
    const o = snap.outline || {};
    const t = U.splitNumber(raw), sct = U.splitNumber(o.section || snap.section || ''), cat = U.splitNumber(o.category || '');
    return {
      name: U.tidyTitle(t.rest, 60),
      lessonIndex: o.lessonIndex || t.n || null,
      section: U.tidyTitle(sct.rest, 45),
      sectionIndex: o.sectionIndex || sct.n || null,
      category: U.tidyTitle(cat.rest, 40),
      categoryIndex: o.categoryIndex || cat.n || null,
      course: U.tidyTitle(o.course || '', 80),
      durationSec: o.durationSec || null,
      // no lecture is open (e.g. only the course trailer plays) and the user did not pick a title element
      noLecture: !!snap.noLecture && !(snap.naming && snap.naming.titleSel)
    };
  }
  const nameFromSnap = (snap) => placeFromSnap(snap).name;
  async function snapshotLecture(tabId) {
    let snap = await snapshotPage(tabId);
    for (const wait of [1200, 2500]) {
      if (!placeFromSnap(snap).noLecture) break;
      await sleep(wait);
      snap = await snapshotPage(tabId);
    }
    return snap;
  }
  // Does a stream / subtitle of this length belong to the open lecture? (rejects the course trailer)
  function lengthMatches(place, seconds) {
    if (!place || !place.durationSec || !seconds) return true;
    return Math.abs(seconds - place.durationSec) <= Math.max(45, place.durationSec * 0.08);
  }

  // ---- language resolution -----------------------------------------------------
  function resolveLanguage({ hls, url, snap }) {
    if (hls && (hls.language || hls.name)) {
      const code = hls.language ? String(hls.language).toLowerCase() : U.codeForName(hls.name);
      return { langCode: code || null, langName: U.nameForCode(hls.language) || hls.name || hls.language, langSource: 'manifest' };
    }
    const tracks = (snap && snap.tracks) || [];
    const showing = tracks.filter((t) => t.mode === 'showing');
    const fromTrack = (t) => {
      const code = (t.language || '').toLowerCase() || U.codeForName(t.label);
      return { langCode: code || null, langName: U.nameForCode(t.language) || t.label || t.language, langSource: 'player' };
    };
    if (showing.length === 1 && (showing[0].language || showing[0].label)) return fromTrack(showing[0]);
    const g = U.guessLanguageFromUrl(url);
    if (g) return { langCode: g.code, langName: g.name, langSource: 'url' };
    if (tracks.length === 1 && (tracks[0].language || tracks[0].label)) return fromTrack(tracks[0]);
    return { langCode: null, langName: null, langSource: null };
  }

  // ---- fetching the text ---------------------------------------------------------
  async function fetchText(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  async function fetchHlsSubtitle(playlistUrl) {
    const text = await fetchText(playlistUrl);
    if (!text.includes('#EXTM3U')) throw new Error('not a playlist');
    const segs = U.mediaPlaylistSegments(text, playlistUrl);
    if (!segs.length) throw new Error('empty subtitle playlist');
    segs.forEach((s) => hlsSegs.add(U.urlKey(s)));
    const parts = new Array(segs.length);
    let next = 0;
    const worker = async () => {
      while (next < segs.length) { const i = next++; parts[i] = await fetchText(segs[i]); }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return U.mergeVttSegments(parts);
  }

  function sniffTypeFromText(text, fallback) {
    const head = text.replace(/^﻿/, '').trimStart().slice(0, 300);
    if (/^WEBVTT/.test(head)) return 'VTT';
    if (/<tt[\s>]|<\?xml/i.test(head)) return /<tt[\s>]/i.test(text.slice(0, 2000)) ? 'TTML' : null;
    if (/^\d+\s*\n\s*[\d:,]+\s+-->/.test(head)) return 'SRT';
    if (/-->/.test(text.slice(0, 2000))) return fallback === 'SRT' ? 'SRT' : 'VTT';
    return null; // HTML error page, JSON, etc.
  }

  // ---- registering a subtitle ----------------------------------------------------
  const hlsSegs = new Set();      // urlKeys of WebVTT *segments* of HLS subtitle tracks (not subtitles themselves)
  const inFlight = new Set();
  const pendingMeta = {};         // id -> explicit language info that arrived while another registration was running

  async function registerSubtitle({ tabId, url, type, hls }) {
    const key = U.urlKey(url);
    const id = U.hashId(key);

    if (inFlight.has(id)) { if (hls) pendingMeta[id] = hls; return; }
    inFlight.add(id);
    try {
      // Is this URL just one segment of an HLS subtitle track? Give classifyHls a moment to learn that.
      await sleep(250);
      if (hlsSegs.has(key) || (type !== 'HLS-VTT' && looksLikeSegment(url))) return;

      const prefs = await getPrefs();
      const lib0 = await readLib();
      const existing = lib0.find((e) => e.id === id);
      if (existing) {
        const patch = {};
        if (existing.url !== url) patch.url = url;
        const meta = hls || pendingMeta[id];
        if (meta && existing.langSource !== 'manifest') Object.assign(patch, resolveLanguage({ hls: meta, url }));
        if (Object.keys(patch).length) await updateEntry(id, patch);
        if (existing.hasContent) return;
      }

      // Declared language (stream manifest / <track srclang>) says it is not English: skip without even downloading it.
      const declared = resolveLanguage({ hls: hls || pendingMeta[id], url });
      if (prefs.englishOnly && declared.langSource === 'manifest' && !U.isEnglish(declared.langCode, declared.langName)) return;

      // Read the lecture title NOW: the viewer may move on to the next lecture within seconds.
      const snap = await snapshotLecture(tabId);
      await sleep(600);
      if (hlsSegs.has(key)) return;
      let lang = resolveLanguage({ hls: hls || pendingMeta[id], url, snap });
      if (prefs.englishOnly && lang.langSource === 'player' && lang.langName && !U.isEnglish(lang.langCode, lang.langName)) return;

      let text = null, error = null, realType = type;
      try {
        text = type === 'HLS-VTT' ? await fetchHlsSubtitle(url) : await fetchText(url);
        if (type !== 'HLS-VTT') {
          realType = sniffTypeFromText(text, type);
          if (!realType) { text = null; error = 'Not a subtitle file'; }
        }
      } catch (e) { error = String((e && e.message) || e); }

      let cues = [], plain = '';
      if (text) {
        cues = U.parseAnyCues(text, realType);
        if (!cues.length) return;          // an empty/preflight track: ignore completely
        if (U.isThumbnailCues(cues)) return; // player thumbnail/storyboard track (cues are image URLs), not captions
        plain = U.toPlainText(cues);
        // The text itself is the final word on language (URL/player hints can be wrong).
        const g = U.detectLanguageFromText(plain);
        if (g && (!lang.langName || lang.langSource === 'url')) lang = { langCode: U.codeForName(g), langName: g, langSource: 'text' };
        if (prefs.englishOnly) {
          if (g && g !== 'English') return;                                               // clearly another language
          if (!g && !U.isEnglish(lang.langCode, lang.langName)) return;   // no proof it is English
        }
      } else if (prefs.englishOnly && !U.isEnglish(lang.langCode, lang.langName)) {
        return;
      }
      const stats = U.cueStats(cues);
      const fp = text ? U.fingerprint(plain, stats.cues, stats.durationSec) : '';
      const stem = (() => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop().replace(/\.[^.]+$/, '')); } catch (e) { return ''; } })();
      const now = Date.now();
      const place = placeFromSnap(snap);
      if (place.noLecture) return;                                  // course trailer captions, no lecture open
      if (place.durationSec && stats.durationSec && stats.durationSec < place.durationSec * 0.5) return;   // trailer captions while a lecture is open

      const entry = {
        id, url, type: realType || type, name: place.name || (U.isJunkName(stem) ? '' : U.tidyTitle(stem, 60)) || 'Lecture',
        userName: '', order: now, fp, section: place.section, sectionIndex: place.sectionIndex, lessonIndex: place.lessonIndex, category: place.category, categoryIndex: place.categoryIndex, course: place.course, pageTitle: snap.pageTitle, pageUrl: snap.pageUrl, tabId,
        langCode: lang.langCode, langName: lang.langName, langSource: lang.langSource,
        cues: stats.cues, durationSec: stats.durationSec, chars: plain.length,
        hasContent: !!text, error, detectedAt: now, v15: true
      };

      let added = false;
      await withLock(async () => {
        const lib = await readLib();
        // Same text already captured under another URL (different token, CDN host, manifest vs direct file ...)
        if (fp && lib.some((e) => e.id !== id && e.fp === fp && (e.langName || '') === (entry.langName || ''))) return;
        const i = lib.findIndex((e) => e.id === id);
        if (i !== -1) { entry.userName = lib[i].userName || ''; entry.detectedAt = lib[i].detectedAt; entry.order = lib[i].order || lib[i].detectedAt; lib[i] = entry; } else lib.push(entry);
        const dropped = lib.length > MAX_ENTRIES ? lib.splice(0, lib.length - MAX_ENTRIES) : [];
        const toWrite = { [LIB_KEY]: lib };
        if (text) toWrite[TEXT_PREFIX + id] = text;
        await chrome.storage.local.set(toWrite);
        if (dropped.length) await chrome.storage.local.remove(dropped.map((e) => TEXT_PREFIX + e.id));
        added = true;
      });
      if (added) refreshBadge(tabId);
    } catch (e) {
      console.warn('registerSubtitle failed', e);
    } finally {
      inFlight.delete(id);
      delete pendingMeta[id];
    }
  }

  // ---- HLS: subtitle renditions & subtitle playlists ---------------------------------
  const hlsSeen = new Set();
  async function classifyHls(tabId, url) {
    const key = U.urlKey(url);
    if (hlsSeen.has(key)) return;
    hlsSeen.add(key);
    if (hlsSeen.size > 2000) hlsSeen.clear();
    try {
      const text = await fetchText(url);
      if (!text.includes('#EXTM3U')) return;

      const subs = U.parseMasterSubtitles(text, url);
      if (subs.length) {
        const prefs = await getPrefs();
        subs.forEach((s) => {
          // INE-style masters list dozens of languages; with "English only" on, don't even look at the others.
          if (prefs.englishOnly && !U.isEnglish(s.language, s.name)) return;
          registerSubtitle({ tabId, url: s.uri, type: 'HLS-VTT', hls: { language: s.language, name: s.name } });
        });
        return;
      }
      if (U.isSubtitleMediaPlaylist(text, url)) {
        U.mediaPlaylistSegments(text, url).forEach((s) => hlsSegs.add(U.urlKey(s)));
        markAsSubtitleTrack(tabId, url);
        registerSubtitle({ tabId, url, type: 'HLS-VTT' });
      }
    } catch (e) { /* not fetchable: leave it as a video entry */ }
  }

  // A subtitle playlist was first listed as an "HLS video" by the original sniffer; hide it there.
  function markAsSubtitleTrack(tabId, url) {
    try {
      const list = detectedVideos[tabId] || [];
      const v = list.find((x) => x.url === url);
      if (v) { v.isSubtitleTrack = true; persistAndUpdate(tabId); }
    } catch (e) { /* ignore */ }
  }

  // ---- lecture name for a detected video (same naming rules as subtitles) -----------------
  async function attachLectureName(tabId, url) {
    try {
      await sleep(400);
      const snap = await snapshotLecture(tabId);
      const place = placeFromSnap(snap);
      const list = detectedVideos[tabId] || [];
      const v = list.find((x) => x.url === url);
      if (!v) return;
      if (place.noLecture) { v.notLecture = true; persistAndUpdate(tabId); return; }   // the course trailer
      if (place.name) { v.lectureName = place.name; v.place = place; persistAndUpdate(tabId); }
    } catch (e) { /* cosmetic */ }
  }

  // ---- toolbar badge: green = number of subtitles captured on this tab ----------------
  async function refreshBadge(tabId, videoCount) {
    if (tabId === undefined || tabId < 0) return;
    try {
      const lib = await readLib();
      const prefs = await getPrefs();
      const n = lib.filter((e) => e.tabId === tabId && (!prefs.englishOnly || U.isEnglish(e.langCode, e.langName))).length;
      if (videoCount === undefined) videoCount = ((detectedVideos[tabId] || []).filter((v) => !v.isSubtitleTrack && !v.duplicateOf)).length;
      const text = n > 0 ? String(n) : (videoCount > 0 ? String(videoCount) : '');
      chrome.action.setBadgeText({ tabId, text }).catch(() => {});   // tab may be closed already
      chrome.action.setBadgeBackgroundColor({ tabId, color: n > 0 ? '#10b981' : '#6366f1' }).catch(() => {});
    } catch (e) { /* tab may be gone */ }
  }

  // ---- saving files ---------------------------------------------------------------------
  let saveCounter = 0;
  const blobKeyByChromeId = {};

  chrome.downloads.onChanged.addListener((delta) => {
    const key = blobKeyByChromeId[delta.id];
    if (!key || !delta.state) return;
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      delete blobKeyByChromeId[delta.id];
      revokeBlobUrl(key);
    }
  });

  async function saveBlob(path, blob) {
    const key = 'subtmp_' + (++saveCounter);
    let url;
    try {
      url = await createBlobUrl(blob);
      blobUrlByDownloadId[key] = url;
    } catch (e) {
      if (blob.size > 8 * 1024 * 1024) throw e;
      url = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    }
    const chromeId = await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename: path, saveAs: false, conflictAction: /\.(txt|srt|vtt|zip)$/i.test(path) ? 'overwrite' : 'uniquify' }, (id) => {
        if (chrome.runtime.lastError || id === undefined) reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'download failed'));
        else resolve(id);
      });
    }).catch((e) => { if (blobUrlByDownloadId[key]) revokeBlobUrl(key); throw e; });
    if (blobUrlByDownloadId[key]) blobKeyByChromeId[chromeId] = key;
    return chromeId;
  }
  // Chrome on Windows renames files saved as text/plain to ".txt" (an .srt became a .txt).
  // Only real .txt files are sent as text/plain; everything else as a neutral type so the name is kept.
  const saveText = (path, text) => saveBlob(path, new Blob([text], { type: /\.txt$/i.test(path) ? 'text/plain;charset=utf-8' : 'application/octet-stream' }));

  function saveUrl(path, url) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename: path, saveAs: false, conflictAction: /\.(txt|srt|vtt|zip)$/i.test(path) ? 'overwrite' : 'uniquify' }, (id) => {
        if (chrome.runtime.lastError || id === undefined) reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'download failed'));
        else resolve(id);
      });
    });
  }

  const extFor = (type) => ({ VTT: 'vtt', 'HLS-VTT': 'vtt', SRT: 'srt', TTML: 'ttml', TXT: 'txt' }[type] || 'vtt');
  const pad = (n, total) => String(n).padStart(Math.max(2, String(total).length), '0');

  function broadcast(msg) {
    try { chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; }); } catch (e) { /* popup closed */ }
  }

  // options: { format: 'txt' | 'srt' | 'both', prefix, combine, zip, folder, structure }
  //  txt -> <folder>/Transcripts/<course>/<NN category>/<NN section>/<NN lecture>.txt
  //  srt -> <folder>/Lectures/<same path>/<NN lecture>.srt   (same name as the video, so players load it)
  async function downloadSubtitles(ids, options) {
    const opts = Object.assign({ format: 'both', prefix: true, combine: false, zip: false, folder: 'eJPT', structure: true }, options || {});
    if (opts.format === 'orig') opts.format = 'srt';
    if (opts.sectionFolders !== undefined && options.structure === undefined) opts.structure = !!opts.sectionFolders;
    const lib = await readLib();
    const byId = new Map(lib.map((e) => [e.id, e]));
    const selected = ids.map((id) => byId.get(id)).filter(Boolean);
    const items = selected.map((e) => ({ __id: e.id, entry: e, name: e.userName || e.name, course: e.course, category: e.category, categoryIndex: e.categoryIndex,
      section: e.section, sectionIndex: e.sectionIndex, lessonIndex: e.lessonIndex, order: e.order || e.detectedAt }));
    U.planNumbers(items);

    const jobs = [];
    const used = new Set();
    const uniq = (p) => { let q = p, n = 2; while (used.has(q.toLowerCase())) { q = p.replace(/(\.[^./]+)$/, ' (' + n + ')$1'); n++; } used.add(q.toLowerCase()); return q; };
    const folderName = U.niceName(opts.folder, 60) || 'eJPT';
    const join = (...parts) => parts.filter(Boolean).join('/');
    const root = opts.zip ? '' : folderName;
    const groups = new Map();   // course -> items (for the combined file)

    for (const it of items) {
      const e = it.entry;
      const dir = U.hierarchyDir(it, opts.structure);
      const tag = U.isEnglish(e.langCode, e.langName) ? '' : '.' + (e.langCode || 'xx');
      const stem = U.lectureStem(it, opts.prefix) + tag;
      it.label = (opts.structure && it.category ? String(it._cat).padStart(2, '0') + '.' : '') + (opts.structure && it.section ? String(it._sec).padStart(2, '0') + '.' : '') + String(it._lec).padStart(2, '0') + ' ' + U.lectureStem(it, false);
      if (opts.format === 'txt' || opts.format === 'both') jobs.push({ kind: 'txt', entry: e, it, path: uniq(join(root, 'Transcripts', dir, stem + '.txt')) });
      if (opts.format === 'srt' || opts.format === 'both') jobs.push({ kind: 'srt', entry: e, it, path: uniq(join(root, 'Lectures', dir, stem + '.srt')) });
      const gk = opts.structure ? (e.course || '') : '';
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(it);
    }
    jobs.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

    const total = jobs.length + (opts.combine ? groups.size : 0) + (opts.zip ? 1 : 0);
    let done = 0;
    const failed = [];
    const combined = new Map(); // course -> chunks
    const zipFiles = [];
    const enc = new TextEncoder();

    const rawTextOf = async (e) => {
      const d = await chrome.storage.local.get(TEXT_PREFIX + e.id);
      if (d[TEXT_PREFIX + e.id]) return d[TEXT_PREFIX + e.id];
      return e.type === 'HLS-VTT' ? fetchHlsSubtitle(e.url) : fetchText(e.url); // not cached: try live
    };
    const headerOf = (e) => ['# ' + (e.userName || e.name), e.course ? '# Course: ' + e.course : '', e.category ? '# Category: ' + e.category : '',
      e.section ? '# Section: ' + e.section : '', e.pageUrl ? '# Page: ' + e.pageUrl : ''].filter(Boolean).join('\n') + '\n\n';
    const emit = async (path, text) => { if (opts.zip) zipFiles.push({ path, data: enc.encode(text) }); else await saveText(path, text); };

    for (const job of jobs) {
      const e = job.entry;
      try {
        const raw = await rawTextOf(e);
        const cues = U.parseAnyCues(raw, e.type);
        if (!cues.length) throw new Error('no text found');
        if (job.kind === 'srt') {
          await emit(job.path, U.toSrt(cues));
        } else {
          const plain = U.toPlainText(cues);
          await emit(job.path, headerOf(e) + plain);
          if (opts.combine) {
            const gk = opts.structure ? (e.course || '') : '';
            if (!combined.has(gk)) combined.set(gk, []);
            combined.get(gk).push('===== ' + job.it.label + ' =====\n' + [e.category, e.section].filter(Boolean).join(' > ') + '\n\n' + plain);
          }
        }
      } catch (err) {
        failed.push({ name: e.userName || e.name, language: e.langName || 'Unknown', error: String((err && err.message) || err) });
      }
      done++;
      broadcast({ action: 'subBatchProgress', done, total, failed: failed.length });
      if (!opts.zip) await sleep(120);
    }

    if (opts.combine) {
      for (const [course, chunks] of combined) {
        try {
          const dir = opts.structure && course ? U.courseDir(course) : '';
          await emit(uniq(join(root, 'Transcripts', dir, '00 All transcripts.txt')), chunks.join('\n\n\n'));
        } catch (err) { failed.push({ name: 'combined file', language: '', error: String((err && err.message) || err) }); }
        done++;
        broadcast({ action: 'subBatchProgress', done, total, failed: failed.length });
      }
    }

    if (opts.zip) {
      try {
        if (!zipFiles.length) throw new Error('nothing to put in the zip');
        const bytes = U.makeZip(zipFiles);
        await saveBlob(folderName + '.zip', new Blob([bytes], { type: 'application/zip' }));
      } catch (err) { failed.push({ name: 'zip file', language: '', error: String((err && err.message) || err) }); }
      done++;
      broadcast({ action: 'subBatchProgress', done, total, failed: failed.length });
    }
    return { total, done, failed, zip: !!opts.zip, files: zipFiles.length };
  }

  // ---- sequential video batch (runs in the background, survives the popup closing) ------------
  const finalStatus = {};
  async function waitForDownload(downloadId, onTick) {
    let last = 'starting';
    for (;;) {
      const st = downloadState[downloadId];
      if (!st) return last === 'cancelled' || last === 'error' ? last : 'complete';
      last = st.status;
      if (onTick) try { onTick(st); } catch (e) { /* ignore */ }
      if (st.status === 'error') { await sleep(200); return 'error'; }
      await sleep(700);
    }
  }

  // ---- fresh start when the page is reloaded or another course is opened --------------------------
  async function resetTab(tabId, closed) {
    hlsSeen.clear(); hlsSegs.clear();
    // v1.12.0: captured subtitles/videos are KEPT when the tab navigates, reloads or closes
    // (they used to be wiped, e.g. after clicking a .ipynb download link). They are only
    // detached from the tab so a new page can't rename them. Use "Clear" to empty a list.
    await withLock(async () => {
      const lib = await readLib();
      if (lib.some((e) => e.tabId === tabId)) await writeLib(lib.map((e) => (e.tabId === tabId ? Object.assign({}, e, { tabId: -1 }) : e)));
      const vlib = await readVLib();
      if (vlib.some((v) => v.tabId === tabId)) await chrome.storage.local.set({ [VLIB_KEY]: vlib.map((v) => (v.tabId === tabId ? Object.assign({}, v, { tabId: -1 }) : v)) });
    });
    if (!closed) refreshBadge(tabId);
  }

  // ---- videos: a lasting list per lecture (survives page changes), in course order ----------------
  const VLIB_KEY = 'videoLibrary';
  const readVLib = async () => (await chrome.storage.local.get(VLIB_KEY))[VLIB_KEY] || [];
  const vSyncTimers = {};
  function syncVideoLib(tabId) {
    clearTimeout(vSyncTimers[tabId]);
    vSyncTimers[tabId] = setTimeout(() => withLock(async () => {
      // only streams whose length matches the open lecture's row ("16m 27s"); the course trailer never does
      const list = (detectedVideos[tabId] || []).filter((v) => !v.isSubtitleTrack && !v.duplicateOf && !v.notLecture && v.place && v.place.name &&
        !v.place.noLecture && (v.duration ? lengthMatches(v.place, v.duration) : !(/HLS/i.test(v.type || '') && v.place.durationSec)));
      if (!list.length) return;
      const vlib = await readVLib();
      let changed = false;
      for (const v of list) {
        const key = lectureKey(v.place);
        const id = U.hashId(key);
        const i = vlib.findIndex((e) => e.id === id);
        const data = { id, key, url: v.url, type: v.type, place: v.place, duration: v.duration || null, resolution: v.resolution || null,
          transcriptUrl: v.transcriptUrl || null, transcriptType: v.transcriptType || null, pageUrl: v.pageUrl || '', tabId };
        if (i === -1) { vlib.push(Object.assign(data, { userName: '', detectedAt: Date.now() })); changed = true; }
        else {
          const old = vlib[i];
          const merged = Object.assign({}, old, data, { duration: data.duration || old.duration, transcriptUrl: data.transcriptUrl || old.transcriptUrl, transcriptType: data.transcriptType || old.transcriptType });
          if (JSON.stringify(merged) !== JSON.stringify(old)) { vlib[i] = merged; changed = true; }
        }
      }
      if (changed) await chrome.storage.local.set({ [VLIB_KEY]: vlib.slice(-800) });
    }), 400);
  }
  async function editVLib(fn) { return withLock(async () => { const v = await readVLib(); const out = fn(v) || v; await chrome.storage.local.set({ [VLIB_KEY]: out }); return out; }); }

  const lectureKey = (x) => [x.course, x.category, x.section, U.splitNumber(x.name || '').rest].map((v) => String(v || '').toLowerCase().trim()).join('|');

  // One video (the per-card Download button): returns the path to use and saves its .srt next to it.
  async function prepareVideo(video, name, options) {
    const opts = Object.assign({ prefix: true, folder: 'eJPT', structure: true, withSubs: true }, options || {});
    const folderName = U.niceName(opts.folder, 60) || 'eJPT';
    const p = video.place || {};
    const it = { name: (name && name.trim()) || p.name || video.lectureName || 'Lecture', origName: p.name || name, course: p.course, category: p.category, categoryIndex: p.categoryIndex,
      section: p.section, sectionIndex: p.sectionIndex, lessonIndex: p.lessonIndex, order: 0, __id: 'v' };
    U.planNumbers([it]);
    const base = folderName + '/' + ['Lectures', U.hierarchyDir(it, opts.structure)].filter(Boolean).join('/') + '/' + U.lectureStem(it, opts.prefix);
    let srt = false;
    if (opts.withSubs || opts.subsOnly) {
      const lib = await readLib();
      const sub = lib.find((e) => e.hasContent && lectureKey(e) === lectureKey({ course: it.course, category: it.category, section: it.section, name: it.origName }));
      let cues = [];
      if (sub) {
        const raw = (await chrome.storage.local.get(TEXT_PREFIX + sub.id))[TEXT_PREFIX + sub.id];
        cues = raw ? U.parseAnyCues(raw, sub.type) : [];
      }
      if (!cues.length && video.transcriptUrl) {   // not in the Subtitles list: fetch the file the player used
        try { const raw = await fetchText(video.transcriptUrl); cues = U.parseAnyCues(raw, (video.transcriptType || 'vtt').toUpperCase()); } catch (e) { /* ignore */ }
      }
      if (cues.length && !U.isThumbnailCues(cues)) { await saveText(base + '.srt', U.toSrt(cues)); srt = true; }
      if (opts.subsOnly) return { ok: srt, srt, path: base + '.srt', error: srt ? null : 'No subtitle captured for this lecture yet — play it with CC on' };
    }
    return { ok: true, customName: base + '.' + extensionFor(video.type), srt };
  }

  const videoBatch = { cancel: false, running: false, current: null };

  // Videos go to <folder>/Lectures/<course>/<NN category>/<NN section>/<NN title>.<ext>
  // and, when its subtitle was captured, <NN title>.srt is saved right next to it.
  async function runVideoBatch(tabId, items, options) {
    const opts = Object.assign({ prefix: true, folder: 'eJPT', structure: true, withSubs: true }, options || {});
    const folderName = U.niceName(opts.folder, 60) || 'eJPT';
    const lib = await readLib();
    const subsByKey = new Map(lib.filter((e) => e.hasContent).map((e) => [lectureKey(e), e]));
    const plan = items.map((x, i) => {
      const p = x.video.place || {};
      const nm = (x.name && x.name.trim()) || p.name || x.video.lectureName || 'Lecture';
      return { video: x.video, name: nm, origName: p.name || nm, course: p.course, category: p.category, categoryIndex: p.categoryIndex,
        section: p.section, sectionIndex: p.sectionIndex, lessonIndex: p.lessonIndex, order: i, __id: 'v' + i };
    });
    U.planNumbers(plan);
    const used = new Set();
    let ok = 0; const failed = [];
    videoBatch.cancel = false; videoBatch.running = true;
    for (let i = 0; i < plan.length; i++) {
      if (videoBatch.cancel) { failed.push(...plan.slice(i).map((x) => ({ name: U.lectureStem(x, opts.prefix), error: 'stopped' }))); break; }
      const it = plan[i];
      const dir = ['Lectures', U.hierarchyDir(it, opts.structure)].filter(Boolean).join('/');
      const stem = U.lectureStem(it, opts.prefix);
      let base = folderName + '/' + dir + '/' + stem, n = 2;
      while (used.has(base.toLowerCase())) base = folderName + '/' + dir + '/' + stem + ' (' + n++ + ')';
      used.add(base.toLowerCase());
      broadcast({ action: 'videoBatchProgress', index: i + 1, total: plan.length, name: stem, failed: failed.length });
      try {
        if (opts.withSubs) {
          const sub = subsByKey.get(lectureKey({ course: it.course, category: it.category, section: it.section, name: it.origName }));
          let cues = [];
          if (sub) {
            const raw = (await chrome.storage.local.get(TEXT_PREFIX + sub.id))[TEXT_PREFIX + sub.id];
            cues = raw ? U.parseAnyCues(raw, sub.type) : [];
          }
          if (!cues.length && it.video.transcriptUrl) {
            try { cues = U.parseAnyCues(await fetchText(it.video.transcriptUrl), (it.video.transcriptType || 'vtt').toUpperCase()); } catch (e) { /* ignore */ }
          }
          if (cues.length && !U.isThumbnailCues(cues)) await saveText(base + '.srt', U.toSrt(cues));
        }
        const r = await startDownload(tabId, Object.assign({}, it.video, { customName: base + '.' + extensionFor(it.video.type), ignoreLimit: !!opts.ignoreLimit }));
        if (r && r.limitReached) {   // daily data limit: stop the batch instead of failing every video
          failed.push(...plan.slice(i).map((x) => ({ name: U.lectureStem(x, opts.prefix), error: 'daily data limit' })));
          break;
        }
        if (!r || !r.downloadId) throw new Error((r && r.error) || 'could not start');
        videoBatch.current = r.downloadId;
        const outcome = await waitForDownload(r.downloadId, (st) => broadcast({ action: 'videoBatchProgress', index: i + 1, total: plan.length, name: stem,
          percent: st.percent || 0, statusText: st.statusText || '', failed: failed.length, vid: it.video.id || null }));
        videoBatch.current = null;
        if (outcome === 'complete') ok++; else failed.push({ name: stem, error: outcome });
      } catch (e) { failed.push({ name: stem, error: String((e && e.message) || e) }); }

      // Data & speed saver: rest between videos (spreads data use, lets the laptop cool down).
      const delaySec = opts.noDelay ? 0 : Math.max(0, parseInt((getNetPrefs() || {}).delaySec, 10) || 0);
      if (delaySec && i < plan.length - 1 && !videoBatch.cancel) {
        for (let left = delaySec; left > 0 && !videoBatch.cancel; left--) {
          broadcast({ action: 'videoBatchProgress', index: i + 1, total: plan.length, name: stem, failed: failed.length,
            waiting: true, statusText: 'Waiting ' + left + 's before the next video (data & speed saver) — ' + (i + 1) + ' of ' + plan.length + ' done' });
          await sleep(1000);
        }
      }
    }
    videoBatch.running = false;
    broadcast({ action: 'videoBatchProgress', index: plan.length, total: plan.length, done: true, ok, failed: failed.length, failedList: failed });
    return { total: plan.length, ok, failed };
  }

  // ---- auto-capture: open and briefly play every lecture on the page, one after another ---------
  // Runs INSIDE the page; must be fully self-contained (same rules as pageSnapshot above).
  // Each call does ONE step and returns, so the background script stays in control of pacing
  // and can stop between lectures.
  function ineAutoStep() {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const leavesOf = (root) => {
      const out = []; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) {
        const t = clean(n.nodeValue);
        if (t && n.parentElement && !n.parentElement.closest('script,style,noscript,[aria-hidden="true"]')) out.push({ t, el: n.parentElement });
      }
      return out;
    };
    const inSiteChrome = (el) => !!el.closest('header, nav, footer, [role="navigation"], [role="banner"]');
    const CLOSE = /^close$/i;
    const VIDEO_OPEN = /^(start video|restart video|resume video|watch video)$/i;
    const SHOWDET = /^show details$/i;
    const DUR = /^\d+\s*m\s*\d*\s*s?$|^\d{1,2}:\d{2}(:\d{2})?$/i;

    // a lecture is already open (its row shows "Close") -> tell the caller to close it first
    for (const l of leavesOf(document.body)) {
      if (CLOSE.test(l.t) && !inSiteChrome(l.el)) return { opened: false, hasOpen: true };
    }

    // the next "Start/Restart/Resume/Watch video" button, in page order, skipping ones we already
    // opened this run (closing a lecture often reverts its button back to "Restart video", which
    // would otherwise match again and loop on the first lecture forever instead of advancing)
    for (const l of leavesOf(document.body)) {
      if (!VIDEO_OPEN.test(l.t) || inSiteChrome(l.el)) continue;
      const btn = l.el.closest('button, a, [role="button"]') || l.el;
      if (btn.dataset.s2sAutoOpened) continue;
      let title = '';
      for (let row = btn, i = 0; i < 6 && row && row.parentElement; i++, row = row.parentElement) {
        const h = leavesOf(row).find((x) => x.el !== btn && x.t.length > 3 && x.t.length <= 140 && !DUR.test(x.t) && !VIDEO_OPEN.test(x.t));
        if (h) { title = h.t; break; }
      }
      btn.dataset.s2sAutoOpened = '1';
      try { btn.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
      btn.click();
      // the player usually needs its own play() call, on top of opening the row
      setTimeout(() => {
        try { if (window.jwplayer) { const jw = window.jwplayer(); if (jw && jw.play) jw.play(); } } catch (e) { /* ignore */ }
        try { document.querySelectorAll('video').forEach((v) => { if (v.paused) v.play().catch(() => {}); }); } catch (e) { /* ignore */ }
      }, 900);
      return { opened: true, title: title || 'Lecture' };
    }

    // nothing open-able yet: expand the next collapsed card ("Show details")
    for (const l of leavesOf(document.body)) {
      if (!SHOWDET.test(l.t) || inSiteChrome(l.el)) continue;
      const btn = l.el.closest('button, a, [role="button"]') || l.el;
      try { btn.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
      btn.click();
      return { opened: false, expanded: true };
    }

    return { opened: false, done: true }; // every card expanded, every video already opened once
  }
  // Closes whichever lecture is currently open, so the next one can be opened cleanly.
  function ineAutoClose() {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const leavesOf = (root) => {
      const out = []; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) {
        const t = clean(n.nodeValue);
        if (t && n.parentElement && !n.parentElement.closest('script,style,noscript,[aria-hidden="true"]')) out.push({ t, el: n.parentElement });
      }
      return out;
    };
    const inSiteChrome = (el) => !!el.closest('header, nav, footer, [role="navigation"], [role="banner"]');
    for (const l of leavesOf(document.body)) {
      if (/^close$/i.test(l.t) && !inSiteChrome(l.el)) {
        const btn = l.el.closest('button, a, [role="button"]') || l.el;
        btn.click();
        return { ok: true };
      }
    }
    return { ok: false };
  }
  async function execInPage(tabId, func) {
    try {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func });
      return res && res[0] ? res[0].result : null;
    } catch (e) { return null; }
  }

  const autoCap = { running: false, cancel: false };
  // Random delay in [lo, hi] ms — used between lectures so requests land at human-like,
  // uneven intervals instead of a robotic fixed cadence.
  const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));
  // Opens each lecture on the page in turn, lets it play for `waitMs` so the existing network
  // listeners capture its subtitle/video (same capture path as playing it by hand), then closes
  // it and moves to the next. Reports progress so the popup can show what is happening.
  // Paces itself deliberately: a randomized gap between lectures (not a fixed interval), and a
  // longer "break" every few lectures, plus a per-run cap so a whole course isn't opened back
  // to back in one sitting — resume with another click to pick up where it left off.
  async function runAutoCapture(tabId, options) {
    if (autoCap.running) return { ok: false, error: 'Already running' };
    const opts = Object.assign({ waitMs: 12000, maxPerRun: 20, breakEvery: 6 }, options || {});
    autoCap.running = true; autoCap.cancel = false;
    let opened = 0, error = null, stall = 0, paused = false;
    const STALL_LIMIT = 40;   // "Show details"/"Close" clicks in a row with no lecture actually opening
    try {
      for (;;) {
        if (autoCap.cancel) break;
        if (stall > STALL_LIMIT) { error = 'Stopped — stuck opening cards without reaching a new lecture (the page may not respond to these clicks).'; break; }
        const res = await execInPage(tabId, ineAutoStep);
        if (!res) { error = 'Could not read this page — reload it and try again'; break; }
        if (res.hasOpen) { stall++; await execInPage(tabId, ineAutoClose); await sleep(jitter(600, 1400)); continue; }
        if (res.expanded) { stall++; await sleep(jitter(700, 1600)); continue; }
        if (res.done) break;
        if (!res.opened) break;
        stall = 0;
        opened++;
        broadcast({ action: 'autoCaptureProgress', index: opened, name: res.title });
        await sleep(opts.waitMs);
        if (autoCap.cancel) break;
        await execInPage(tabId, ineAutoClose);
        if (opened >= opts.maxPerRun) { paused = true; break; }
        // a longer, human-like pause every few lectures instead of a steady machine-gun pace
        const longBreak = opened % opts.breakEvery === 0;
        await sleep(longBreak ? jitter(15000, 28000) : jitter(1500, 4000));
      }
    } finally {
      autoCap.running = false;
      broadcast({ action: 'autoCaptureProgress', done: true, cancelled: autoCap.cancel, paused, opened, error });
    }
    return { ok: true, opened };
  }

  // ---- on-page element picker -----------------------------------------------------------------
  // Injected into the lecture page. The user clicks the element that holds the lecture title
  // (or section name); we remember a CSS selector for it, per site.
  function pickerInPage(kind) {
    if (window.__s2sPicker) window.__s2sPicker.stop();
    const hi = document.createElement('div');
    hi.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #a855f7;background:rgba(168,85,247,.18);border-radius:4px;transition:all .05s';
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);background:#0f172a;color:#f8fafc;font:600 13px system-ui,sans-serif;padding:10px 16px;border-radius:10px;border:1px solid #a855f7;box-shadow:0 8px 24px rgba(0,0,0,.4)';
    bar.textContent = ({ section: 'Click the SECTION name (e.g. the card title on the left) — Esc to cancel',
      category: 'Click the CATEGORY heading (e.g. the big title above the sections) — Esc to cancel',
      course: 'Click the COURSE name — Esc to cancel' })[kind] || 'Click the LECTURE TITLE of the video that is playing — Esc to cancel';
    document.documentElement.append(hi, bar);

    const stable = (c) => c && c.length < 40 && !/\d{3,}|^css-|^_|^[a-z]{1,2}-[\w]{5,}$|^(active|current|selected|hover|focus|open|is-.*)$/i.test(c);
    function cssPath(el) {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 7) {
        if (node.id && !/\d{4,}/.test(node.id) && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) { parts.unshift('#' + CSS.escape(node.id)); break; }
        let part = node.tagName.toLowerCase();
        for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) if (node.getAttribute(a)) { part += '[' + a + '="' + CSS.escape(node.getAttribute(a)) + '"]'; break; }
        const cls = [...node.classList].filter(stable).slice(0, 2);
        if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
        const par = node.parentElement;
        if (par) {
          const same = [...par.children].filter((s) => s.matches(part));
          if (same.length > 1) part += ':nth-child(' + ([...par.children].indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        const sel = parts.join(' > ');
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* keep climbing */ }
        node = node.parentElement;
      }
      return parts.join(' > ');
    }
    const under = (x, y) => { hi.style.display = 'none'; bar.style.display = 'none'; const e = document.elementFromPoint(x, y); hi.style.display = ''; bar.style.display = ''; return e; };
    const move = (ev) => {
      const e = under(ev.clientX, ev.clientY); if (!e) return;
      const r = e.getBoundingClientRect();
      Object.assign(hi.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    };
    const stop = () => { document.removeEventListener('mousemove', move, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); hi.remove(); bar.remove(); window.__s2sPicker = null; };
    const click = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const e = under(ev.clientX, ev.clientY);
      if (!e) return;
      const text = ((e.innerText || e.textContent || '').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)[0]) || '';
      const selector = cssPath(e);
      try { chrome.runtime.sendMessage({ action: 'pickerResult', kind, selector, text }); } catch (err) { /* ignore */ }
      bar.textContent = 'Saved: “' + text.slice(0, 60) + '” — you can close this and reopen the extension';
      bar.style.display = '';
      document.removeEventListener('mousemove', move, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); hi.remove();
      setTimeout(() => { bar.remove(); window.__s2sPicker = null; }, 3500);
    };
    const key = (ev) => { if (ev.key === 'Escape') stop(); };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    window.__s2sPicker = { stop };
  }

  // ---- library maintenance -----------------------------------------------------------------------
  async function cleanupLibrary() {
    return withLock(async () => {
      const prefs = await getPrefs();
      let lib = await readLib();
      let removed = 0, fixed = 0;
      const seen = new Map();
      const out = [];
      for (const e of lib.slice().sort((a, b) => a.detectedAt - b.detectedAt)) {
        if (e.hasContent && (!e.fp || !e.langName || !e.v15)) {
          const d = await chrome.storage.local.get(TEXT_PREFIX + e.id);
          const raw = d[TEXT_PREFIX + e.id];
          if (raw) {
            const cues = U.parseAnyCues(raw, e.type);
            if (U.isThumbnailCues(cues)) { removed++; await chrome.storage.local.remove(TEXT_PREFIX + e.id); continue; }   // thumbnail track, not captions
            const plain = U.toPlainText(cues), st = U.cueStats(cues);
            e.fp = U.fingerprint(plain, st.cues, st.durationSec);
            if (!e.langName || e.langSource === 'url') { const g = U.detectLanguageFromText(plain); if (g) { e.langName = g; e.langCode = U.codeForName(g); e.langSource = 'text'; } }
            fixed++;
          }
        }
        if (!e.v15) {   // names captured by older versions: drop player junk, shorten
          e.v15 = true;
          const t = U.splitNumber(e.name);
          let nm = U.isJunkName(t.rest) ? '' : U.tidyTitle(t.rest, 60);
          if (!nm && e.pageTitle && !U.isJunkName(e.pageTitle)) nm = U.tidyTitle(e.pageTitle, 60);
          e.name = nm || 'Lecture';
          if (!e.lessonIndex && t.n) e.lessonIndex = t.n;
          if (e.section) { const sn = U.splitNumber(e.section); e.section = U.tidyTitle(sn.rest, 40); if (!e.sectionIndex && sn.n) e.sectionIndex = sn.n; }
        }
        if (!e.order) e.order = e.detectedAt;
        const k = e.fp ? e.fp + '|' + (e.langName || '') : null;
        if (k && seen.has(k)) { removed++; await chrome.storage.local.remove(TEXT_PREFIX + e.id); continue; }
        if (k) seen.set(k, e.id);
        out.push(e);
      }
      lib = out;
      await writeLib(lib);
      return { removedDuplicates: removed, fixed, englishOnly: prefs.englishOnly };
    });
  }

  async function removeNonEnglish() {
    return withLock(async () => {
      const lib = await readLib();
      const drop = lib.filter((e) => !U.isEnglish(e.langCode, e.langName));
      await writeLib(lib.filter((e) => !drop.includes(e)));
      if (drop.length) await chrome.storage.local.remove(drop.map((e) => TEXT_PREFIX + e.id));
      return drop.length;
    });
  }

  // ---- messages from the popup / picker ---------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const reply = (p) => p.then((r) => sendResponse(r), (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    switch (message && message.action) {
      case 'downloadSubtitles':
        reply(downloadSubtitles(message.ids || [], message.options).then((r) => ({ ok: true, ...r })));
        return true;
      case 'renameSubtitle':
        reply(updateEntry(message.id, { userName: String(message.name || '').slice(0, 200) }).then(() => ({ ok: true })));
        return true;
      case 'setOrder':   // ids in the wanted order
        reply(withLock(async () => {
          const lib = await readLib();
          const base = Date.now();
          (message.ids || []).forEach((id, i) => { const e = lib.find((x) => x.id === id); if (e) e.order = base + i; });
          await writeLib(lib);
          return { ok: true };
        }));
        return true;
      case 'moveSubtitle':
        reply(withLock(async () => {
          const lib = (await readLib()).sort((a, b) => (a.order || a.detectedAt) - (b.order || b.detectedAt));
          const visible = new Set(message.visibleIds || lib.map((e) => e.id));
          const idx = lib.findIndex((e) => e.id === message.id);
          if (idx === -1) return { ok: false };
          let j = idx + (message.dir < 0 ? -1 : 1);
          while (j >= 0 && j < lib.length && !visible.has(lib[j].id)) j += message.dir < 0 ? -1 : 1;
          if (j < 0 || j >= lib.length) return { ok: true };
          const a = lib[idx], b = lib[j], oa = a.order || a.detectedAt, ob = b.order || b.detectedAt;
          a.order = ob === oa ? ob + (message.dir < 0 ? -1 : 1) : ob; b.order = oa;
          await writeLib(lib);
          return { ok: true };
        }));
        return true;
      case 'removeSubtitles':
        reply(withLock(async () => {
          const drop = new Set(message.ids || []);
          await writeLib((await readLib()).filter((e) => !drop.has(e.id)));
          await chrome.storage.local.remove([...drop].map((id) => TEXT_PREFIX + id));
          return { ok: true };
        }));
        return true;
      case 'clearSubtitles':
        reply(withLock(async () => {
          const lib = await readLib();
          await chrome.storage.local.remove(lib.map((e) => TEXT_PREFIX + e.id).concat([LIB_KEY, CAND_KEY]));
          candCache = null;
          return { ok: true };
        }));
        return true;
      case 'cleanupLibrary':
        reply(cleanupLibrary().then((r) => ({ ok: true, ...r })));
        return true;
      case 'removeNonEnglish':
        reply(removeNonEnglish().then((n) => ({ ok: true, removed: n })));
        return true;

      // --- naming ---
      case 'getNameInfo':
        reply((async () => {
          const snap = await snapshotPage(message.tabId);
          const naming = await getNaming(snap.host);
          return { ok: true, host: snap.host, candidates: snap.cands, section: snap.section, naming, chosen: pickName(snap.cands, naming.source), place: placeFromSnap(Object.assign(snap, { naming })) };
        })());
        return true;
      case 'setNameSource':
        reply(setNaming(message.host, { source: message.source }).then((n) => ({ ok: true, naming: n })));
        return true;
      case 'resetNamingKind':
        reply(setNaming(message.host, { [message.kind + 'Sel']: '' }).then(() => ({ ok: true })));
        return true;
      case 'resetNaming':
        reply(setNaming(message.host, { source: 'auto', titleSel: '', sectionSel: '', categorySel: '', courseSel: '' }).then((n) => ({ ok: true, naming: n })));
        return true;
      case 'startPicker':
        reply(chrome.scripting.executeScript({ target: { tabId: message.tabId }, func: pickerInPage, args: [message.kind] }).then(() => ({ ok: true })));
        return true;
      case 'pickerResult': {
        const url = sender && sender.tab && sender.tab.url;
        let host = ''; try { host = new URL(url).hostname; } catch (e) { /* ignore */ }
        if (host && message.selector) {
          const patch = message.kind === 'title' ? { titleSel: message.selector, source: 'selector' } : { [message.kind + 'Sel']: message.selector };
          setNaming(host, patch).then(() => sendResponse({ ok: true }));
          return true;
        }
        sendResponse({ ok: false });
        return false;
      }

      // --- videos ---
      case 'prepareVideo':
        reply(prepareVideo(message.video, message.name, message.options));
        return true;
      case 'downloadLibVideos':   // ids from the video list; downloaded one after another in course order
        reply((async () => {
          if (videoBatch.running) return { ok: false, error: 'A batch is already running' };
          const vlib = await readVLib();
          const chosen = U.sortByPlace(vlib.filter((v) => (message.ids || []).includes(v.id)), (v) => v.place || {});
          const r = await runVideoBatch(message.tabId, chosen.map((v) => ({ video: v, name: v.userName || '' })), message.options);
          return { ok: true, ...r };
        })());
        return true;
      case 'cancelVideoBatch':
        videoBatch.cancel = true;
        if (videoBatch.current) try { cancelDownload(videoBatch.current); } catch (e) { /* ignore */ }
        sendResponse({ ok: true });
        return false;
      case 'videoBatchState':
        sendResponse({ running: videoBatch.running });
        return false;
      case 'renameVideo':
        reply(editVLib((v) => { const e = v.find((x) => x.id === message.id); if (e) e.userName = message.name || ''; }).then(() => ({ ok: true })));
        return true;
      case 'removeVideos':
        reply(editVLib((v) => v.filter((x) => !(message.ids || []).includes(x.id))).then(() => ({ ok: true })));
        return true;
      case 'clearVideos':
        reply(chrome.storage.local.set({ [VLIB_KEY]: [] }).then(() => ({ ok: true })));
        return true;
      case 'queueVideoDownloads':
        reply(runVideoBatch(message.tabId, message.items || [], message.options).then((r) => ({ ok: true, ...r })));
        return true;

      // --- auto-capture: open + briefly play every lecture on the page, one after another ---
      case 'startAutoCapture':
        if (autoCap.running) { sendResponse({ ok: false, error: 'Already running' }); return false; }
        runAutoCapture(message.tabId, message.options);   // fire and forget; progress comes via broadcast
        sendResponse({ ok: true });
        return false;
      case 'cancelAutoCapture':
        autoCap.cancel = true;
        sendResponse({ ok: true });
        return false;
      case 'autoCaptureState':
        sendResponse({ running: autoCap.running });
        return false;
      default:
        return false;
    }
  });

  // ---- exported hooks used by background.js ----------------------------------------------------
  self.SubLib = {
    sniffSubtitleType, looksLikeSegment, noteCandidate, registerSubtitle, classifyHls, refreshBadge, attachLectureName, syncVideoLib, resetTab,
    readLib, readVLib, downloadSubtitles, runVideoBatch, isAutoCapRunning: () => autoCap.running, isVideoBatchRunning: () => videoBatch.running,   // used by autopilot.js
    contentTypeToSubtitleType(v) {
      v = (v || '').toLowerCase();
      if (v.includes('text/vtt')) return 'VTT';
      if (v.includes('subrip')) return 'SRT';
      if (v.includes('ttml') || v.includes('dfxp')) return 'TTML';
      return null;
    }
  };

  chrome.webRequest.onHeadersReceived.addListener((d) => {
    if (d.tabId === undefined || d.tabId < 0) return;
    const h = (d.responseHeaders || []).find((x) => x.name.toLowerCase() === 'content-type');
    const type = h && self.SubLib.contentTypeToSubtitleType(h.value);
    if (type && !looksLikeSegment(d.url)) {
      noteCandidate(d.url, d.tabId, 'content-type');
      registerSubtitle({ tabId: d.tabId, url: d.url, type });
    }
  }, { urls: ['<all_urls>'] }, ['responseHeaders']);
})();
