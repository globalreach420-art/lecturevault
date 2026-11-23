# 6 · Risks & safe use

[← Back to README](../README.md)

LectureVault automates things you could do by hand. Pushing it hard has consequences in four areas. Read this once, and again before long Autopilot runs.

---

## 1. Your course account

- Course platforms usually forbid downloading their videos and automated access in their **terms of use**. Using this tool, especially Autopilot and video downloads, can break those terms.
- Platforms log what every account does: which lectures were opened, when, for how long, and which streams were downloaded. **Unusual patterns stand out** — a whole learning path in one night, every night, at the same rhythm, with every video downloaded.
- Possible results range from nothing, to a CAPTCHA / warning, to a suspended account. A suspended account can mean losing access to paid courses, labs and **exam vouchers** tied to it.

### INE's own daily limit (it really happens)
After about **100 lectures in one day** with Autopilot, INE showed:

> *"The user has watched the maximum number of minutes. Please wait 24 hours or contact the support team."*

That means INE counts **minutes watched per account per day**. Once you hit it you can't watch anything — not even normally — for 24 hours, and the account is now visibly "heavy" in their logs. LectureVault detects this message, stops Autopilot at once and blocks *Start* for 24 hours. **Don't contact support about it and don't try to work around it — just wait.**

> ### 🛑 Daily rule — read this every time
> - **Never download more than 30–40 videos in one day.**
> - **After 30–40 videos, take a full day off** (alternate days is best) — **or at least a 10–14 hour gap** before the next run.
> - Easy way to follow it: set **Stop after** to about **2 h** and/or **Max lectures/day** to **30**, and don't start again the same day.
> - If INE ever shows *"The user has watched the maximum number of minutes. Please wait 24 hours or contact the support team"* — you already went too far. Autopilot stops by itself; **wait the full 24 hours** and do less next time.

**Keep the risk low:**

| Do | Avoid |
|---|---|
| 1–2 courses per Autopilot run | A whole path in one night |
| **≤ 30–40 videos per day**, *Stop after* ≈ 2 h | 100 lectures in one day (→ INE 24-hour block) |
| A day off after a 30–40 video day (or ≥ 10–14 h gap) | Starting again right after a big run |
| Leave days off between runs | Running every night |
| Change *Watch %*, waits and start time between runs | Identical settings and start time every time |
| Mix in normal, manual studying | Only ever using automation |
| Download videos only when you need them offline | Downloading every video "just in case" |
| Stop and solve any CAPTCHA/warning yourself, then pause for a while | Trying to bypass a CAPTCHA or warning |

> No setting makes automation undetectable. **Less automation = less risk.** Around important dates (e.g. an exam on the same account), keep usage light.

## 2. Mobile data (e.g. 4G, ~2 GB/day)

| Activity | Rough data use |
|---|---|
| Transcripts | almost nothing (KB per lecture) |
| Autopilot watching, player at lowest quality | small–moderate per lecture |
| Video downloads at 360p | ≈ 0.5–1 MB per minute of lecture |
| Video downloads at 720p | ≈ 2–5 MB per minute |
| Video downloads at 1080p | ≈ 5–10 MB per minute |

*(Estimates; real bitrates vary. Check "Used today" after one video.)*

- **Autopilot ignores the daily data limit** — with videos on, it can use your entire day's plan overnight. When the plan runs out, the internet stops and nothing more downloads.
- Watching + downloading the same lecture ≈ paying for it twice. For a transcripts-only night, untick *Auto-download videos*.
- Slower speed ≠ less data. Only **lower quality** and **fewer videos** reduce data.

## 3. Your laptop (8 GB RAM, integrated graphics)

| Setting | Effect |
|---|---|
| Parallel 1, *By video length* | light — recommended |
| Parallel 4–5 or Full speed | browser and system can lag, fans loud |
| Overnight runs | keep it plugged in, on a hard surface, lid open or external cooling |
| Many tabs/VMs open while running | Chrome may slow or pause the course tab — close other heavy apps |

## 4. Files & sharing

- Downloaded lectures and transcripts are for **your own study**. Don't upload, sell or share them.
- Keep this repository **private** (see the GitHub guide). It never contains course material or account data — `.gitignore` blocks saved web pages, archives and media files.
- Never commit saved course web pages (`*.mhtml`, `*_files/`): they contain your account name.

## Scenario table — "what happens if I…"

| If you… | Likely result |
|---|---|
| Run Autopilot on a whole path every night with the same settings | Very regular, heavy pattern in the platform's logs → highest account risk |
| Use Auto-capture over many courses back to back | Many 12-second plays in a row → looks automated |
| Turn on videos at 1080p on 4G overnight | Daily plan gone in hours; internet stops for the rest of the day |
| Set Daily limit 0 and Full speed for normal downloads | No brake on data at all |
| Leave Parallel at 5 on the 8 GB laptop | Lag, possible browser slowdowns or crashes |
| See a CAPTCHA and keep the run going | The run gets stuck; the platform has already flagged the activity |
| Let Autopilot run ~100 lectures in one day | INE: "watched the maximum number of minutes — wait 24 hours" → blocked for a day |
| Restart right after the 24-hour block and do another 100 | Repeated limit hits on the same account → much higher risk |
| Use defaults, 1–2 courses, *Stop after* 2 h, ≤ 30–40 videos/day, days off, mix in manual study | Lowest practical risk |

---

<sub>This page is general guidance, not legal advice. When in doubt, use less automation.</sub>
