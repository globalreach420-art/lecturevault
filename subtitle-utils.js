// ============================================================================
// Shared, dependency-free helpers for subtitle handling.
// Loaded by the background service worker (importScripts) and by the popup
// (<script>), and unit-tested under Node. Exposes a single global: SubUtils.
// ============================================================================
(function (root) {
  'use strict';

  // ---- language tables ------------------------------------------------------
  const LANGUAGE_CODE_NAMES = {
    en: 'English', 'en-us': 'English (US)', 'en-gb': 'English (UK)', 'en-in': 'English (India)',
    es: 'Spanish', 'es-mx': 'Spanish (Mexico)', fr: 'French', de: 'German',
    it: 'Italian', pt: 'Portuguese', 'pt-br': 'Portuguese (Brazil)',
    ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
    'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)',
    ar: 'Arabic', hi: 'Hindi', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian',
    da: 'Danish', fi: 'Finnish', pl: 'Polish', tr: 'Turkish', th: 'Thai',
    vi: 'Vietnamese', id: 'Indonesian', el: 'Greek', he: 'Hebrew',
    cs: 'Czech', ro: 'Romanian', hu: 'Hungarian', uk: 'Ukrainian',
    mr: 'Marathi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', ur: 'Urdu'
  };
  const LANGUAGE_WORDS = {
    english: 'en', hindi: 'hi', spanish: 'es', french: 'fr', german: 'de', italian: 'it',
    portuguese: 'pt', russian: 'ru', japanese: 'ja', korean: 'ko', chinese: 'zh', arabic: 'ar',
    turkish: 'tr', marathi: 'mr', bengali: 'bn', tamil: 'ta', telugu: 'te', urdu: 'ur'
  };

  function nameForCode(code) {
    if (!code) return null;
    const c = String(code).toLowerCase().replace('_', '-');
    if (LANGUAGE_CODE_NAMES[c]) return LANGUAGE_CODE_NAMES[c];
    const base = c.split('-')[0];
    return LANGUAGE_CODE_NAMES[base] || null;
  }

  function codeForName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    for (const code of Object.keys(LANGUAGE_CODE_NAMES)) {
      if (LANGUAGE_CODE_NAMES[code].toLowerCase() === n) return code;
    }
    for (const w of Object.keys(LANGUAGE_WORDS)) {
      if (n.includes(w)) return LANGUAGE_WORDS[w];
    }
    return null;
  }

  // Best-effort language guess from a subtitle URL. Returns {code,name} or null.
  function guessLanguageFromUrl(url) {
    try {
      const decoded = decodeURIComponent(url).toLowerCase();
      for (const w of Object.keys(LANGUAGE_WORDS)) {
        const re = new RegExp('(?:^|[/_.\\-?=&])' + w + '(?:[/_.\\-?=&]|$)');
        if (re.test(decoded)) return { code: LANGUAGE_WORDS[w], name: nameForCode(LANGUAGE_WORDS[w]) };
      }
      const codes = Object.keys(LANGUAGE_CODE_NAMES).sort((a, b) => b.length - a.length);
      for (const code of codes) {
        const re = new RegExp('(?:^|[/_.\\-?=&])' + code + '(?:[/_.\\-?=&]|$)');
        if (re.test(decoded)) return { code, name: LANGUAGE_CODE_NAMES[code] };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ---- text helpers ----------------------------------------------------------
  const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&lrm;': '', '&rlm;': '' };
  function decodeEntities(s) {
    return s
      .replace(/&(amp|lt|gt|quot|apos|nbsp|lrm|rlm|#39);/g, (m) => (ENT[m] !== undefined ? ENT[m] : m))
      .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (e) { return m; } });
  }

  function cleanCueText(s) {
    return decodeEntities(
      s.replace(/<[^>]*>/g, '')           // <c.colorE5E5E5>, <i>, <00:00:01.000>, ...
       .replace(/\{\\[^}]*\}/g, '')       // {\an8} style codes
    ).replace(/\s+/g, ' ').trim();
  }

  // "00:01:02.345" | "01:02,345" | "62.3s" -> seconds
  function toSec(t) {
    if (!t) return 0;
    t = String(t).trim().replace(',', '.');
    if (/^[\d.]+s$/.test(t)) return parseFloat(t);
    const parts = t.split(':').map(Number);
    if (parts.some((n) => isNaN(n))) return 0;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return sec;
  }

  // WebVTT / SRT -> [{start,end,text}]
  function parseTimedText(raw) {
    const text = String(raw || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const cues = [];
    for (const block of text.split(/\n{2,}/)) {
      const lines = block.split('\n');
      const ti = lines.findIndex((l) => l.includes('-->'));
      if (ti === -1) continue; // WEBVTT header, NOTE, STYLE, REGION blocks
      const m = lines[ti].match(/(\S+)\s+-->\s+(\S+)/);
      if (!m) continue;
      const clean = cleanCueText(lines.slice(ti + 1).join(' '));
      if (clean) cues.push({ start: toSec(m[1]), end: toSec(m[2]), text: clean });
    }
    return cues;
  }

  // TTML / DFXP -> cues
  function parseTtml(raw) {
    const cues = [];
    const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(raw))) {
      const b = (m[1].match(/\bbegin="([^"]+)"/) || [])[1];
      const e = (m[1].match(/\bend="([^"]+)"/) || [])[1];
      const clean = cleanCueText(m[2].replace(/<br\s*\/?>/gi, ' '));
      if (clean) cues.push({ start: toSec(b), end: toSec(e), text: clean });
    }
    return cues;
  }

  // Merge YouTube-style rolling duplicates and exact repeats.
  function dedupeCues(cues) {
    const out = [];
    for (const c of cues) {
      const prev = out[out.length - 1];
      if (prev && (c.text === prev.text)) { prev.end = Math.max(prev.end, c.end); continue; }
      if (prev && c.text.startsWith(prev.text) && prev.text.length > 3) { out[out.length - 1] = { start: prev.start, end: c.end, text: c.text }; continue; }
      out.push({ ...c });
    }
    return out;
  }

  function parseAnyCues(raw, type) {
    const t = String(type || '').toUpperCase();
    const head = String(raw || '').slice(0, 500).toLowerCase();
    let cues;
    if (t === 'TTML' || head.includes('<tt ') || head.includes('<tt>') || head.includes('<?xml')) cues = parseTtml(raw);
    else cues = parseTimedText(raw);
    return dedupeCues(cues);
  }

  // Cues -> readable plain text (paragraphs), good for notes / LLM input.
  function toPlainText(cues) {
    if (!cues.length) return '';
    const joined = cues.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
    const sentences = joined.split(/(?<=[.?!])\s+(?=[A-Z0-9"'(\[])/);
    const paras = [];
    if (sentences.length >= Math.max(3, cues.length / 8)) {
      for (let i = 0; i < sentences.length; i += 4) paras.push(sentences.slice(i, i + 4).join(' '));
    } else {
      // little punctuation (auto-captions): group by cues instead
      for (let i = 0; i < cues.length; i += 8) paras.push(cues.slice(i, i + 8).map((c) => c.text).join(' '));
    }
    return paras.join('\n\n') + '\n';
  }

  function cueStats(cues) {
    const last = cues.length ? cues[cues.length - 1] : null;
    return { cues: cues.length, durationSec: last ? Math.round(last.end) : 0 };
  }

  // ---- language from the text itself ----------------------------------------
  const STOP = {
    English: 'the and to of a in is that it you for on with this we are as can be have so will then your when what how not or if',
    Spanish: 'el la de que y en los es un una por con para las del se no lo como',
    French: 'le la les de des et est un une que pour dans pas qui sur',
    German: 'der die das und ist nicht ein eine zu mit den von auf',
    Portuguese: 'o os as de que e um uma para com não se do da em'
  };
  const STOPSETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]));
  const SCRIPTS = [
    ['Hindi (Devanagari)', /[ऀ-ॿ]/g], ['Arabic', /[؀-ۿ]/g], ['Chinese', /[一-鿿]/g],
    ['Japanese', /[぀-ヿ]/g], ['Korean', /[가-힯]/g], ['Russian', /[Ѐ-ӿ]/g],
    ['Thai', /[฀-๿]/g], ['Greek', /[Ͱ-Ͽ]/g], ['Hebrew', /[֐-׿]/g],
    ['Bengali', /[ঀ-৿]/g], ['Tamil', /[஀-௿]/g], ['Telugu', /[ఀ-౿]/g]
  ];

  // Returns a language display name or null. Only a guess.
  function detectLanguageFromText(plain) {
    const sample = String(plain || '').slice(0, 6000);
    if (sample.length < 40) return null;
    const letters = (sample.match(/\p{L}/gu) || []).length;
    if (!letters) return null;
    for (const [name, re] of SCRIPTS) {
      const n = (sample.match(re) || []).length;
      if (n / letters > 0.3) return name;
    }
    const words = sample.toLowerCase().match(/[a-zà-ÿ']+/g) || [];
    if (words.length < 10) return null;
    let best = null, bestRatio = 0;
    for (const [lang, set] of Object.entries(STOPSETS)) {
      const hits = words.filter((w) => set.has(w)).length;
      const ratio = hits / words.length;
      if (ratio > bestRatio) { bestRatio = ratio; best = lang; }
    }
    const need = best === 'English' ? 0.15 : 0.12;
    return bestRatio >= need ? best : null;
  }

  // ---- HLS subtitle playlists ------------------------------------------------
  function parseAttrs(line) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(line))) attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    return attrs;
  }

  function resolveUrl(base, rel) {
    try { return new URL(rel, base).href; } catch (e) { return rel; }
  }

  // Subtitle renditions declared in a master playlist.
  function parseMasterSubtitles(text, baseUrl) {
    const out = [];
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('#EXT-X-MEDIA:')) continue;
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if ((a.TYPE || '').toUpperCase() !== 'SUBTITLES' || !a.URI) continue;
      out.push({ uri: resolveUrl(baseUrl, a.URI), language: a.LANGUAGE || null, name: a.NAME || null, isDefault: (a.DEFAULT || '') === 'YES' });
    }
    return out;
  }

  function mediaPlaylistSegments(text, baseUrl) {
    const lines = String(text).split('\n').map((l) => l.trim());
    const segs = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF:')) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] && !lines[j].startsWith('#')) { segs.push(resolveUrl(baseUrl, lines[j])); break; }
        }
      }
    }
    return segs;
  }

  // True when a media playlist's segments are WebVTT files (i.e. it is a subtitle track, not video).
  function isSubtitleMediaPlaylist(text, baseUrl) {
    const segs = mediaPlaylistSegments(text, baseUrl);
    return segs.length > 0 && segs.every((s) => /\.(web)?vtt(\?|#|$)/i.test(s));
  }

  function mergeVttSegments(texts) {
    const parts = texts.map((t, i) => {
      let s = String(t || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      if (i > 0) s = s.replace(/^WEBVTT[^\n]*\n(?:[^\n]+\n)*\n?/, '');
      return s.trim();
    }).filter(Boolean);
    return parts.join('\n\n') + '\n';
  }

  // ---- URLs & names -----------------------------------------------------------
  const TOKEN_PARAM = /^(token|sig|signature|expires?|policy|key-pair-id|hdnts|hmac|auth|se|sp|sv|sr|st|sk|x-amz-.*|x-goog-.*|googleaccessid|_)$/i;

  // Same subtitle with a fresh signed URL must dedupe to the same key.
  function urlKey(url) {
    try {
      const u = new URL(url);
      const keep = [];
      u.searchParams.forEach((v, k) => { if (!TOKEN_PARAM.test(k)) keep.push([k, v]); });
      keep.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      return u.origin + u.pathname + (keep.length ? '?' + keep.map(([k, v]) => k + '=' + v).join('&') : '');
    } catch (e) { return url; }
  }

  function hashId(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 's' + h.toString(36);
  }

  function sanitizeFilename(name) {
    if (!name) return '';
    let clean = String(name).replace(/[\\/*?:"<>|]/g, '_').replace(/[\r\n\t]+/g, ' ').trim();
    clean = clean.replace(/\s+/g, '_').replace(/_{2,}/g, '_').replace(/^[_.\s]+|[_.\s]+$/g, '');
    return clean.substring(0, 120);
  }

  function formatDuration(sec) {
    if (!sec || !isFinite(sec) || sec <= 0) return '';
    const t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
  }


  // ---- junk names (player menu items etc.) -------------------------------------
  const JUNK_NAME = /^(auto|\d{3,4}p|\d+(\.\d+)?x|normal|off|on|captions?|subtitles?|english|settings|quality|speed|default|play|pause|mute|fullscreen|cc|video|lecture|test your skills|(jump|skip|go) to( the)? [\w ]{2,20})$/i;
  function isJunkName(n) {
    n = String(n || '').trim();
    if (!n || n.length < 3 || JUNK_NAME.test(n)) return true;
    if (/^(video|player|media)\s*:/i.test(n)) return true;                 // "Video: ine-videos/s3/..." player labels
    if (/^https?:\/\//i.test(n) || /^[\w.-]+\/[\w./-]+$/.test(n)) return true;   // URLs and storage paths
    if (/^[0-9a-f-]{16,}$/i.test(n) || (!/\s/.test(n) && n.length >= 24)) return true;   // ids / hashes
    return false;
  }

  // Turn page text into a readable title of sensible length:
  // "Video: x" / "Lesson 3:" prefixes removed, " | INE" style site suffixes removed, cut at a word boundary.
  function tidyTitle(s, max) {
    max = max || 60;
    s = String(s || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\s+[|•·–—-]\s+(INE|INE Learning|my\.ine\.com|Home)\b.*$/i, '');
    s = s.replace(/^(video|lesson|lecture|module|section|chapter|unit|part)\s*\d*\s*[:.)-]\s*/i, '');
    s = s.replace(/\s*\(\d{1,2}:\d{2}(:\d{2})?\)\s*$/, '').replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, '');
    s = s.replace(/[\s.:;,|-]+$/, '');
    if (s.length > max) { const cut = s.slice(0, max + 1); const sp = cut.lastIndexOf(' '); s = (sp > max * 0.6 ? cut.slice(0, sp) : s.slice(0, max)).replace(/[\s.:;,|-]+$/, ''); }
    return s;
  }

  // Leading number of a title: "3. Port Scanning" -> {n:3, rest:"Port Scanning"}; "Section 2: Recon" -> {n:2, rest:"Recon"}
  function splitNumber(s) {
    const m = String(s || '').trim().match(/^(?:(?:section|module|lesson|lecture|video|chapter|unit|part)\s*)?(\d{1,3})\s*[.:)\-–]\s*(.+)$/i);
    return m ? { n: parseInt(m[1], 10), rest: m[2].trim() } : { n: null, rest: String(s || '').trim() };
  }

  // Readable file/folder name: keeps spaces, drops characters Windows refuses.
  function niceName(name, max) {
    let c = String(name || '').replace(/\s*:\s+/g, ' - ').replace(/[\\/]/g, '-').replace(/[*?:"<>|]/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
    if (max && c.length > max) c = tidyTitle(c, max);
    return c;
  }

  // Video-player thumbnail / storyboard tracks are VTT files too, but every cue is an image URL.
  function isThumbnailCues(cues) {
    if (!cues || !cues.length) return false;
    const IMG = /(\.(jpe?g|png|webp|gif|bmp)([?#]|\s|$))|#xywh=|^\s*https?:\/\/\S+\s*$/i;
    const sample = cues.slice(0, 60);
    return sample.filter((c) => IMG.test(c.text)).length >= sample.length * 0.4;
  }

  function isEnglish(code, name) {
    return /^en(\b|[-_])/i.test(String(code || '')) || /english/i.test(String(name || ''));
  }

  // Identifies the same subtitle served under two different URLs.
  function fingerprint(plain, cues, durationSec) {
    const s = String(plain || '').replace(/\s+/g, ' ').slice(0, 1500) + '|' + cues + '|' + durationSec;
    return hashId(s);
  }

  // ---- SubRip output (plays next to the video in VLC / MPV / MPC with the same file name) ----
  function toSrt(cues) {
    const ts = (t) => { t = Math.max(0, t || 0); const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + ',' + String(ms % 1000).padStart(3, '0'); };
    return cues.map((c, i) => (i + 1) + '\n' + ts(c.start) + ' --> ' + ts(c.end) + '\n' + c.text + '\n').join('\n');
  }

  // ---- course hierarchy -> folders ------------------------------------------------------
  // items: [{ course, category, categoryIndex, section, sectionIndex, lessonIndex, order }]
  // Gives every item  _cat / _sec / _lec numbers: the page's own numbers when known (and unique),
  // otherwise the order the items appear in.
  function planNumbers(items) {
    const k = (...a) => a.map((x) => String(x || '').toLowerCase()).join('\u0001');
    const assign = (groups, idxOf, setNum) => {
      for (const list of groups.values()) {
        const keys = []; const byKey = new Map();
        for (const it of list) { const key = it.__k; if (!byKey.has(key)) { byKey.set(key, []); keys.push(key); } byKey.get(key).push(it); }
        // the page's own number always wins (so gaps stay gaps: download lecture 05 alone and it is still "05");
        // items without one get the next free number
        const pageNums = keys.map((key) => idxOf(byKey.get(key)[0]) || null);
        const taken = new Set(pageNums.filter(Boolean));
        let next = 1;
        keys.forEach((key, i) => {
          let n = pageNums[i];
          if (!n) { while (taken.has(next)) next++; n = next; taken.add(n); }
          byKey.get(key).forEach((it) => setNum(it, n));
        });
      }
    };
    const group = (keyFn) => { const g = new Map(); for (const it of items) { const gk = keyFn(it); if (!g.has(gk)) g.set(gk, []); g.get(gk).push(it); } return g; };
    items.forEach((it) => { it.__k = k(it.category); });
    assign(group((it) => k(it.course)), (it) => it.categoryIndex, (it, n) => { it._cat = n; });
    items.forEach((it) => { it.__k = k(it.section); });
    assign(group((it) => k(it.course, it.category)), (it) => it.sectionIndex, (it, n) => { it._sec = n; });
    items.forEach((it) => { it.__k = it.__id || k(it.name, it.order); });
    assign(group((it) => k(it.course, it.category, it.section)), (it) => it.lessonIndex, (it, n) => { it._lec = n; });
    items.forEach((it) => { delete it.__k; });
    return items;
  }
  // INE "Penetration Testing Student" (eJPT) learning path, in INE's order (from the path page).
  // Gives every course its place: "04 Host & Network Penetration Testing/01 System-Host Based Attacks".
  const EJPT_PATH = [
    [1, 'Welcome', []],
    [2, 'Assessment Methodologies', ['Assessment Methodologies: Information Gathering', 'Assessment Methodologies: Footprinting & Scanning',
      'Assessment Methodologies: Enumeration', 'Assessment Methodologies: Vulnerability Assessment']],
    [3, 'Host & Networking Auditing', ['Assessment Methodologies: Auditing Fundamentals']],
    [4, 'Host & Network Penetration Testing', ['Host & Network Penetration Testing: System/Host Based Attacks', 'Host & Network Penetration Testing: Network-Based Attacks',
      'Host & Network Penetration Testing: The Metasploit Framework (MSF)', 'Host & Network Penetration Testing: Exploitation',
      'Host & Network Penetration Testing: Post-Exploitation', 'Host & Network Penetration Testing: Social Engineering']],
    [5, 'Web Application Penetration Testing', ['Web Application Penetration Testing: Introduction to the Web & HTTP Protocol']],
    [6, 'AI Enhanced Pentesting', ['Offensive AI: Generative AI for Pentesters']],
    [7, 'Goodbye', []]
  ];
  const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  function pathPlace(course) {
    const n = normTitle(course);
    if (!n) return null;
    for (const [idx, name, courses] of EJPT_PATH) {
      const i = courses.findIndex((c) => normTitle(c) === n);
      if (i !== -1) return { pathIndex: idx, pathSection: name, courseIndex: i + 1, courseShort: courses[i].replace(/^[^:]+:\s*/, '') };
    }
    return null;
  }
  const two0 = (n) => String(n || 0).padStart(2, '0');
  // "04 Host & Network Penetration Testing/01 System-Host Based Attacks"  (or the plain course name for other courses)
  function courseDir(course) {
    if (!course) return '';
    const p = pathPlace(course);
    return p ? two0(p.pathIndex) + ' ' + niceName(p.pathSection, 50) + '/' + two0(p.courseIndex) + ' ' + niceName(p.courseShort, 60) : niceName(course, 70);
  }
  // ".../01 Windows/03 Windows Credential Dumping"  (+ stem "02 Searching For Passwords ...")
  function hierarchyDir(it, structure) {
    if (!structure) return '';
    const two = (n) => String(n || 0).padStart(2, '0');
    const parts = [];
    if (it.course) parts.push(courseDir(it.course));
    if (it.category) parts.push(two(it._cat) + ' ' + niceName(it.category, 40));
    if (it.section) parts.push(two(it._sec) + ' ' + niceName(it.section, 45));
    return parts.filter(Boolean).join('/');
  }
  function lectureStem(it, prefix, title) {
    let t = splitNumber(title || it.name).rest;
    if (isJunkName(t)) t = 'Lecture';
    t = niceName(tidyTitle(t, 60)) || 'Lecture';
    return (prefix ? String(it._lec || 0).padStart(2, '0') + ' ' : '') + t;
  }

  // Course order: course, then category number, section number, lecture number (all from INE's page).
  // Things without a number keep the order they were first seen in.
  function sortByPlace(items, placeOf) {
    placeOf = placeOf || ((x) => x);
    const firstSeen = new Map();
    const gk = (p) => [p.course, p.category, p.section].map((v) => String(v || '').toLowerCase()).join('|');
    items.slice().sort((a, b) => (a.detectedAt || 0) - (b.detectedAt || 0)).forEach((it) => { const k = gk(placeOf(it)); if (!firstSeen.has(k)) firstSeen.set(k, firstSeen.size); });
    const n = (v) => (v ? v : 9999);
    return items.slice().sort((a, b) => {
      const A = placeOf(a), B = placeOf(b);
      const pa = pathPlace(A.course), pb = pathPlace(B.course);
      const ca = pa ? pa.pathIndex * 100 + pa.courseIndex : 9999, cb = pb ? pb.pathIndex * 100 + pb.courseIndex : 9999;
      return ca - cb || String(A.course || '').localeCompare(String(B.course || '')) ||
        n(A.categoryIndex) - n(B.categoryIndex) || n(A.sectionIndex) - n(B.sectionIndex) ||
        firstSeen.get(gk(A)) - firstSeen.get(gk(B)) ||
        n(A.lessonIndex) - n(B.lessonIndex) || (a.detectedAt || 0) - (b.detectedAt || 0);
    });
  }

  // ---- minimal ZIP writer (method 0 = stored; fine for text) ---------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  // files: [{ path: 'a/b.txt', data: Uint8Array }]  ->  Uint8Array (the .zip)
  function makeZip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const chunks = [], central = [];
    let offset = 0;
    const u16 = (v) => [v & 255, (v >> 8) & 255];
    const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    for (const f of files) {
      const name = enc.encode(f.path.replace(/\\/g, '/'));
      const data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)
      ]);
      chunks.push(local, name, data);
      central.push({ name, crc, size: data.length, offset });
      offset += local.length + name.length + data.length;
    }
    const cdStart = offset;
    for (const c of central) {
      const h = new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
        ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(c.offset)
      ]);
      chunks.push(h, c.name);
      offset += h.length + c.name.length;
    }
    const cdSize = offset - cdStart;
    chunks.push(new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(cdStart), ...u16(0)]));
    let total = 0; chunks.forEach((c) => (total += c.length));
    const out = new Uint8Array(total); let p = 0;
    chunks.forEach((c) => { out.set(c, p); p += c.length; });
    return out;
  }

  const api = {
    LANGUAGE_CODE_NAMES, nameForCode, codeForName, guessLanguageFromUrl,
    cleanCueText, toSec, parseTimedText, parseTtml, dedupeCues, parseAnyCues, toPlainText, cueStats,
    detectLanguageFromText, parseAttrs, resolveUrl, parseMasterSubtitles, mediaPlaylistSegments,
    isSubtitleMediaPlaylist, mergeVttSegments, urlKey, hashId, sanitizeFilename, formatDuration,
    isJunkName, tidyTitle, toSrt, sortByPlace, planNumbers, hierarchyDir, courseDir, pathPlace, lectureStem, splitNumber, niceName, isThumbnailCues, isEnglish, fingerprint, crc32, makeZip
  };
  root.SubUtils = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
