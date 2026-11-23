// ============================================================================
// Popup controller.
//
// All actual downloading (plain files AND HLS streams) happens in
// background.js's service worker, NOT here. That's deliberate: this popup
// document gets destroyed the instant it loses focus (user clicks anywhere
// outside it), so any download logic that lived only in here would die with
// it. The popup's job is just: show what's been detected, and reflect the
// background's download progress while it happens to be open.
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  const videoListDiv = document.getElementById('video-list');
  const countBadge = document.getElementById('detected-count');
  const clearBtn = document.getElementById('clear-list');

  // downloadId -> { index, video, kind: 'video' | 'transcript' }, so an
  // incoming progress broadcast (keyed by downloadId) knows which card and
  // which of its two possible progress bars to update.
  const downloadsByIndex = {}; // index -> { video: downloadId|null, transcript: downloadId|null }
  let currentVideos = [];

  // ---- Videos tab: selection, names, sequential batch ------------------------------------------
  const SubU = window.SubUtils;
  const selectedVideos = new Set();    // video.url
  const knownVideos = new Set();
  let videoNames = {};                 // url -> name typed by the user
  let videoPrefs = { folder: 'eJPT', prefix: true, withSubs: true };
  let renderVideosPending = false;
  const $v = (id) => document.getElementById(id);

  const GENERIC = new Set(['Detected Video', 'Video Tag', 'Video Source', 'Video Link']);
  function videoNameOf(v) {
    if (videoNames[v.url]) return videoNames[v.url];
    if (v.lectureName && !SubU.isJunkName(v.lectureName)) return v.lectureName;
    if (v.title && !GENERIC.has(v.title) && !SubU.isJunkName(v.title)) return v.title;
    return 'Video';
  }
  function updateVideoBatchButton() {
    const n = currentVideos.filter((v) => selectedVideos.has(v.url)).length;
    const b = $v('btn-vid-batch');
    b.textContent = 'Download selected (' + n + ') one after another';
    b.disabled = n === 0;
  }
  chrome.storage.local.get(['videoNames', 'videoPrefs'], (d) => {
    videoNames = d.videoNames || {};
    if (d.videoPrefs) videoPrefs = Object.assign(videoPrefs, d.videoPrefs);
    if (!videoPrefs.v15) { videoPrefs.v15 = true; if (!videoPrefs.folder || videoPrefs.folder === 'Videos') videoPrefs.folder = 'eJPT'; }
    $v('vid-subs').checked = videoPrefs.withSubs !== false;
    $v('vid-folder').value = videoPrefs.folder;
    $v('vid-prefix').checked = !!videoPrefs.prefix;
  });
  const saveVideoPrefs = () => chrome.storage.local.set({ videoPrefs, videoNames });
  $v('vid-folder').addEventListener('change', (e) => { videoPrefs.folder = e.target.value; saveVideoPrefs(); });
  $v('vid-prefix').addEventListener('change', (e) => { videoPrefs.prefix = e.target.checked; saveVideoPrefs(); });
  $v('vid-subs').addEventListener('change', (e) => { videoPrefs.withSubs = e.target.checked; saveVideoPrefs(); });
  $v('vid-sel-all').addEventListener('click', () => { currentVideos.forEach((v) => selectedVideos.add(v.url)); renderVideos(currentVideos); });
  $v('vid-sel-none').addEventListener('click', () => { selectedVideos.clear(); renderVideos(currentVideos); });
  $v('btn-vid-batch').addEventListener('click', async () => {
    const items = currentVideos.filter((v) => selectedVideos.has(v.url)).map((v) => ({ video: v, name: videoNameOf(v) }));
    if (!items.length) return;
    $v('btn-vid-batch').disabled = true;
    $v('vid-batch-status').textContent = 'Starting ' + items.length + ' downloads ...';
    const r = await chrome.runtime.sendMessage({ action: 'queueVideoDownloads', tabId, items, options: { prefix: videoPrefs.prefix, folder: (videoPrefs.folder || '').trim(), withSubs: videoPrefs.withSubs !== false } });
    updateVideoBatchButton();
    $v('vid-batch-status').textContent = r && r.ok
      ? (r.failed.length ? 'Finished: ' + r.ok + ' saved, ' + r.failed.length + ' failed (' + r.failed.map((f) => f.name + ': ' + f.error).join('; ') + ')' : 'Done — ' + r.ok + ' video' + (r.ok === 1 ? '' : 's') + ' saved to Downloads/' + (videoPrefs.folder || '').trim() + '/Lectures')
      : 'Failed: ' + ((r && r.error) || 'no response');
  });
  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.action === 'videoBatchProgress') {
      $v('vid-batch-status').textContent = m.done ? 'Finished' : 'Downloading ' + m.index + ' of ' + m.total + ': ' + m.name + (m.failed ? ' — ' + m.failed + ' failed' : '');
    }
  });
  document.addEventListener('focusout', () => { if (renderVideosPending) setTimeout(() => renderVideos(currentVideos), 0); });

  // Page-controlled strings (titles, URLs) must never be injected as raw HTML.
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function getDomainName(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace('www.', '');
    } catch (e) {
      return 'Web Page';
    }
  }

  // Turn seconds into "1:23:45" or "3:07".
  function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return null;
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  let tab;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab;
  } catch (err) {
    console.error('Error fetching active tab:', err);
  }

  if (!tab) {
    videoListDiv.innerHTML = '<div class="empty-state"><p class="empty-title">Active tab not found</p></div>';
    return;
  }

  const tabId = tab.id;

  // Clear list click handler
  clearBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'clearDetectedVideos', tabId });
    renderVideos([]);
  });

  // 1. Scrape active tab DOM for videos (fallback and live scan), including
  //    duration and any subtitle/caption tracks the page already knows about.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: scrapeVideosFromDOM,
    });

    if (results && results.length > 0) {
      const allScraped = [];
      const allTranscripts = [];
      results.forEach(res => {
        if (res.result && Array.isArray(res.result.videos)) {
          allScraped.push(...res.result.videos);
        }
        if (res.result && Array.isArray(res.result.transcripts)) {
          allTranscripts.push(...res.result.transcripts);
        }
      });

      if (allScraped.length > 0 || allTranscripts.length > 0) {
        await chrome.runtime.sendMessage({
          action: 'addScrapedVideos',
          tabId,
          videos: allScraped,
          transcripts: allTranscripts
        });
      }
    }
  } catch (err) {
    console.log('Script execution note (e.g. Chrome system pages):', err.message);
  }

  // 2. Set up a persistent listener in the page itself so that later
  //    changes -- metadata finishing load, or the user toggling captions on
  //    -- get reported too, not just what was true at the instant the
  //    popup happened to open. This runs in the page's own JS context, so
  //    it keeps working even while the popup is closed.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: installPageListeners,
    });
  } catch (err) {
    console.log('Could not install page listeners:', err.message);
  }

  // 3. Fetch combined video list from background storage and render.
  const renderFromStorage = () => new Promise((resolve) => {
    chrome.storage.local.get(`tab_${tabId}`, (data) => {
      currentVideos = (data[`tab_${tabId}`] || []).filter(v => !v.isSubtitleTrack && !v.duplicateOf);
      renderVideos(currentVideos);
      resolve();
    });
  });

  await renderFromStorage();

  // Live-update as background detects more videos/transcripts, or duration
  // and subtitle-track info arrives.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[`tab_${tabId}`]) {
      currentVideos = (changes[`tab_${tabId}`].newValue || []).filter(v => !v.isSubtitleTrack && !v.duplicateOf);
      renderVideos(currentVideos);
    }
  });

  // Progress broadcasts from the background download engine. These keep
  // arriving (and get applied here) no matter whether the download was
  // started before or after this particular popup instance opened.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action !== 'downloadProgress') return;
    applyDownloadState(message.downloadId, message.state);
  });

  // Only now (cards already rendered from the video list above) ask the
  // background what's already running, so a download that was started,
  // then the popup was closed (clicking elsewhere never pauses it), then
  // reopened, still shows live progress instead of a bare button.
  chrome.runtime.sendMessage({ action: 'getActiveDownloads' }, (response) => {
    if (!response || !response.downloads) return;
    Object.values(response.downloads).forEach((state) => {
      if (state.tabId === tabId) applyDownloadState(state.downloadId, state);
    });
  });

  function findCardBindingForUrl(url) {
    const index = currentVideos.findIndex(v => v.url === url || v.transcriptUrl === url);
    return index === -1 ? null : index;
  }

  function applyDownloadState(downloadId, state) {
    if (!state || state.tabId !== tabId) return;

    // Figure out which card/row this belongs to: prefer the index we
    // recorded when the click happened, otherwise recover it by URL (covers
    // the "restore after reopening the popup" case).
    let index = null;
    for (const idxStr of Object.keys(downloadsByIndex)) {
      const binding = downloadsByIndex[idxStr];
      if (binding.video === downloadId || binding.transcript === downloadId) {
        index = Number(idxStr);
        break;
      }
    }
    if (index === null) {
      index = findCardBindingForUrl(state.url);
      if (index === null) return;
      if (!downloadsByIndex[index]) downloadsByIndex[index] = { video: null, transcript: null };
      if (state.isTranscript) downloadsByIndex[index].transcript = downloadId;
      else downloadsByIndex[index].video = downloadId;
    }

    const suffix = state.isTranscript ? 'sub' : 'vid';
    const dlBtn = document.getElementById(`btn-dl-${suffix}-${index}`);
    const progressContainer = document.getElementById(`progress-container-${suffix}-${index}`);
    const progressStatus = document.getElementById(`progress-status-${suffix}-${index}`);
    const progressFill = document.getElementById(`progress-fill-${suffix}-${index}`);
    if (!dlBtn || !progressContainer) return;

    if (state.status === 'complete') {
      progressContainer.style.display = 'none';
      dlBtn.style.display = 'inline-flex';
      if (downloadsByIndex[index]) {
        if (state.isTranscript) downloadsByIndex[index].transcript = null;
        else downloadsByIndex[index].video = null;
      }
      return;
    }

    if (state.status === 'error' || state.status === 'cancelled') {
      progressStatus.textContent = state.statusText || (state.status === 'cancelled' ? 'Cancelled' : 'Error');
      progressStatus.style.color = state.status === 'error' ? '#f87171' : '';
      setTimeout(() => {
        progressContainer.style.display = 'none';
        dlBtn.style.display = 'inline-flex';
        progressStatus.style.color = '';
      }, state.status === 'error' ? 4000 : 800);
      if (downloadsByIndex[index]) {
        if (state.isTranscript) downloadsByIndex[index].transcript = null;
        else downloadsByIndex[index].video = null;
      }
      return;
    }

    // In progress: keep the button hidden and the bar current. This is the
    // path that runs whether the click happened in this popup instance or
    // the download was already underway from an earlier one.
    dlBtn.style.display = 'none';
    progressContainer.style.display = 'block';
    progressStatus.textContent = state.statusText || 'Downloading...';
    progressStatus.style.color = '';
    if (progressFill) progressFill.style.width = `${state.percent || 0}%`;
  }

  // Render video items list
  function renderVideos(videos) {
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('vname')) { renderVideosPending = true; return; }
    renderVideosPending = false;
    countBadge.textContent = videos.length;
    videos.forEach((v) => { if (!knownVideos.has(v.url)) { knownVideos.add(v.url); selectedVideos.add(v.url); } });
    for (const u of [...selectedVideos]) if (!videos.some((v) => v.url === u)) selectedVideos.delete(u);
    updateVideoBatchButton();

    if (videos.length === 0) {
      videoListDiv.innerHTML = `
        <div class="empty-state">
          <svg class="empty-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p class="empty-title">No downloadable videos found</p>
          <p class="empty-desc">Play a video on the page, or check if the page loaded completely.</p>
        </div>
      `;
      return;
    }

    videoListDiv.innerHTML = '';
    videos.forEach((video, index) => {
      const card = document.createElement('div');
      card.className = 'video-card';
      card.id = `card-${index}`;

      const domain = getDomainName(video.url);
      const isHls = (video.type || '').includes('HLS');
      const ext = isHls ? 'ts' : ((video.type || '').toLowerCase().includes('webm') ? 'webm' : 'mp4');
      const tagClass = isHls ? 'tag-hls' : (ext === 'mp4' ? 'tag-mp4' : 'tag-other');
      const durationLabel = formatDuration(video.duration);

      // Transcript / subtitle state for this video:
      // - already sniffed a real subtitle file  -> offer a direct download
      // - page reports a caption track but no file seen yet -> hint at it
      const hasTranscript = !!video.transcriptUrl;
      const trackList = video.subtitleTracks || [];
      const showingTrack = trackList.find(t => t.mode === 'showing');
      const transcriptLangLabel = hasTranscript
        ? (video.transcriptLanguage || 'Unknown language')
        : (showingTrack ? (showingTrack.label || showingTrack.language || 'captions') : null);

      let subtitleBlockHtml = '';
      if (hasTranscript) {
        subtitleBlockHtml = `
          <div class="card-actions" style="margin-top: 8px;">
            <button class="btn btn-secondary btn-dl-action" id="btn-dl-sub-${index}">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 5h16M4 12h10M4 19h7"></path>
              </svg>
              <span>Download subtitle (.srt)</span>
            </button>
          </div>
          <div class="download-progress-container" id="progress-container-sub-${index}">
            <div class="progress-header">
              <span class="progress-status" id="progress-status-sub-${index}">Initializing...</span>
              <button class="btn-cancel" id="btn-cancel-sub-${index}">Cancel</button>
            </div>
            <div class="progress-track">
              <div class="progress-fill" id="progress-fill-sub-${index}"></div>
            </div>
          </div>
        `;
      } else if (showingTrack) {
        subtitleBlockHtml = `
          <div class="card-info" style="margin-top: -2px; margin-bottom: 0;">
            <div class="info-item" title="Captions are on for this video, but no subtitle file has been requested by the page yet">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.25 6.75L22.5 12l-5.25 5.25M6.75 17.25L1.5 12l5.25-5.25" />
              </svg>
              <span>Captions on (${escapeHtml(transcriptLangLabel)}) — waiting for subtitle file</span>
            </div>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="card-header">
          <input type="checkbox" class="vsel" ${selectedVideos.has(video.url) ? 'checked' : ''} title="Include in batch download">
          <input type="text" class="vname" spellcheck="false" title="Click to rename. This becomes the file name." value="${escapeHtml(videoNameOf(video))}">
          <span class="tag ${tagClass}">${isHls ? 'HLS Stream' : ext}</span>
        </div>
        ${video.place && (video.place.category || video.place.section) ? `<div class="vplace" title="${escapeHtml(video.place.course || '')}">📁 ${escapeHtml([video.place.category, video.place.section].filter(Boolean).join(' › '))}</div>` : ''}
        <div class="card-info">
          <div class="info-item" title="Source domain">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            <span>${domain}</span>
          </div>
          ${durationLabel ? `
          <div class="info-item" title="Video duration">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>${durationLabel}</span>
          </div>` : ''}
          <div class="info-item" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(video.url)}">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            <span>Link URL</span>
          </div>
        </div>

        <div class="card-actions">
          <button class="btn btn-primary btn-dl-action" id="btn-dl-vid-${index}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Download Video
          </button>
        </div>

        <div class="download-progress-container" id="progress-container-vid-${index}">
          <div class="progress-header">
            <span class="progress-status" id="progress-status-vid-${index}">Initializing...</span>
            <button class="btn-cancel" id="btn-cancel-vid-${index}">Cancel</button>
          </div>
          <div class="progress-track">
            <div class="progress-fill" id="progress-fill-vid-${index}"></div>
          </div>
        </div>

        ${subtitleBlockHtml}
      `;

      videoListDiv.appendChild(card);

      const vsel = card.querySelector('.vsel');
      vsel.addEventListener('change', () => { vsel.checked ? selectedVideos.add(video.url) : selectedVideos.delete(video.url); updateVideoBatchButton(); });
      const vname = card.querySelector('.vname');
      vname.addEventListener('change', () => { videoNames[video.url] = vname.value.trim(); saveVideoPrefs(); });
      vname.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') vname.blur(); });

      // --- Video download button --------------------------------------
      const dlBtn = card.querySelector(`#btn-dl-vid-${index}`);
      const progressContainer = card.querySelector(`#progress-container-vid-${index}`);
      const cancelBtn = card.querySelector(`#btn-cancel-vid-${index}`);

      dlBtn.addEventListener('click', async () => {
        dlBtn.style.display = 'none';
        progressContainer.style.display = 'block';
        // Every download runs entirely inside the background service
        // worker from this point on, so it survives the popup closing —
        // clicking elsewhere on the page never pauses or cancels it.
        const prep = await chrome.runtime.sendMessage({ action: 'prepareVideo', video, name: videoNameOf(video), options: { prefix: videoPrefs.prefix, folder: (videoPrefs.folder || '').trim(), withSubs: videoPrefs.withSubs !== false } });
        const single = Object.assign({}, video, { customName: (prep && prep.customName) || ((SubU.sanitizeFilename(videoNameOf(video)) || 'video') + '.' + ext) });
        const response = await chrome.runtime.sendMessage({ action: 'startDownload', tabId, video: single });
        if (response && response.downloadId) {
          if (!downloadsByIndex[index]) downloadsByIndex[index] = { video: null, transcript: null };
          downloadsByIndex[index].video = response.downloadId;
        }
      });

      cancelBtn.addEventListener('click', () => {
        const binding = downloadsByIndex[index];
        if (binding && binding.video) {
          chrome.runtime.sendMessage({ action: 'cancelDownload', downloadId: binding.video });
        }
      });

      // --- Subtitle download button (only present if we have a file) ---
      if (hasTranscript) {
        const subBtn = card.querySelector(`#btn-dl-sub-${index}`);
        const subProgressContainer = card.querySelector(`#progress-container-sub-${index}`);
        const subCancelBtn = card.querySelector(`#btn-cancel-sub-${index}`);

        // Saves "<NN lecture>.srt" into the same Lectures/... folder as the video (never a .txt here;
        // plain .txt transcripts go to Transcripts/ from the Subtitles tab).
        subBtn.addEventListener('click', async () => {
          subBtn.disabled = true;
          const r = await chrome.runtime.sendMessage({ action: 'prepareVideo', video, name: videoNameOf(video), options: { prefix: videoPrefs.prefix, folder: (videoPrefs.folder || '').trim(), subsOnly: true } });
          subBtn.disabled = false;
          const label = subBtn.querySelector('span') || subBtn;
          label.textContent = r && r.srt ? 'Saved .srt next to the video' : ((r && r.error) || 'Could not save the subtitle');
        });

        subCancelBtn.addEventListener('click', () => {
          const binding = downloadsByIndex[index];
          if (binding && binding.transcript) {
            chrome.runtime.sendMessage({ action: 'cancelDownload', downloadId: binding.transcript });
          }
        });
      }
    });
  }
});

// ============================================================================
// Injected into the page (all frames) once when the popup opens.
// One-time scan: DOM <video>/<a> elements, current duration, and any
// subtitle/caption <track> or TextTrack the page already exposes.
// ============================================================================
function scrapeVideosFromDOM() {
  const videos = [];
  const transcripts = [];
  const pageTitle = document.title;

  function collectSubtitleTracks(video) {
    const tracks = [];
    try {
      const list = video.textTracks || [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t.kind === 'subtitles' || t.kind === 'captions') {
          tracks.push({ label: t.label || '', language: t.language || '', mode: t.mode || 'disabled' });
        }
      }
    } catch (e) { /* ignore */ }
    return tracks;
  }

  function collectTrackFiles(video, videoUrl) {
    try {
      const els = video.querySelectorAll('track');
      els.forEach(track => {
        if (!track.src) return;
        const kind = (track.kind || 'subtitles').toLowerCase();
        if (kind !== 'subtitles' && kind !== 'captions') return;
        const srcLower = track.src.toLowerCase().split('?')[0];
        let type = 'VTT';
        if (srcLower.endsWith('.srt')) type = 'SRT';
        transcripts.push({ url: track.src, type, videoUrl, srclang: track.srclang || '', label: track.label || '' });
      });
    } catch (e) { /* ignore */ }
  }

  const elements = document.querySelectorAll('video');
  elements.forEach(video => {
    let src = video.currentSrc || video.src;
    const duration = (typeof video.duration === 'number' && isFinite(video.duration)) ? video.duration : null;
    const subtitleTracks = collectSubtitleTracks(video);

    if (!src) {
      const sources = video.querySelectorAll('source');
      sources.forEach(source => {
        if (source.src && !source.src.startsWith('blob:') && !source.src.startsWith('data:')) {
          videos.push({
            url: source.src,
            type: source.src.toLowerCase().includes('.m3u8') ? 'HLS (m3u8)' : 'MP4',
            title: pageTitle || 'Video Source',
            duration,
            subtitleTracks
          });
          collectTrackFiles(video, source.src);
        }
      });
    } else if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
      videos.push({
        url: src,
        type: src.toLowerCase().includes('.m3u8') ? 'HLS (m3u8)' : 'MP4',
        title: pageTitle || 'Video Tag',
        duration,
        subtitleTracks
      });
      collectTrackFiles(video, src);
    }
  });

  const links = document.querySelectorAll('a');
  links.forEach(a => {
    const href = a.href;
    if (href) {
      const hrefLower = href.toLowerCase().split('?')[0];
      if (hrefLower.endsWith('.mp4') || hrefLower.endsWith('.webm') || hrefLower.endsWith('.ogg') || hrefLower.endsWith('.m3u8')) {
        let type = 'MP4';
        if (hrefLower.endsWith('.m3u8')) type = 'HLS (m3u8)';
        else if (hrefLower.endsWith('.webm')) type = 'WEBM';
        else if (hrefLower.endsWith('.ogg')) type = 'OGG';

        videos.push({
          url: href,
          type: type,
          title: a.textContent.trim().substring(0, 50) || pageTitle || 'Video Link'
        });
      }
    }
  });

  return { title: pageTitle, videos, transcripts };
}

// ============================================================================
// Injected into the page (all frames) once when the popup opens. Unlike
// scrapeVideosFromDOM this doesn't return a snapshot — it registers
// listeners that keep running in the page for as long as the page is open,
// so metadata that loads late and captions turned on/off *after* the popup
// closed still get reported to the background script.
//
// Installs a marker attribute so we don't double-attach if the popup is
// opened more than once on the same page.
// ============================================================================
function installPageListeners() {
  if (window.__blobDownloaderListenersInstalled) return;
  window.__blobDownloaderListenersInstalled = true;

  function videoUrlFor(video) {
    return video.currentSrc || video.src || null;
  }

  function reportDuration(video) {
    const url = videoUrlFor(video);
    if (!url || !isFinite(video.duration) || video.duration <= 0) return;
    try {
      chrome.runtime.sendMessage({
        action: 'updateVideoDuration',
        tabId: null, // filled in by the background using sender.tab.id
        url,
        duration: video.duration
      });
    } catch (e) { /* extension context may be gone on navigation */ }
  }

  function reportTrack(video, track) {
    const url = videoUrlFor(video);
    if (!url) return;
    try {
      chrome.runtime.sendMessage({
        action: 'updateSubtitleTrack',
        tabId: null,
        url,
        track: { label: track.label || '', language: track.language || '', mode: track.mode || 'disabled' }
      });
    } catch (e) { /* ignore */ }
  }

  function watchVideo(video) {
    if (video.__blobDownloaderWatched) return;
    video.__blobDownloaderWatched = true;

    video.addEventListener('loadedmetadata', () => reportDuration(video));
    video.addEventListener('durationchange', () => reportDuration(video));
    if (isFinite(video.duration) && video.duration > 0) reportDuration(video);

    const watchTracks = () => {
      const list = video.textTracks || [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if ((t.kind === 'subtitles' || t.kind === 'captions') && !t.__blobDownloaderWatched) {
          t.__blobDownloaderWatched = true;
          reportTrack(video, t);
          t.addEventListener('cuechange', () => {}); // no-op, kept for future use
        }
      }
    };
    watchTracks();
    if (video.textTracks) {
      video.textTracks.addEventListener('addtrack', watchTracks);
      video.textTracks.addEventListener('change', () => {
        const list = video.textTracks || [];
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          if (t.kind === 'subtitles' || t.kind === 'captions') reportTrack(video, t);
        }
      });
    }
  }

  document.querySelectorAll('video').forEach(watchVideo);

  // Catch <video> elements that get added after this ran (SPA players).
  const observer = new MutationObserver(() => {
    document.querySelectorAll('video').forEach(watchVideo);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
