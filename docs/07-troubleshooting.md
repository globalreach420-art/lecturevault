# 7 · Troubleshooting

[← Back to README](../README.md)

---

## First checks (fix most problems)

1. `chrome://extensions` → LectureVault shows the expected **version** and no red **Errors** button.
2. Clicked **⟳ reload** after any code change?
3. **Refreshed (F5)** the course tab after reloading the extension?
4. The lecture actually **played** (captions only load when a video starts)?

## Problems & fixes

| Problem | Cause | Fix |
|---|---|---|
| Nothing appears in Subtitles tab | Lecture never played, or captions not English | Play a few seconds; check *English only*; open **Diagnostics** in the Subtitles tab |
| Wrong lecture/section name | Page layout differs | Subtitles tab → **Names & folders** → pick the right source or click the right text on the page |
| Files saved with random names (`773adeee-…`) | Old versions 1.12.0–1.12.1 | Update to ≥ 1.12.2 (fixed) |
| Video saved as `.txt` | Old version ≤ 1.12.3, slowed MP4/WEBM | Update to ≥ 1.12.4 (fixed) |
| Lists empty after reload | Very old versions | Fixed since 1.12.0 — lists stay until **Clear** |
| Ticks come back after closing popup | Old versions | Fixed since 1.11.1 |
| "Daily data limit reached" | You hit the limit (Videos tab) | Wait for midnight, raise the limit, or **Reset** |
| Downloads very slow | Speed mode doing its job | Move the slider to *Half/Quarter time*, or Fixed limit higher |
| Laptop lags | Parallel > 1 or Full speed | Parallel 1, *By video length* |
| Autopilot follows the trailer | Version ≤ 1.12.2 | Update (fixed in 1.12.3) |
| Autopilot: "No transcript was captured" | Captions didn't load during the run | Play that lecture by hand once, download from the Subtitles tab |
| Autopilot: stuck on the path page | Course tiles not loaded | Open the path, scroll to the bottom, **Resume** |
| Autopilot: "logged out" | Session expired | Log in again in the same Chrome — it continues |
| Autopilot stopped overnight | Laptop slept / Chrome minimized / tab hidden | Sleep = Never, Chrome not minimized, course tab in front |
| A CAPTCHA appears | The site's bot check | **Stop**, solve it yourself, pause automation for a while |

## Where to look

- **Autopilot → Activity log** — what happened, minute by minute.
- **Subtitles tab → Diagnostics** — what the page and player look like to the extension; **Copy** to share.
- `chrome://extensions` → **Errors** / **service worker** link — technical errors from the background script.
- `chrome://downloads` — what Chrome actually saved and where.
