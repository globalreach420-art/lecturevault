# 9 · Keeping this project on GitHub (private)

[← Back to README](../README.md)

This repo is **private**. Only you can see it. These are the exact steps used to put it on GitHub, plus the commands for updating it later.

---

## One-time setup

### 1. GitHub account
1. Sign up at **github.com** (free).
2. **Settings → Password and authentication → Enable two-factor authentication** (use an authenticator app).
3. **Settings → Emails →** tick **Keep my email addresses private** and **Block command line pushes that expose my email**. Copy the address shown there, like `12345678+yourname@users.noreply.github.com`.

### 2. Install Git (Windows)
PowerShell:
```powershell
winget install --id Git.Git -e
```
(or download from git-scm.com). Close and reopen PowerShell, then check: `git --version`

### 3. Tell Git who you are — with the private email
```powershell
git config --global user.name  "yourname"
git config --global user.email "12345678+yourname@users.noreply.github.com"
```
Every commit stores this name and email. The noreply address keeps your real email out of the history.

### 4. Create the empty private repository on GitHub
1. github.com → **+** (top-right) → **New repository**.
2. **Repository name:** `lecturevault`
3. Select **🔒 Private**.
4. **Do not** tick "Add a README", ".gitignore" or "license" — this folder already has them.
5. **Create repository**.

### 5. Upload this folder (first time)
```powershell
cd "C:\Users\antau\ejpt-subtitle-extension v9.4"
git init
git add .
git status
```
**Stop and read the `git status` list.** It should show only code, icons, `README.md`, `.gitignore` and `docs/`. It must **not** show any `.mhtml`, `_files` folders, `.zip`, videos or transcripts. If it does, don't continue — fix `.gitignore` first.

```powershell
git commit -m "LectureVault v1.13.0 with documentation"
git branch -M main
git remote add origin https://github.com/yourname/lecturevault.git
git push -u origin main
```
A browser window asks you to sign in to GitHub the first time — that's normal.

### 6. Check it
Open `github.com/yourname/lecturevault`:
- a **Private** label next to the name,
- the README with the logo, diagrams and screenshots.

---

## Every time you change something

```powershell
cd "C:\Users\antau\ejpt-subtitle-extension v9.4"
git status                      # what changed?
git add .
git commit -m "Short description, e.g. v1.13.1: fix X"
git push
```
Also bump `"version"` in `manifest.json` and add a line to `docs/CHANGELOG.md`.

## Getting it onto another PC

```powershell
git clone https://github.com/yourname/lecturevault.git
```
Then `chrome://extensions` → **Load unpacked** → that folder.

## Rules for this repo

| ✅ Do | ❌ Don't |
|---|---|
| Keep it **Private** | Switch it to Public (see [Risks & safe use](06-risks-and-safe-use.md)) |
| Check `git status` before every commit | `git add` saved web pages, downloads or zips |
| Use the noreply email | Commit with your real email |
| Keep the folder at the same path | Rename/move the folder (Chrome treats it as a new extension) |

> If you ever commit something private by mistake **and haven't pushed yet**: `git reset --soft HEAD~1` undoes the last commit and keeps your files. If it was already pushed, removing it from history needs extra steps — ask for help before doing anything else.
