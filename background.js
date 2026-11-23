// Shared subtitle helpers + the subtitle library (see subs-library.js).
importScripts('subtitle-utils.js', 'subs-library.js', 'autopilot.js');

// ============================================================================
// VIDEO DETECTION
// Store detected video URLs by tab ID
// Structure: { [tabId]: [ { url, type, filename, title, resolution, thumbnail,
//              duration, transcriptUrl, transcriptType, detectedAt }, ... ] }
// ============================================================================
const detectedVideos = {};

// Tracks which array index a given "stream family" (same video, different
// resolution) currently occupies for a tab, so we can replace it in place
// instead of listing every resolution separately.
// Structure: { [tabId]: { [groupKey]: indexInDetectedVideos } }
const streamGroups = {};

// Transcript files detected before we could match them to a video yet
// (e.g. the subtitle request fired before the video request).
// Structure: { [tabId]: [ { url, type, detectedAt, explicitVideoUrl }, ... ] }
const pendingTranscripts = {};

// HLS manifest URLs currently being fetched purely to compute a duration
// for display (not a real download), so a rapid resolution swap doesn't
// kick off a dozen duplicate fetches of the same playlist.
const hlsDurationFetchInFlight = new Set();

// Cache of each tab's page title, used for naming saved files.
const tabPageTitles = {};

const PREFERRED_RESOLUTION = 1080;
const KNOWN_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];
const GENERIC_TITLES = new Set(['Detected Video', 'Video Tag', 'Video Source', 'Video Link']);

// Common language codes we can recognize inside a subtitle URL, mapped to a
// friendly display name. Checked as a whole path segment / query value, or
// surrounded by separators like "_", "-", ".", so we don't match substrings
// inside unrelated words.
const LANGUAGE_CODE_NAMES = {
  en: 'English', 'en-us': 'English (US)', 'en-gb': 'English (UK)',
  es: 'Spanish', 'es-mx': 'Spanish (Mexico)', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', 'pt-br': 'Portuguese (Brazil)',
  ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
  'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)',
  ar: 'Arabic', hi: 'Hindi', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian',
  da: 'Danish', fi: 'Finnish', pl: 'Polish', tr: 'Turkish', th: 'Thai',
  vi: 'Vietnamese', id: 'Indonesian', el: 'Greek', he: 'Hebrew',
  cs: 'Czech', ro: 'Romanian', hu: 'Hungarian', uk: 'Ukrainian'
};

// Best-effort guess of a subtitle track's language purely from its URL,
// used when the page didn't expose a matching <track>/TextTrack with a
// language already set. Returns a friendly name or null if unsure.
function guessLanguageFromUrl(url) {
  try {
    const decoded = decodeURIComponent(url).toLowerCase();
    const codes = Object.keys(LANGUAGE_CODE_NAMES).sort((a, b) => b.length - a.length);
    for (const code of codes) {
      const re = new RegExp(`(?:^|[/_.\\-?=&])${code}(?:[/_.\\-?=&]|$)`);
      if (re.test(decoded)) return LANGUAGE_CODE_NAMES[code];
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// Clean up stored videos when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete detectedVideos[tabId];
  delete streamGroups[tabId];
  delete tabPageTitles[tabId];
  delete pendingTranscripts[tabId];
  chrome.storage.local.remove(`tab_${tabId}`);
  SubLib.resetTab(tabId, true);
});

// Keep our page-title cache fresh as tabs navigate/load
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title) {
    tabPageTitles[tabId] = changeInfo.title;
  }
});

// Clean up when navigating to a new page
// A reload or a new page starts from zero (the Subtitles and Videos lists of this tab are emptied too).
// In-page route changes (INE is a single-page app) count as a new page only when the course changes.
const pageKeyOf = (url) => { try { const u = new URL(url); return u.host + u.pathname.split('/').slice(0, 4).join('/'); } catch (e) { return url; } };
const tabPageKey = {};
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  const k = pageKeyOf(details.url);
  if (tabPageKey[details.tabId] && tabPageKey[details.tabId] !== k) {
    detectedVideos[details.tabId] = [];
    streamGroups[details.tabId] = {};
    pendingTranscripts[details.tabId] = [];
    chrome.storage.local.remove(`tab_${details.tabId}`);
    SubLib.resetTab(details.tabId);
  }
  tabPageKey[details.tabId] = k;
});
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    tabPageKey[details.tabId] = pageKeyOf(details.url);
    SubLib.resetTab(details.tabId);
    detectedVideos[details.tabId] = [];
    streamGroups[details.tabId] = {};
    pendingTranscripts[details.tabId] = [];
    chrome.storage.local.remove(`tab_${details.tabId}`);
    updateBadge(details.tabId);
  }
});

// Helper to determine video type from URL
function getVideoType(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    if (path.includes('.m3u8')) return 'HLS (m3u8)';
    if (path.includes('.mpd')) return 'DASH (mpd)';
    if (path.includes('.mp4')) return 'MP4';
    if (path.includes('.webm')) return 'WEBM';
    if (path.includes('.ogg') || path.includes('.ogv')) return 'OGG';

    const search = urlObj.search.toLowerCase();
    if (search.includes('.m3u8') || search.includes('m3u8')) return 'HLS (m3u8)';
    if (search.includes('.mpd') || search.includes('mpd')) return 'DASH (mpd)';
    if (search.includes('.mp4')) return 'MP4';

    return 'Video';
  } catch (e) {
    return 'Video';
  }
}

// Helper to extract a friendly filename
function getFriendlyFilename(url, type) {
  try {
    const urlObj = new URL(url);
    let name = urlObj.pathname.substring(urlObj.pathname.lastIndexOf('/') + 1);
    name = decodeURIComponent(name).split('?')[0];
    if (!name || name === 'index.m3u8' || name === 'manifest.mpd' || name === 'video.mp4') {
      return '';
    }
    return name;
  } catch (e) {
    return '';
  }
}

// Attempt to pull a resolution (video height, e.g. 1080) out of a stream URL.
function extractResolution(url) {
  try {
    const str = decodeURIComponent(url);

    const wxh = str.match(/(\d{3,4})\s*[xX]\s*(\d{3,4})/);
    if (wxh) {
      const h = parseInt(wxh[2], 10);
      if (KNOWN_HEIGHTS.includes(h)) return h;
    }

    for (const h of KNOWN_HEIGHTS) {
      const re = new RegExp(`(?:^|[^0-9])${h}p?(?:[^0-9]|$)`, 'i');
      if (re.test(str)) return h;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// Build a key that identifies "the same stream" across different resolutions
function getStreamGroupKey(url, resolution) {
  if (!resolution) return null;
  try {
    const re = new RegExp(`${resolution}p?`, 'gi');
    return url.replace(re, '{RES}');
  } catch (e) {
    return null;
  }
}

function isBetterResolution(currentRes, newRes) {
  if (currentRes === PREFERRED_RESOLUTION) return false;
  if (newRes === PREFERRED_RESOLUTION) return true;
  return newRes > currentRes;
}

// The same lecture often shows up twice: the player's master playlist (e.g. cdn.jwplayer.com/manifests/...)
// and the stream it points to on another host (e.g. ...jwpsrv.com). Same lecture + same length = one video.
// The extra one is hidden (not removed, so list positions used elsewhere stay valid).
function hideDuplicateVideos(tabId) {
  const list = detectedVideos[tabId] || [];
  const keyOf = (v) => {
    const p = v.place || {};
    const name = (p.name || v.lectureName || '').toLowerCase().trim();
    if (!name) return null;
    return [p.course, p.category, p.section, name].map((x) => String(x || '').toLowerCase()).join('|');
  };
  const score = (v) => (v.transcriptUrl ? 8 : 0) + ((v.subtitleTracks || []).length ? 4 : 0) +
    (/\/manifests?\/|master|playlist\.m3u8|index\.m3u8/i.test(v.url) ? 2 : 0) + (v.resolution ? 0 : 1);
  const sameLength = (a, b) => !a.duration || !b.duration || Math.abs(a.duration - b.duration) <= 3;
  list.forEach((v) => { delete v.duplicateOf; });
  const visible = list.filter((v) => !v.isSubtitleTrack);
  for (let i = 0; i < visible.length; i++) {
    const a = visible[i];
    if (a.duplicateOf) continue;
    const ka = keyOf(a);
    if (!ka) continue;
    for (let j = i + 1; j < visible.length; j++) {
      const b = visible[j];
      if (b.duplicateOf || keyOf(b) !== ka || !sameLength(a, b)) continue;
      const [keep, drop] = score(b) > score(a) ? [b, a] : [a, b];
      drop.duplicateOf = keep.url;
      keep.duration = keep.duration || drop.duration || null;
      keep.thumbnail = keep.thumbnail || drop.thumbnail || null;
      if (!keep.transcriptUrl && drop.transcriptUrl) { keep.transcriptUrl = drop.transcriptUrl; keep.transcriptType = drop.transcriptType; keep.transcriptLanguage = drop.transcriptLanguage; }
      if (drop === a) break;
    }
  }
}

function persistAndUpdate(tabId) {
  try { hideDuplicateVideos(tabId); } catch (e) { /* cosmetic */ }
  try { SubLib.syncVideoLib(tabId); } catch (e) { /* ignore */ }
  updateBadge(tabId);
  chrome.storage.local.set({ [`tab_${tabId}`]: detectedVideos[tabId] });
}

// --- Transcript pairing helpers -------------------------------------------

function getUrlDir(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    return path.substring(0, path.lastIndexOf('/') + 1);
  } catch (e) {
    return '';
  }
}

function getFilenameStem(url) {
  try {
    const u = new URL(url);
    let name = u.pathname.substring(u.pathname.lastIndexOf('/') + 1);
    name = decodeURIComponent(name).split('?')[0];
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) name = name.substring(0, dotIdx);
    return name.toLowerCase();
  } catch (e) {
    return '';
  }
}

// Try to attach a transcript to the best-matching video on this tab.
// Priority: (1) exact DOM-provided parent <video> URL, (2) same URL
// directory, (3) similar filename stem, (4) only one video on the tab.
// Returns true if a match was made.
function tryMatchTranscriptToVideo(tabId, transcript) {
  const videos = detectedVideos[tabId] || [];
  if (videos.length === 0) return false;

  if (transcript.explicitVideoUrl) {
    const exact = videos.find(v => v.url === transcript.explicitVideoUrl);
    if (exact) {
      exact.transcriptUrl = transcript.url;
      exact.transcriptType = transcript.type;
      exact.transcriptLanguage = resolveTranscriptLanguage(exact, transcript.url);
      return true;
    }
  }

  const transcriptDir = getUrlDir(transcript.url);
  const transcriptStem = getFilenameStem(transcript.url);

  let candidates = videos.filter(v => getUrlDir(v.url) === transcriptDir);

  if (candidates.length === 0) {
    candidates = videos.filter(v => {
      const vStem = getFilenameStem(v.url);
      return vStem && transcriptStem && (vStem.includes(transcriptStem) || transcriptStem.includes(vStem));
    });
  }

  if (candidates.length === 0 && videos.length === 1) {
    candidates = videos;
  }

  if (candidates.length === 0) return false;

  const target = candidates.reduce((a, b) => (a.detectedAt > b.detectedAt ? a : b));
  target.transcriptUrl = transcript.url;
  target.transcriptType = transcript.type;
  target.transcriptLanguage = resolveTranscriptLanguage(target, transcript.url);
  return true;
}

// Figure out what language a newly-arrived transcript file is in. Prefer
// whichever <track>/TextTrack the page itself reported as currently
// "showing" (the user just turned captions on for it) since that's the
// most reliable signal; otherwise fall back to reading the URL itself.
function resolveTranscriptLanguage(video, transcriptUrl) {
  const tracks = video.subtitleTracks || [];
  const active = tracks.find(t => t.mode === 'showing');
  if (active && (active.label || active.language)) {
    return active.label || active.language;
  }
  const fromUrl = guessLanguageFromUrl(transcriptUrl);
  if (fromUrl) return fromUrl;
  if (tracks.length === 1 && (tracks[0].label || tracks[0].language)) {
    return tracks[0].label || tracks[0].language;
  }
  return null;
}

// When a new video shows up, see if any transcript we couldn't place yet
// now has somewhere to go.
function tryAttachPendingTranscripts(tabId) {
  const pending = pendingTranscripts[tabId];
  if (!pending || pending.length === 0) return;

  const stillPending = [];
  pending.forEach(t => {
    if (!tryMatchTranscriptToVideo(tabId, t)) {
      stillPending.push(t);
    }
  });
  pendingTranscripts[tabId] = stillPending;
}

function addDetectedTranscript(tabId, url, type, explicitVideoUrl = null) {
  if (!pendingTranscripts[tabId]) pendingTranscripts[tabId] = [];

  const alreadyAttached = (detectedVideos[tabId] || []).some(v => v.transcriptUrl === url);
  const alreadyPending = pendingTranscripts[tabId].some(t => t.url === url);
  if (alreadyAttached || alreadyPending) return;

  const transcript = { url, type, detectedAt: Date.now(), explicitVideoUrl };
  const matched = tryMatchTranscriptToVideo(tabId, transcript);

  if (!matched) {
    pendingTranscripts[tabId].push(transcript);
  } else {
    persistAndUpdate(tabId);
  }
}

// Add a video to the detected list for a tab
function addDetectedVideo(tabId, url, type, title = '', thumbnail = null, duration = null, subtitleTracks = null) {
  if (!detectedVideos[tabId]) {
    detectedVideos[tabId] = [];
  }
  if (!streamGroups[tabId]) {
    streamGroups[tabId] = {};
  }

  const alreadyHaveUrl = detectedVideos[tabId].some(v => v.url === url);
  if (alreadyHaveUrl) return;

  const resolution = extractResolution(url);
  const groupKey = getStreamGroupKey(url, resolution);
  const filename = getFriendlyFilename(url, type);
  const pageTitle = title || filename || 'Detected Video';

  const entry = {
    url,
    type,
    filename,
    title: pageTitle,
    resolution,
    thumbnail: thumbnail || null,
    duration: duration || null,
    subtitleTracks: subtitleTracks || [],
    transcriptUrl: null,
    transcriptType: null,
    transcriptLanguage: null,
    detectedAt: Date.now()
  };

  if (groupKey && Object.prototype.hasOwnProperty.call(streamGroups[tabId], groupKey)) {
    const idx = streamGroups[tabId][groupKey];
    const current = detectedVideos[tabId][idx];

    if (current && isBetterResolution(current.resolution, resolution)) {
      entry.thumbnail = entry.thumbnail || current.thumbnail || null;
      entry.duration = entry.duration || current.duration || null;
      entry.subtitleTracks = (entry.subtitleTracks && entry.subtitleTracks.length) ? entry.subtitleTracks : (current.subtitleTracks || []);
      // Carry over any transcript already paired with the old entry.
      entry.transcriptUrl = current.transcriptUrl || null;
      entry.transcriptType = current.transcriptType || null;
      entry.transcriptLanguage = current.transcriptLanguage || null;
      entry.lectureName = current.lectureName || null;
      detectedVideos[tabId][idx] = entry;
      persistAndUpdate(tabId);
      if ((type || '').includes('HLS') && !entry.duration) {
        fetchAndAttachHlsDuration(tabId, url);
      }
    }
    return;
  }

  detectedVideos[tabId].push(entry);
  if (groupKey) {
    streamGroups[tabId][groupKey] = detectedVideos[tabId].length - 1;
  }

  // A subtitle file may have arrived before this video did.
  tryAttachPendingTranscripts(tabId);

  // Remember which lecture this video belongs to (same naming rules as subtitles).
  SubLib.attachLectureName(tabId, url);

  // Most detected videos are HLS streams played back through a blob: URL
  // (MediaSource), so the <video> element's own .duration never lines up
  // with this entry's real manifest URL and the on-page listener can't
  // report it here. Read it straight from the manifest instead — this is
  // what actually lets 50 similar-looking entries be told apart at a
  // glance, which DOM-only duration can't guarantee.
  if ((type || '').includes('HLS') && !entry.duration) {
    fetchAndAttachHlsDuration(tabId, url);
  }

  persistAndUpdate(tabId);
}

// Sum a VOD HLS playlist's #EXTINF entries to get the stream's total
// duration, purely for display in the popup list. Best-effort: any
// failure (live stream with no #EXT-X-ENDLIST, network error, odd
// manifest) just leaves duration blank rather than breaking anything.
async function fetchAndAttachHlsDuration(tabId, url) {
  if (hlsDurationFetchInFlight.has(url)) return;
  hlsDurationFetchInFlight.add(url);

  try {
    const res = await fetch(url);
    if (!res.ok) return;
    let text = await res.text();
    if (!text.includes('#EXTM3U')) return;

    let mediaPlaylistUrl = url;

    if (text.includes('#EXT-X-STREAM-INF')) {
      const lines = text.split('\n');
      let variantUrl = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('#EXT-X-STREAM-INF:')) {
          for (let j = i + 1; j < lines.length; j++) {
            const checkLine = lines[j].trim();
            if (checkLine && !checkLine.startsWith('#')) {
              variantUrl = checkLine;
              break;
            }
          }
          if (variantUrl) break; // duration is the same across renditions for VOD
        }
      }
      if (!variantUrl) return;
      mediaPlaylistUrl = resolveUrl(url, variantUrl);
      const subRes = await fetch(mediaPlaylistUrl);
      if (!subRes.ok) return;
      text = await subRes.text();
    }

    let total = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#EXTINF:')) {
        const value = parseFloat(trimmed.slice('#EXTINF:'.length));
        if (!isNaN(value)) total += value;
      }
    }
    // Only trust this as "the video's length" for a finished VOD playlist.
    // A live/ongoing stream's playlist is just a sliding window of recent
    // segments, so its EXTINF sum isn't the real duration and would be
    // actively misleading in the list.
    if (total <= 0 || !text.includes('#EXT-X-ENDLIST')) return;

    const list = detectedVideos[tabId];
    if (!list) return;
    const entry = list.find(v => v.url === url);
    if (entry && !entry.duration) {
      entry.duration = total;
      persistAndUpdate(tabId);
    }
  } catch (e) {
    // Ignore — display duration is a nice-to-have, not worth surfacing an error for.
  } finally {
    hlsDurationFetchInFlight.delete(url);
  }
}

// Update the badge count for a tab
function updateBadge(tabId) {
  // Subtitle-track playlists are not videos, so they don't count here.
  const count = detectedVideos[tabId] ? detectedVideos[tabId].filter(v => !v.isSubtitleTrack && !v.duplicateOf).length : 0;
  // .catch: the tab may already be closed (Chrome then rejects with "No tab with id")
  chrome.action.setBadgeText({
    tabId: tabId,
    text: count > 0 ? count.toString() : ''
  }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({
    tabId: tabId,
    color: '#6366f1'
  }).catch(() => {});
  // Green badge with the number of subtitles captured on this tab takes over once there are any.
  SubLib.refreshBadge(tabId, count);
}

// Intercept network requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId } = details;

    if (tabId === -1 || tabId === undefined) return;

    const urlLower = url.toLowerCase();

    // Diagnostics: remember anything that looks caption-related (shown in the popup's Diagnostics box).
    SubLib.noteCandidate(url, tabId, 'request');

    if (urlLower.includes('.js') || urlLower.includes('.css') || urlLower.includes('.png') || urlLower.includes('.jpg') || urlLower.includes('.gif') || urlLower.includes('.svg')) {
      return;
    }

    // --- Subtitle / transcript files ---
    // Every subtitle goes into the global subtitle library (cached, language-labelled).
    // Single-file ones are also still paired with their video for the Videos tab.
    const subType = SubLib.sniffSubtitleType(url);
    if (subType) {
      if (!SubLib.looksLikeSegment(url)) {
        addDetectedTranscript(tabId, url, subType === 'TTML' ? 'TXT' : subType);
        SubLib.registerSubtitle({ tabId, url, type: subType });
      }
      return;
    }

    // --- Video streams ---
    let type = null;
    if (urlLower.includes('.m3u8') || urlLower.includes('/m3u8') || urlLower.includes('.m3u8?')) {
      type = 'HLS (m3u8)';
    } else if (urlLower.includes('.mp4') || urlLower.includes('/mp4/') || urlLower.includes('.mp4?')) {
      type = 'MP4';
    } else if (urlLower.includes('.webm') || urlLower.includes('/webm/') || urlLower.includes('.webm?')) {
      type = 'WEBM';
    } else if (urlLower.includes('.mpd') || urlLower.includes('/mpd/') || urlLower.includes('.mpd?')) {
      type = 'DASH (mpd)';
    } else if (urlLower.includes('.ts') && !urlLower.includes('m3u8')) {
      return;
    }

    if (type) {
      addDetectedVideo(tabId, url, type);
      // An .m3u8 may actually be a master playlist that lists subtitle tracks, or a
      // subtitle track itself. Look inside; this also hides subtitle playlists from the video list.
      if (type === 'HLS (m3u8)') SubLib.classifyHls(tabId, url);
    }
  },
  { urls: ["<all_urls>"] }
);

// ============================================================================
// FILENAME HELPERS
// ============================================================================

function getPageTitleForTab(tabId) {
  return new Promise((resolve) => {
    if (tabPageTitles[tabId]) {
      resolve(tabPageTitles[tabId]);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.title) {
        tabPageTitles[tabId] = tab.title;
      }
      resolve(tabPageTitles[tabId] || null);
    });
  });
}

// Strip characters that are invalid in filenames and turn whitespace into
// underscores, e.g. "Lecture 1: Port Scanning" -> "Lecture_1_Port_Scanning"
function sanitizeFilename(name) {
  if (!name) return '';
  let clean = name
    .replace(/[\\/*?:"<>|]/g, '_')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  clean = clean.replace(/\s+/g, '_');
  clean = clean.replace(/_{2,}/g, '_');
  clean = clean.replace(/^[_.\s]+|[_.\s]+$/g, '');
  return clean.substring(0, 150);
}

function extensionFor(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('hls')) return 'ts';
  if (t.includes('webm')) return 'webm';
  return 'mp4';
}

// The single source of truth for "what do we call this video", shared by
// both the video filename and the transcript filename so they always match.
async function resolveBaseTitle(tabId, video) {
  let titleSource = video.title && !GENERIC_TITLES.has(video.title) ? video.title : null;
  if (!titleSource) {
    titleSource = await getPageTitleForTab(tabId);
  }
  if (!titleSource) {
    titleSource = video.filename || 'video';
  }
  return sanitizeFilename(titleSource) || 'video';
}

async function buildFilename(tabId, video) {
  const cleanTitle = await resolveBaseTitle(tabId, video);
  return `${cleanTitle}.${extensionFor(video.type)}`;
}

async function buildTranscriptFilename(tabId, video) {
  const cleanTitle = await resolveBaseTitle(tabId, video);
  const ext = (video.transcriptType || 'srt').toLowerCase();
  return `${cleanTitle}.${ext}`;
}

// ============================================================================
// DOWNLOAD ENGINE (runs entirely here so it survives the popup closing)
// Structure: { [downloadId]: { downloadId, tabId, url, filename, isHls,
//              isTranscript, status, percent, statusText, error,
//              chromeDownloadId, ... } }
// ============================================================================
const downloadState = {};
const downloadControllers = {}; // downloadId -> Set<AbortController> (in-flight segment fetches)
const downloadCancelled = {};   // downloadId -> boolean
const chromeDownloadIdToOurId = {}; // native chrome.downloads id -> our downloadId

let keepAliveActive = false;
let persistTimer = null;

// ============================================================================
// DATA & SPEED SAVER (v1.11.0)
// Slow, laptop-friendly downloads for limited mobile data:
//  - quality cap (the only setting that actually uses LESS data per video)
//  - pace: "realtime" = each segment takes ~80% of its playing time
//          (7-min lecture ≈ 5.5 min), "limit" = fixed KB/s cap, "off" = full speed
//  - parallel segment fetches (1 = lightest on CPU/RAM)
//  - wait between videos in a batch (used in subs-library.js)
//  - daily data limit + "used today" counter
// ============================================================================
const NET_DEFAULTS = {
  quality: '720',        // 'best' | '1080' | '720' | '480' | '360' | 'lowest'
  pace: 'realtime',      // 'realtime' | 'limit' | 'off'
  realtimeFactor: 0.8,   // download time = 80% of video length
  speedKBps: 250,        // used when pace = 'limit'
  parallel: 1,           // segment fetches at the same time (1-5)
  delaySec: 60,          // wait between videos in a batch
  dailyLimitMB: 1500     // 0 = no limit
};
let NET = Object.assign({}, NET_DEFAULTS);
let netLoaded = null;
function loadNetPrefs() {
  if (!netLoaded) {
    netLoaded = chrome.storage.local.get(['netPrefs', 'dataUsage']).then((d) => {
      NET = Object.assign({}, NET_DEFAULTS, d.netPrefs || {});
      if (d.dataUsage) dataUsage = d.dataUsage;
    });
  }
  return netLoaded;
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.netPrefs) NET = Object.assign({}, NET_DEFAULTS, ch.netPrefs.newValue || {});
});
function getNetPrefs() { return NET; }

// --- daily data usage counter ---
const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
let dataUsage = { day: todayKey(), bytes: 0 };
let usageTimer = null;
function rollUsageDay() { if (dataUsage.day !== todayKey()) dataUsage = { day: todayKey(), bytes: 0 }; }
function addDataUsage(n) {
  if (!n) return;
  rollUsageDay();
  dataUsage.bytes += n;
  if (!usageTimer) usageTimer = setTimeout(() => { usageTimer = null; chrome.storage.local.set({ dataUsage }); }, 1000);
}
function usedTodayMB() { rollUsageDay(); return dataUsage.bytes / 1048576; }
function dailyLimitReached() { return NET.dailyLimitMB > 0 && usedTodayMB() >= NET.dailyLimitMB; }

// --- global speed limiter (shared by every download, so the TOTAL stays under the cap) ---
let limiterClock = 0;
async function throttleBytes(n, bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return;
  const now = Date.now();
  limiterClock = Math.max(limiterClock, now - 500) + (n / bytesPerSec) * 1000; // allow ~0.5 s burst only
  const wait = limiterClock - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// Read a fetch() body chunk by chunk, counting data and (optionally) pacing it.
// Reading slowly makes the network itself slow down (TCP back-pressure), so this
// really limits the speed instead of just delaying after the fact.
async function readBodyPaced(res, { bytesPerSec = 0, onBytes = null, signal = null } = {}) {
  if (!res.body || !res.body.getReader) {
    const b = await res.blob(); addDataUsage(b.size); if (onBytes) onBytes(b.size); return b;
  }
  const reader = res.body.getReader();
  const parts = [];
  for (;;) {
    if (signal && signal.aborted) { try { reader.cancel(); } catch (e) { /* ignore */ } throw new Error('Cancelled'); }
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    addDataUsage(value.byteLength);
    if (onBytes) onBytes(value.byteLength);
    await throttleBytes(value.byteLength, bytesPerSec);
  }
  // keep the real file type, otherwise Chrome saves e.g. a video as .txt
  const type = ((res.headers && res.headers.get('content-type')) || 'application/octet-stream').split(';')[0].trim();
  return new Blob(parts, { type });
}

// Pick the stream variant according to the quality setting.
function pickVariant(variants, quality) {
  if (!variants.length) return null;
  const byBw = [...variants].sort((a, b) => a.bw - b.bw);
  if (quality === 'lowest') return byBw[0].url;
  if (quality === 'best' || !quality) {
    const p = variants.find((v) => v.height === PREFERRED_RESOLUTION);
    return (p || byBw[byBw.length - 1]).url;
  }
  const cap = parseInt(quality, 10);
  const fit = variants.filter((v) => v.height && v.height <= cap).sort((a, b) => (b.height - a.height) || (b.bw - a.bw));
  if (fit.length) return fit[0].url;
  return byBw[0].url; // nothing small enough: take the smallest available
}

loadNetPrefs();

function ensureKeepAlive() {
  if (keepAliveActive) return;
  keepAliveActive = true;
  chrome.alarms.create('downloader-heartbeat', { periodInMinutes: 1 });
}

function maybeStopKeepAlive() {
  const anyActive = Object.keys(downloadState).length > 0;
  if (!anyActive) {
    keepAliveActive = false;
    chrome.alarms.clear('downloader-heartbeat');
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.local.set({ activeDownloads: downloadState });
  }, 250);
}

function updateDownloadState(downloadId, patch, { immediate = false } = {}) {
  if (!downloadState[downloadId]) return;
  Object.assign(downloadState[downloadId], patch, { updatedAt: Date.now() });

  chrome.runtime.sendMessage(
    { action: 'downloadProgress', downloadId, state: downloadState[downloadId] },
    () => { void chrome.runtime.lastError; }
  );

  if (immediate) {
    chrome.storage.local.set({ activeDownloads: downloadState });
  } else {
    schedulePersist();
  }
}

function removeDownloadState(downloadId, delayMs = 0) {
  setTimeout(() => {
    delete downloadState[downloadId];
    delete downloadControllers[downloadId];
    delete downloadCancelled[downloadId];
    chrome.storage.local.set({ activeDownloads: downloadState });
    maybeStopKeepAlive();
  }, delayMs);
}

function findExistingDownload(tabId, url) {
  for (const id in downloadState) {
    const d = downloadState[id];
    if (d.tabId === tabId && d.url === url) {
      return id;
    }
  }
  return null;
}

function generateDownloadId() {
  return `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return relative;
  }
}

async function decryptSegment(arrayBuffer, segment) {
  const keyInfo = segment.keyInfo;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyInfo.keyBuffer,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );

  let iv = keyInfo.iv;
  if (!iv) {
    iv = new Uint8Array(16);
    const seq = segment.sequence;
    iv[12] = (seq >> 24) & 0xff;
    iv[13] = (seq >> 16) & 0xff;
    iv[14] = (seq >> 8) & 0xff;
    iv[15] = seq & 0xff;
  }

  return crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, arrayBuffer);
}

// ---------------------------------------------------------------------------
// MEMORY-SAFE FILE HAND-OFF
//
// The old code merged every segment into one giant ArrayBuffer, base64-encoded
// it into a string, wrapped that in a data: URL and gave it to
// chrome.downloads. For a 1 GB video that meant ~5-6 GB of RAM copies
// (segments + merged buffer + binary string + base64 string + data URL +
// the copy sent to the browser process), which pinned RAM/disk at ~98% on an
// 8 GB machine.
//
// Now each segment is kept as a Blob (Chrome pages Blobs out to disk on its
// own), the final file is a Blob *composed of* those Blobs (no copy), and a
// tiny blob: URL is created in an offscreen document (service workers cannot
// call URL.createObjectURL) and handed to chrome.downloads.
// ---------------------------------------------------------------------------
const blobChannel = new BroadcastChannel('blob-downloader-offscreen');
const pendingBlobUrlRequests = {}; // requestId -> { resolve, reject, timer }
const blobUrlByDownloadId = {};    // our downloadId -> blob: URL (so we can revoke it)

blobChannel.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type !== 'blob-url-result') return;
  const pending = pendingBlobUrlRequests[msg.requestId];
  if (!pending) return;
  clearTimeout(pending.timer);
  delete pendingBlobUrlRequests[msg.requestId];
  if (msg.error) pending.reject(new Error(msg.error));
  else pending.resolve(msg.url);
};

let offscreenCreating = null;
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length > 0) return;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create blob: URLs so large merged video files can be saved without loading them into memory.'
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function createBlobUrl(blob) {
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      delete pendingBlobUrlRequests[requestId];
      reject(new Error('Timed out creating the file URL'));
    }, 30000);
    pendingBlobUrlRequests[requestId] = { resolve, reject, timer };
    blobChannel.postMessage({ type: 'create-blob-url', requestId, blob });
  });
}

function revokeBlobUrl(downloadId) {
  const url = blobUrlByDownloadId[downloadId];
  if (!url) return;
  delete blobUrlByDownloadId[downloadId];
  blobChannel.postMessage({ type: 'revoke-blob-url', url });

  // Close the offscreen document once nothing needs it any more.
  if (Object.keys(blobUrlByDownloadId).length === 0 && Object.keys(pendingBlobUrlRequests).length === 0) {
    chrome.offscreen.closeDocument().catch(() => {});
  }
}

// Small-file fallback only (data: URLs are fine up to a few tens of MB).
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

// Kick off a plain (non-HLS) download via chrome.downloads, which is already
// independent of the popup's lifetime. Also used for transcript files.
function runDirectDownload(downloadId, url, filename) {
  updateDownloadState(downloadId, { status: 'downloading', statusText: 'Downloading...', percent: 0 }, { immediate: true });

  chrome.downloads.download({ url, filename, saveAs: false }, (chromeDownloadId) => {
    if (chrome.runtime.lastError || chromeDownloadId === undefined) {
      updateDownloadState(downloadId, {
        status: 'error',
        statusText: 'Error: could not start download',
        error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Failed to start download'
      }, { immediate: true });
      removeDownloadState(downloadId, 4000);
      return;
    }
    chromeDownloadIdToOurId[chromeDownloadId] = downloadId;
    updateDownloadState(downloadId, { chromeDownloadId }, { immediate: true });
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  const downloadId = chromeDownloadIdToOurId[delta.id];
  if (!downloadId || !downloadState[downloadId]) return;

  if (delta.state) {
    if (delta.state.current === 'complete') {
      if (downloadState[downloadId].countNative) {
        chrome.downloads.search({ id: delta.id }, (items) => {
          if (!chrome.runtime.lastError && items && items[0]) addDataUsage(items[0].bytesReceived || 0);
        });
      }
      updateDownloadState(downloadId, { status: 'complete', percent: 100, statusText: 'Complete!' }, { immediate: true });
      removeDownloadState(downloadId, 1500);
      revokeBlobUrl(downloadId);
      delete chromeDownloadIdToOurId[delta.id];
    } else if (delta.state.current === 'interrupted') {
      if (downloadCancelled[downloadId]) {
        updateDownloadState(downloadId, { status: 'cancelled', statusText: 'Cancelled', percent: 0 }, { immediate: true });
        removeDownloadState(downloadId, 800);
      } else {
        updateDownloadState(downloadId, { status: 'error', statusText: 'Download interrupted', error: 'interrupted' }, { immediate: true });
        removeDownloadState(downloadId, 4000);
      }
      revokeBlobUrl(downloadId);
      delete chromeDownloadIdToOurId[delta.id];
    }
  }
});

function refreshNativeDownloadProgress() {
  const ids = Object.keys(chromeDownloadIdToOurId);
  if (ids.length === 0) return;

  chrome.downloads.search({}, (items) => {
    if (chrome.runtime.lastError || !items) return;
    items.forEach((item) => {
      const downloadId = chromeDownloadIdToOurId[item.id];
      if (!downloadId || !downloadState[downloadId]) return;
      if (item.totalBytes > 0) {
        const percent = Math.min(99, Math.floor((item.bytesReceived / item.totalBytes) * 100));
        const mbReceived = (item.bytesReceived / 1048576).toFixed(1);
        const mbTotal = (item.totalBytes / 1048576).toFixed(1);
        updateDownloadState(downloadId, {
          percent,
          statusText: `Downloading ${mbReceived}MB / ${mbTotal}MB`
        });
      }
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'downloader-heartbeat') {
    refreshNativeDownloadProgress();
  }
});

// Full HLS pipeline: fetch master/media playlist, pick the 1080p (or best)
// rendition, download segments with 5x concurrency, decrypt AES-128 if
// needed, stitch into one file, and hand off to chrome.downloads.
async function runHlsDownload(downloadId, url, filename) {
  const controllers = downloadControllers[downloadId];
  const isCancelled = () => downloadCancelled[downloadId];

  const setProgress = (statusText, percent) => {
    if (isCancelled()) return;
    updateDownloadState(downloadId, { status: 'downloading', statusText, percent });
  };

  try {
    setProgress('Fetching playlist...', 0);

    const playlistRes = await fetch(url);
    if (!playlistRes.ok) throw new Error(`Failed to load playlist: HTTP ${playlistRes.status}`);
    const playlistText = await playlistRes.text();

    if (!playlistText.includes('#EXTM3U')) {
      throw new Error('Not a valid HLS playlist (missing #EXTM3U)');
    }

    let mediaPlaylistUrl = url;
    let mediaPlaylistText = playlistText;

    if (playlistText.includes('#EXT-X-STREAM-INF')) {
      setProgress('Parsing master stream qualities...', 5);
      const lines = playlistText.split('\n');
      const variants = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
          const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
          const height = resMatch ? parseInt(resMatch[1], 10) : null;

          let urlLine = '';
          for (let j = i + 1; j < lines.length; j++) {
            const checkLine = lines[j].trim();
            if (checkLine && !checkLine.startsWith('#')) {
              urlLine = checkLine;
              break;
            }
          }

          if (urlLine) variants.push({ url: urlLine, bw, height });
        }
      }

      const chosenStreamUrl = pickVariant(variants, NET.quality);
      const chosen = variants.find((v) => v.url === chosenStreamUrl);
      if (chosen && chosen.height) updateDownloadState(downloadId, { quality: chosen.height + 'p' });

      if (chosenStreamUrl) {
        mediaPlaylistUrl = resolveUrl(url, chosenStreamUrl);
        setProgress('Fetching media playlist...', 10);
        const subRes = await fetch(mediaPlaylistUrl);
        if (!subRes.ok) throw new Error(`Failed to load sub-playlist: HTTP ${subRes.status}`);
        mediaPlaylistText = await subRes.text();
      }
    }

    setProgress('Parsing playlist segments...', 15);
    const lines = mediaPlaylistText.split('\n');
    const segments = [];
    let keyInfo = null;
    let sequenceNum = 0;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        sequenceNum = parseInt(line.split(':')[1].trim(), 10) || 0;
        break;
      }
    }

    let currentSeq = sequenceNum;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = line.match(/METHOD=([^,\s]+)/);
        const uriMatch = line.match(/URI="([^"]+)"/);
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/);

        if (methodMatch && methodMatch[1] === 'AES-128') {
          const keyUri = uriMatch ? resolveUrl(mediaPlaylistUrl, uriMatch[1]) : null;
          let keyIv = null;
          if (ivMatch) {
            const hex = ivMatch[1];
            keyIv = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
          }
          keyInfo = { uri: keyUri, iv: keyIv, keyBuffer: null };
        } else if (methodMatch && methodMatch[1] === 'NONE') {
          keyInfo = null;
        } else if (methodMatch) {
          throw new Error(`Unsupported encryption method: ${methodMatch[1]}`);
        }
      }

      if (line.startsWith('#EXTINF:')) {
        let segmentUrlLine = '';
        for (let j = i + 1; j < lines.length; j++) {
          const checkLine = lines[j].trim();
          if (checkLine && !checkLine.startsWith('#')) {
            segmentUrlLine = checkLine;
            break;
          }
        }

        if (segmentUrlLine) {
          const durMatch = line.match(/#EXTINF:\s*([\d.]+)/);
          segments.push({
            url: resolveUrl(mediaPlaylistUrl, segmentUrlLine),
            duration: durMatch ? parseFloat(durMatch[1]) || 0 : 0,
            sequence: currentSeq,
            keyInfo: keyInfo ? { ...keyInfo } : null
          });
          currentSeq++;
        }
      }
    }

    if (segments.length === 0) {
      throw new Error('No TS video segments found in HLS stream.');
    }

    if (keyInfo && keyInfo.uri) {
      setProgress('Fetching AES decryption key...', 20);
      const keyRes = await fetch(keyInfo.uri);
      if (!keyRes.ok) throw new Error(`Failed to load AES key: HTTP ${keyRes.status}`);
      const keyBuffer = await keyRes.arrayBuffer();

      for (const seg of segments) {
        if (seg.keyInfo) seg.keyInfo.keyBuffer = keyBuffer;
      }
    }

    // Data & speed saver: "realtime" pace forces one segment at a time so the
    // timing below is exact; otherwise use the chosen number of parallel fetches.
    const pace = NET.pace || 'off';
    const concurrency = pace === 'realtime' ? 1 : Math.max(1, Math.min(5, parseInt(NET.parallel, 10) || 1));
    const limitBps = pace === 'limit' ? Math.max(16, NET.speedKBps || 250) * 1024 : 0;
    const factor = Math.min(1.5, Math.max(0.2, NET.realtimeFactor || 0.8));
    const totalVideoSec = segments.reduce((s, x) => s + (x.duration || 0), 0);
    const paceNote = pace === 'realtime' && totalVideoSec
      ? ` · ~${Math.max(1, Math.round(totalVideoSec * factor / 60))} min`
      : (pace === 'limit' ? ` · ${Math.round(limitBps / 1024)} KB/s` : '');
    let bytesDone = 0;

    setProgress(`Starting segment downloads 0/${segments.length}...`, 25);
    const results = new Array(segments.length);
    let downloadedCount = 0;

    // Fetch one segment and return it as a Blob. Blobs live in Chrome's blob
    // storage (which spills to disk under memory pressure) instead of the
    // service worker's JS heap. Only encrypted segments need to pass through
    // an ArrayBuffer, and that buffer is released right after decryption.
    const fetchSegmentBlob = async (segment, signal) => {
      const t0 = Date.now();
      const res = await fetch(segment.url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let blob = await readBodyPaced(res, { bytesPerSec: limitBps, signal, onBytes: (n) => { bytesDone += n; } });
      if (segment.keyInfo && segment.keyInfo.keyBuffer) {
        const decrypted = await decryptSegment(await blob.arrayBuffer(), segment);
        blob = new Blob([decrypted]);
      }
      // Realtime pace: make this segment take ~factor × its playing time.
      if (pace === 'realtime' && segment.duration) {
        const wait = segment.duration * factor * 1000 - (Date.now() - t0);
        for (let left = wait; left > 0 && !isCancelled(); left -= 500) await new Promise((r) => setTimeout(r, Math.min(500, left)));
      } else if (pace !== 'off') {
        await new Promise((r) => setTimeout(r, 150)); // small breather for the laptop
      }
      return blob;
    };

    const downloadSegment = async (index) => {
      if (isCancelled()) return;
      const segment = segments[index];
      const controller = new AbortController();
      controllers.add(controller);

      try {
        try {
          results[index] = await fetchSegmentBlob(segment, controller.signal);
        } catch (err) {
          if (isCancelled()) return;
          console.warn(`Error on segment ${index}, retrying...`, err);
          try {
            results[index] = await fetchSegmentBlob(segment, controller.signal);
          } catch (retryErr) {
            if (isCancelled()) return;
            throw new Error(`Segment #${index} download failed: ${retryErr.message}`);
          }
        }
        downloadedCount++;
        const prog = Math.floor(25 + (downloadedCount / segments.length) * 65);
        setProgress(`Downloading segment ${downloadedCount}/${segments.length} · ${(bytesDone / 1048576).toFixed(1)} MB${paceNote}`, prog);
      } finally {
        controllers.delete(controller);
      }
    };

    const queue = [...Array(segments.length).keys()];
    const workers = [];

    const worker = async () => {
      while (queue.length > 0 && !isCancelled()) {
        const idx = queue.shift();
        await downloadSegment(idx);
      }
    };

    for (let w = 0; w < Math.min(concurrency, segments.length); w++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    if (isCancelled()) {
      throw new Error('Cancelled');
    }

    for (let i = 0; i < results.length; i++) {
      if (!results[i]) {
        throw new Error(`Download incomplete: segment ${i} missing`);
      }
    }

    // "Merging" is now just composing Blob references - no bytes are copied.
    setProgress('Merging video streams...', 92);
    const mergedBlob = new Blob(results, { type: 'video/mp2t' });
    results.length = 0; // drop our references to the per-segment blobs

    setProgress('Preparing file...', 97);
    let fileUrl;
    try {
      fileUrl = await createBlobUrl(mergedBlob);
      blobUrlByDownloadId[downloadId] = fileUrl;
    } catch (e) {
      // Offscreen document unavailable. A data: URL is only safe for small files.
      const SMALL_FILE_LIMIT = 64 * 1024 * 1024;
      if (mergedBlob.size > SMALL_FILE_LIMIT) {
        throw new Error(`Could not prepare the file for saving (${e.message}). Check the extension's service worker console.`);
      }
      console.warn('Offscreen blob URL failed, using data URL for small file:', e);
      fileUrl = await blobToDataUrl(mergedBlob);
    }

    setProgress('Saving file...', 99);
    const chromeDownloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({ url: fileUrl, filename, saveAs: false }, (id) => {
        if (chrome.runtime.lastError || id === undefined) {
          reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Failed to save the file'));
          return;
        }
        resolve(id);
      });
    });

    // Let the native downloads.onChanged handler mark this complete (and
    // revoke the blob URL) once Chrome has actually finished writing the file.
    chromeDownloadIdToOurId[chromeDownloadId] = downloadId;
    updateDownloadState(downloadId, {
      chromeDownloadId,
      status: 'downloading',
      statusText: 'Saving to disk...',
      percent: 99
    }, { immediate: true });

  } catch (err) {
    if (isCancelled() || err.message === 'Cancelled') {
      updateDownloadState(downloadId, { status: 'cancelled', statusText: 'Cancelled', percent: 0 }, { immediate: true });
      removeDownloadState(downloadId, 800);
    } else {
      console.error(err);
      updateDownloadState(downloadId, { status: 'error', statusText: `Error: ${err.message}`, error: err.message }, { immediate: true });
      removeDownloadState(downloadId, 4000);
    }
    revokeBlobUrl(downloadId);
  }
}

// Plain (non-HLS) file with the speed saver on: we fetch it ourselves, slowly,
// then hand the finished file to Chrome. Falls back to a normal download if
// the site refuses the request from the extension.
async function runPacedDirectDownload(downloadId, url, filename, durationSec) {
  const isCancelled = () => downloadCancelled[downloadId];
  const controller = new AbortController();
  downloadControllers[downloadId].add(controller);
  try {
    updateDownloadState(downloadId, { status: 'downloading', statusText: 'Connecting (speed saver on)...', percent: 0 }, { immediate: true });
    const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fallback: true });
    const total = parseInt(res.headers.get('content-length') || '0', 10);
    let bps = Math.max(16, NET.speedKBps || 250) * 1024;
    if (NET.pace === 'realtime' && total && durationSec) bps = total / (durationSec * Math.min(1.5, Math.max(0.2, NET.realtimeFactor || 0.8)));
    let got = 0;
    const blob = await readBodyPaced(res, {
      bytesPerSec: bps, signal: controller.signal,
      onBytes: (n) => {
        got += n;
        const mb = (got / 1048576).toFixed(1);
        updateDownloadState(downloadId, {
          percent: total ? Math.min(98, Math.floor(got / total * 100)) : 0,
          statusText: total ? `Downloading ${mb} / ${(total / 1048576).toFixed(1)} MB · ${Math.round(bps / 1024)} KB/s` : `Downloading ${mb} MB · ${Math.round(bps / 1024)} KB/s`
        });
      }
    });
    if (isCancelled()) throw new Error('Cancelled');
    updateDownloadState(downloadId, { statusText: 'Saving file...', percent: 99 });
    const fileUrl = await createBlobUrl(blob);
    blobUrlByDownloadId[downloadId] = fileUrl;
    const chromeDownloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({ url: fileUrl, filename, saveAs: false }, (id) => {
        if (chrome.runtime.lastError || id === undefined) reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Failed to save the file'));
        else resolve(id);
      });
    });
    chromeDownloadIdToOurId[chromeDownloadId] = downloadId;
    updateDownloadState(downloadId, { chromeDownloadId, statusText: 'Saving to disk...', percent: 99 }, { immediate: true });
  } catch (err) {
    if (isCancelled() || err.message === 'Cancelled') {
      updateDownloadState(downloadId, { status: 'cancelled', statusText: 'Cancelled', percent: 0 }, { immediate: true });
      removeDownloadState(downloadId, 800);
    } else if (err.fallback || err instanceof TypeError) {
      // Site blocked our own request (CORS / login check): use Chrome's normal downloader.
      console.warn('Speed saver not possible for this file, downloading normally:', err);
      updateDownloadState(downloadId, { countNative: true });
      runDirectDownload(downloadId, url, filename);
      updateDownloadState(downloadId, { statusText: 'Speed limit not possible for this file — normal download' });
    } else {
      updateDownloadState(downloadId, { status: 'error', statusText: `Error: ${err.message}`, error: err.message }, { immediate: true });
      removeDownloadState(downloadId, 4000);
    }
    revokeBlobUrl(downloadId);
  } finally {
    if (downloadControllers[downloadId]) downloadControllers[downloadId].delete(controller);
  }
}

// Entry point called from the popup to start a video download.
async function startDownload(tabId, video) {
  const existing = findExistingDownload(tabId, video.url);
  if (existing) {
    return { downloadId: existing, alreadyRunning: true };
  }

  await loadNetPrefs();
  if (!video.ignoreLimit && dailyLimitReached()) {
    return { error: `Daily data limit reached (${Math.round(usedTodayMB())} of ${NET.dailyLimitMB} MB used today). Raise it in "Data & speed saver" or try tomorrow.`, limitReached: true };
  }

  const isHls = (video.type || '').includes('HLS');
  const paced = !isHls && NET.pace !== 'off';
  // customName (set by the batch queue) is a ready-made relative path such as "Videos/01_Intro.ts"
  const filename = video.customName || await buildFilename(tabId, video);
  const downloadId = generateDownloadId();

  downloadState[downloadId] = {
    downloadId,
    tabId,
    url: video.url,
    filename,
    isHls,
    isTranscript: false,
    paced,
    countNative: !isHls && !paced,
    status: 'starting',
    percent: 0,
    statusText: 'Starting...',
    error: null,
    startedAt: Date.now()
  };
  downloadControllers[downloadId] = new Set();
  downloadCancelled[downloadId] = false;
  chrome.storage.local.set({ activeDownloads: downloadState });
  ensureKeepAlive();

  if (isHls) {
    runHlsDownload(downloadId, video.url, filename); // fire and forget — runs independently of the popup
  } else if (paced) {
    runPacedDirectDownload(downloadId, video.url, filename, Number(video.duration) || 0);
  } else {
    runDirectDownload(downloadId, video.url, filename);
  }

  return { downloadId };
}

// Entry point called from the popup to start a transcript download. The
// filename is built from the exact same title-resolution logic as the
// video, so "Lecture_1.mp4" always pairs with "Lecture_1.srt"/".vtt".
async function startTranscriptDownload(tabId, video) {
  if (!video.transcriptUrl) {
    return { error: 'No transcript available for this video.' };
  }

  const existing = findExistingDownload(tabId, video.transcriptUrl);
  if (existing) {
    return { downloadId: existing, alreadyRunning: true };
  }

  const filename = await buildTranscriptFilename(tabId, video);
  const downloadId = generateDownloadId();

  downloadState[downloadId] = {
    downloadId,
    tabId,
    url: video.transcriptUrl,
    filename,
    isHls: false,
    isTranscript: true,
    status: 'starting',
    percent: 0,
    statusText: 'Starting...',
    error: null,
    startedAt: Date.now()
  };
  downloadControllers[downloadId] = new Set();
  downloadCancelled[downloadId] = false;
  chrome.storage.local.set({ activeDownloads: downloadState });
  ensureKeepAlive();

  runDirectDownload(downloadId, video.transcriptUrl, filename);

  return { downloadId };
}

function cancelDownload(downloadId) {
  const entry = downloadState[downloadId];
  if (!entry) return { success: false };

  downloadCancelled[downloadId] = true;
  const controllers = downloadControllers[downloadId];
  if (controllers) {
    for (const c of controllers) c.abort();
  }

  if (entry.chromeDownloadId !== undefined) {
    chrome.downloads.cancel(entry.chromeDownloadId, () => { void chrome.runtime.lastError; });
  }

  if (!entry.isHls) {
    updateDownloadState(downloadId, { status: 'cancelled', statusText: 'Cancelled' }, { immediate: true });
    removeDownloadState(downloadId, 800);
  }

  return { success: true };
}

// ============================================================================
// MESSAGE ROUTER
// ============================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getDetectedVideos') {
    const tabId = message.tabId;
    sendResponse({ videos: detectedVideos[tabId] || [] });

  } else if (message.action === 'addScrapedVideos') {
    const { tabId, videos, transcripts, pageTitle } = message;
    if (pageTitle) {
      tabPageTitles[tabId] = pageTitle;
    }
    if (videos && Array.isArray(videos)) {
      videos.forEach(v => {
        addDetectedVideo(tabId, v.url, v.type, v.title, v.thumbnail, v.duration, v.subtitleTracks);
      });
    }
    if (transcripts && Array.isArray(transcripts)) {
      transcripts.forEach(t => {
        addDetectedTranscript(tabId, t.url, t.type, t.videoUrl || null);
        // <track> elements state their language explicitly; pass it on to the subtitle library.
        SubLib.registerSubtitle({
          tabId, url: t.url, type: t.type,
          hls: (t.srclang || t.label) ? { language: t.srclang || null, name: t.label || null } : undefined
        });
      });
    }
    sendResponse({ success: true });

  } else if (message.action === 'updateVideoDuration') {
    // Sent from a content script (installPageListeners), so the tab id
    // comes from the message sender, not the message body.
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    const { url, duration } = message;
    const list = detectedVideos[tabId];
    if (list) {
      const video = list.find(v => v.url === url);
      if (video && duration) {
        video.duration = duration;
        persistAndUpdate(tabId);
      }
    }
    sendResponse({ success: true });

  } else if (message.action === 'updateSubtitleTrack') {
    // Fired by the injected page listener the moment the user turns
    // captions on/off (TextTrack mode change), so we can label the
    // transcript with a language before or after the actual subtitle
    // file request has been sniffed by webRequest.
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    const { url, track } = message;
    const list = detectedVideos[tabId];
    if (list && track) {
      const video = list.find(v => v.url === url);
      if (video) {
        const tracks = video.subtitleTracks || [];
        const idx = tracks.findIndex(t => t.language === track.language && t.label === track.label);
        if (idx !== -1) tracks[idx] = track; else tracks.push(track);
        video.subtitleTracks = tracks;
        if (video.transcriptUrl && track.mode === 'showing' && !video.transcriptLanguage) {
          video.transcriptLanguage = track.label || track.language;
        }
        persistAndUpdate(tabId);
      }
    }
    sendResponse({ success: true });

  } else if (message.action === 'clearDetectedVideos') {
    const tabId = message.tabId;
    Object.keys(downloadState).forEach((id) => {
      if (downloadState[id].tabId === tabId) {
        cancelDownload(id);
      }
    });
    detectedVideos[tabId] = [];
    streamGroups[tabId] = {};
    pendingTranscripts[tabId] = [];
    chrome.storage.local.remove(`tab_${tabId}`);
    updateBadge(tabId);
    sendResponse({ success: true });

  } else if (message.action === 'startDownload') {
    startDownload(message.tabId, message.video).then(sendResponse);
    return true; // async response

  } else if (message.action === 'startTranscriptDownload') {
    startTranscriptDownload(message.tabId, message.video).then(sendResponse);
    return true; // async response

  } else if (message.action === 'cancelDownload') {
    sendResponse(cancelDownload(message.downloadId));

  } else if (message.action === 'getActiveDownloads') {
    sendResponse({ downloads: downloadState });

  } else if (message.action === 'getNetStats') {
    loadNetPrefs().then(() => sendResponse({ usedMB: usedTodayMB(), limitMB: NET.dailyLimitMB, prefs: NET }));
    return true;

  } else if (message.action === 'resetDataUsage') {
    dataUsage = { day: todayKey(), bytes: 0 };
    chrome.storage.local.set({ dataUsage });
    sendResponse({ ok: true });
  }

  return true; // Keep message channel open for async response
});
