# Changelog

[← Back to README](../README.md)

Newest at the bottom. Versions before 1.4 were the original generic "Blob Video Downloader" (detect and download HLS/MP4/WEBM streams from any page).

## 📝 Subtitles tab (v1.4)

Captures lecture subtitles/transcripts while you play videos, labels each one with its language, and lets you
download them one by one or in a batch.

* **Capture:** play each lecture for 5–10 seconds with captions (CC) on. WebVTT, SRT, TTML and HLS subtitle
  playlists (`#EXT-X-MEDIA:TYPE=SUBTITLES`) are detected. The text is cached immediately, so expiring signed URLs don't matter.
* **Languages:** read from the stream manifest / the player's caption tracks, else guessed from the file name, else from the text
  itself (a `~` after the language means it was guessed). Use the language filter to show only English.
* **Names:** each row's name comes from the highlighted item in the page's lecture list (fallback: page heading / title). Click a name to edit it.
* **Download:** per row (TXT = clean text for notes, VTT/SRT = original) or *Download selected*. Options: clean text / original / both,
  numbered files, one combined `.txt` per language, section subfolders. Files go to `Downloads/<folder>/`.
* **Library is global:** it survives page navigation and tab switches until you press *Clear*.
* **Diagnostics:** lists caption-looking requests the browser saw, in case a site uses something unusual.

New files: `subtitle-utils.js` (parsing, language detection, HLS helpers), `subs-library.js` (background capture + download), `subs.js` (tab UI).

## v1.5 – Subtitles & batch downloads
- **English only** (default): other languages are not captured or shown; "Delete them" removes ones already saved.
- **No duplicates**: the same subtitle seen twice (different signed URLs) is stored once.
- **Automatic names**: taken from the player's published title, the highlighted lesson, headings, etc. Junk like "1080p" / "Auto" is ignored. If a site is wrong, open *Lecture names*, pick the right source, or click **Pick title on page** once.
- **Batch download** in list order (▲▼ to reorder), numbered `01_`, `02_`..., optionally in section subfolders, or as one **.zip**.
- **Videos tab**: tick videos, rename, and download them one after another (sequential queue). No ZIP for videos (large files).

## v1.5.1
- English only is strict: "Language unknown" items are hidden and no longer captured.
- Player thumbnail tracks (VTT files full of image links) are ignored and removed from old lists.
- Names: "Video: ine-videos/..." labels, quality options, URLs and ids are never used. Titles are shortened to about 60 characters; section names to about 40.
- Course structure: section and lecture numbers are read from the course sidebar. Files are saved as
  `eJPT/01 Assessment Methodologies/03 Port Scanning with Nmap.txt`. "Sort" puts the list in course order.

## v1.6 – INE course structure
Reads the INE course page: Course › Category (e.g. "Windows") › Section card (e.g. "Windows Credential Dumping") › the open lecture (the row with the **Close** button).
```
Downloads/eJPT/
  Lectures/<Course>/01 Windows/02 Windows Credential Dumping/01 Windows Password Hashes.mp4  (+ .srt with the same name)
  Transcripts/<Course>/01 Windows/02 Windows Credential Dumping/01 Windows Password Hashes.txt
  Transcripts/<Course>/00 All transcripts.txt   (optional)
```
Quizzes are not counted in lecture numbers. "Names & folders" shows what was detected; **Pick** fixes any line once per site.

## v1.7
- Rows are found by their action button (Restart video / Start quiz / Start lab / Close), so labs and quizzes are never taken as section names, and player text ("Volume 100%", "1x") is ignored.
- Numbers always come from INE's page order, so gaps stay gaps (download only lecture 05 and it is still "05").
- The category order of each course is remembered once seen.

## v1.8
- Videos tab works like the Subtitles tab: every lecture you play is kept (also after page changes), grouped Course › Category › Section and always sorted in course order, whatever order you played them in.
- "Download all videos" saves them one after another in course order, each with its .srt; "Stop after this video" ends a running batch.
- Subtitles tab: "Download all transcripts" saves every transcript as .txt in course order.
- Category detection uses INE's "Activities: N" card marker, so a neighbouring card is never taken as the category.

## v1.9 – built from the full eJPT path recording
- Folder tree: `eJPT/{Lectures|Transcripts}/NN Path section/NN Course/NN Category/NN Card/NN Lecture`
  (path sections and course order of the "Penetration Testing Student" path are built in).
- The course trailer at the top of every course page is ignored (videos and captions): only the lecture whose row shows **Close** is captured, and its stream length must match the row ("16m 27s").
- Cards are found by their "Show details / Hide details" link, so collapsed cards and the sticky category header no longer shift numbers.
- Reloading the page, opening another course, or closing the tab empties that tab's lists.

## v1.10.0 — auto-capture a whole page
- New **"Auto-capture lectures on this page"** button (above the tabs). It expands every collapsed card, opens each lecture's video in turn, tries to press play on it, lets it play for a set number of seconds (default 12, adjustable), closes it, and moves to the next — until every lecture on the page has been opened once.
- This does **not** skip playback: it still has to briefly play each video so the player actually requests its caption/stream files, the same way it does when you press play by hand. It just does the clicking and waiting for you instead of you doing it.
- Two things worth knowing before running it over a whole course:
  - Opening + playing every lecture also marks each one "watched" in INE's own progress tracker.
  - It uses more bandwidth than normal, since every lecture buffers briefly, even the ones you don't end up wanting.
- "Stop" ends it after the lecture currently in progress. Already-open lectures are closed first before the next one starts, so it won't stack multiple players.
- Not verified against the real INE site (no logged-in access during development) — tested against a local mock page only. If a page doesn't advance after clicking start, use the normal manual play-each-lecture flow and report it.

## v1.10.1 — paced more like a human
Downloading a transcript file itself isn't unusual — your browser already requests captions as part of normal playback, with or without this extension. What *could* look different from normal usage is many lectures opening back to back at a perfectly even interval. So this version slows the pacing down on purpose:
- Minimum/default "seconds per lecture" raised from 4/8 to 8/12.
- The gap between closing one lecture and opening the next is now a randomized 1.5–4s instead of a fixed 700ms, so requests don't land at a robotic, exact cadence.
- Every 6th lecture, it takes a longer pause (15–28s) before continuing, like a short break.
- A run stops itself after 20 lectures ("Paused after N lecture(s) — click Start again to continue"), so a full course doesn't get opened in one unbroken sitting. Clicking Start again picks up where it left off (already-opened lectures are skipped).
None of this is a guarantee INE has no detection at all — it's just closer to how a person actually clicks through a course than the fastest possible setting.

## v1.11.0 — Data & speed saver

Videos tab → **Data & speed saver** panel. Settings apply to every video download (single or batch) and take effect immediately.

| Setting | Default | What it does |
|---|---|---|
| Video quality | 720p | Picks the stream quality. **The only setting that uses less data.** 360p uses roughly a third of 720p. |
| Speed: By video length | on (Like watching) | Slider with 6 steps: Very slow (1×, 5-min video ≈ 5 min), Like watching (0.8×), A bit faster (0.6×), Half time (0.5×, 5-min ≈ 2½ min), One-third time, Quarter time. One piece at a time, so it stays light on the laptop. |
| Speed: Fixed limit | 250 KB/s | Hard cap on total speed for all downloads together. |
| Speed: Full speed | – | Old behaviour (fast, heavy). |
| Parallel | 1 | Pieces fetched at once (1–5). 1 = least CPU/RAM. Ignored in "Like watching". |
| Wait | 60 s | Rest between videos in a batch. |
| Daily limit | 1500 MB | No new video starts after this much data today (0 = off). A video already downloading is allowed to finish. |

Notes:
- Slowing down spreads data use over time; it does not reduce the size of a video.
- "Used today" counts video data downloaded through the extension, not your whole phone/hotspot usage.
- Plain MP4 files are slowed the same way; if a site blocks the extension's own request, that file falls back to a normal (unlimited) download and the status says so.

## v1.11.1
- Fixed: unticked lectures/subtitles no longer get ticked again when the popup reopens. New items still start ticked.
- Added: speed slider for "By video length" with plain labels (e.g. Half time: 5-min video ≈ 2½ min), and an MB/min hint next to the KB/s limit.

## v1.12.0 — Autopilot (overnight, whole learning path)
New **Autopilot** tab.
1. Open an INE learning path page, scroll to the bottom once, press **Scan this learning path**. Every item is listed by section; courses not yet 100% complete on INE are ticked.
2. Press **Start / Resume**. For each ticked course it goes back to the path page, clicks the course, then opens every video lecture in order (expanding collapsed sections), watches **35–60%** of it (short lectures closer to 60%, 20-min+ lectures closer to 35%), closes it and moves on. After the last lecture it moves to the next course.
3. After each lecture, new transcripts are downloaded automatically (Subtitles-tab folder/format settings). Optional: videos too.
- Progress is saved after every lecture. Stop / Resume, a closed popup, or Chrome restarting the background all continue from the same course and lecture. A 1-minute watchdog restarts a run if Chrome stops the background.
- Player is muted and set to its lowest quality (settings).
- Random 5–12 s gaps between lectures, a 1–2.5 min break every 5–8 lectures, 2–5 min between courses.
- Overnight: plugged in, Windows sleep = Never, INE tab in front, Chrome not minimized. Screen may turn off.

Also fixed: captured subtitles/videos were wiped when the tab navigated (e.g. clicking a file download link). They now stay until you press Clear.

## v1.12.1
- Autopilot downloads each lecture's **video automatically** (on by default). Videos download in the background, one at a time, while the next lecture plays; quality and speed come from the Data & speed saver panel.
- Autopilot **ignores the daily data limit** and never stops on its own: if INE logs out it retries every 5 minutes, if the INE tab is closed it opens a new one, courses with problems are retried later. Only the Stop button ends a run. (The daily limit still applies to downloads you start yourself.)

## v1.12.2
- Removed the .ipynb notebook feature.
- Fixed: videos/transcripts were saved with random ID names (e.g. `773adeee-...`) in v1.12.0-1.12.1. Names and folders are correct again.

## v1.12.3
- Fixed: autopilot followed the course-header trailer video instead of the open lecture. It now uses only the player inside the lecture list and pauses/mutes the trailer.

## v1.12.4
- Fixed: autopilot could skip transcripts/videos it wrongly believed were downloaded (list carried over from earlier runs/versions). It now downloads everything captured since the queue started that is not yet downloaded in this queue.
- Fixed: slowed-down MP4/WEBM videos were saved as .txt.
- Activity log reports per lecture: "Transcript saved", "Video queued/saved", or a warning when nothing was captured.
- Progress bars: current lecture, learning path, and the video downloading in the background (%, queue size).

## v1.12.5
- Renamed to **LectureVault** with a new icon (amber lecture page with a play button and a download badge). Everything else is unchanged; your saved lists and settings stay.

## v1.12.6
- Fixed: the green "running" dot on the Autopilot tab showed even when Autopilot was idle.
- Added the documentation set (README + docs/ guides with diagrams and screenshots) and a .gitignore that keeps saved web pages, media and archives out of the repository.

## v1.13.0
- **New: "Stop after" slider** on the Autopilot tab — Off · 30 min · 1 h · 1½ h · 2 h · 3 h · 4 h · 6 h · 8 h. Counted from Start / Resume; the current lecture finishes first. Shows the time left while running.
- **New: optional "Max lectures/day"** (default **0 = off**) with a "Today: N lectures" counter that resets at midnight.
- **New:** Autopilot detects INE's *"watched the maximum number of minutes… wait 24 hours"* message, stops immediately and refuses to start again for 24 hours.
- Autopilot's normal behaviour (watch %, downloads, recovery) is unchanged.
- Docs: daily rule — no more than 30–40 videos a day, then a day off or at least a 10–14 hour gap.
