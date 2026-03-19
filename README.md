# qC Blocker Extension

A Manifest V3 Chrome extension that blocks websites you manually configure during focus hours. All blocking is **user-configured only** — no hardcoded domain lists, no AI, no surprises.

---

## Features

### Focus Windows
- Define time windows (e.g. 9am–5pm) when blocking is active
- Pick which days of the week each window applies (Mon–Fri, weekends, etc.)
- Add specific domains to block per window — only those domains trigger the overlay
- Empty domain list = window is inactive (nothing blocked automatically)
- Multiple windows supported — e.g. morning block + afternoon block with different sites

### Binge Guard
- Set a time limit per domain (e.g. 20 min in a 1hr rolling window)
- 10-minute buffer always reserved — 1hr window = max 50min blockable
- Runs independently of focus windows — silent timer with bottom-left indicator
- When limit is hit → hard block, no warnings, no escape
- If a domain is in both a focus window block list AND binge guard → full escalation applies

### Intervention Modes
- **Hard Block** — jumps straight to full-page lock, no warnings
- **Escalating** (default) — stage 1 warning → 20s → stage 2 warning → 20s → stage 3 hard lock

### Strict Blocking
- Toggle on dashboard (always visible) or in Binge Guard settings
- While a site is blocked: existing rules cannot be edited or deleted
- Changes are queued and applied automatically when the block expires
- Adding new rules is always allowed

### Path-level Whitelist
- Whitelist entire domains (`reddit.com`) or specific paths (`reddit.com/r/MachineLearning`)
- Path whitelist bypasses both focus windows and binge guard
- Prefix-matched — whitelisting `/r/programming` also covers all posts inside it

### Persistent Escalation Blocks
- Stage-3 blocks survive page refreshes and tab reopens
- Block expires when the active focus window ends
- Clicking "Leave This Website" clears the block immediately

### Quick Block from Popup
- Open the popup on any site to see a "Block This Site" section
- Two options: add to **Binge Guard** (with time limit) or add to a **Focus Window**
- Inline form with the same dropdowns as the settings page
- Saves and re-classifies the current page immediately — no refresh needed

### Themes
5 built-in themes applied across overlays, popup, and settings (live preview):
- Dark Amber (default)
- Midnight Blue
- Forest
- Crimson
- Slate

### Dashboard
- 4 stat cards: interventions, distracted minutes, sites exited, strict blocking toggle
- Focus score + day streak
- Today's donut chart (exited vs continued breakdown)
- 30-day sparkline with hover tooltips
- Weekly SVG bar chart with per-day tooltips
- Focus windows summary with day pills
- Binge guard radial arc progress per domain

---

## Project Structure

```
qc-blocker/
├── manifest.json              # MV3 config — permissions, scripts, icons
├── background/
│   └── worker.js              # Service worker — all blocking logic, storage, alarms
├── content/
│   ├── content.js             # Injected into every page — overlays, binge indicator
│   └── overlay.css            # In-page UI styles with CSS variable theming
├── popup/
│   ├── popup.html             # Toolbar popup
│   ├── popup.js               # Status, stats, focus windows, quick-block form
│   └── popup.css              # Popup styles
├── options/
│   ├── options.html           # Full settings page (7 sections with how-to guides)
│   ├── options.js             # All settings logic — charts, rules, whitelist, theme
│   └── options.css            # Settings styles
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## How Blocking Works

```
User visits a page
  └─► content.js sends CLASSIFY_PAGE to worker.js
        ├─ Path whitelisted?              → allow (stage 0)
        ├─ Domain whitelisted?            → allow (stage 0)
        ├─ Binge limit hit?               → hard block (stage 3)
        ├─ Escalation block active?       → hard block (stage 3, persisted)
        ├─ No active focus window?        → allow (stage 0)
        ├─ Domain in window's block list?
        │     No  → allow (stage 0), binge timer still runs if rule exists
        │     Yes → start intervention
        └─► Intervention mode:
              Hard Block   → stage 3 immediately
              Escalating   → stage 1 → [Continue] → 20s → stage 2 → [Continue] → 20s → stage 3
                                                                         └─► setEscalationBlock()

Binge heartbeat (every 1s while on a tracked domain):
  content.js → BINGE_HEARTBEAT → worker records 1s usage (flushes to storage every 5s)
  → getBingeStatus checks in-memory + stored usage
  → if blocked → push stage 3 to content.js immediately

Quick-block from popup:
  popup.js saves rule → chrome.tabs.sendMessage(RECHECK)
  → content.js clears overlay + re-runs classifyCurrentPage() after 100ms

Alarm tick (every 60s):
  → apply pending binge rule changes (strict mode, when block expires)
  → apply pending focus window changes (strict mode, when window ends)
  → clean up expired escalation blocks
```

---

## Storage Schema

| Key | Type | Description |
|-----|------|-------------|
| `focusWindows` | array | `[{id, enabled, label, start, end, days[], blockedDomains[]}]` |
| `interventionMode` | string | `"hard"` or `"both"` (escalating) |
| `whitelist` | string[] | Always-allowed hostnames |
| `pathWhitelist` | array | `[{pattern, label}]` — path-level exemptions |
| `bingeRules` | array | `[{id, enabled, domain, limitSecs, windowHours}]` |
| `bingeUsage` | object | `{domain: [{ts, secs}]}` — rolling timestamped usage log |
| `strictBlocking` | bool | Lock rules while a block is active |
| `pendingBingeRules` | object | `{domain: {action, rule}}` — queued strict-mode changes |
| `pendingFocusWindowChanges` | object | `{windowId: {action, window}}` — queued strict-mode changes |
| `escalationBlocks` | object | `{domain: expiresAt}` — persisted stage-3 blocks |
| `theme` | string | `"default"` / `"midnight"` / `"forest"` / `"crimson"` / `"slate"` |
| `stats` | object | `{"YYYY-MM-DD": {distractingMinutes, interventions, exited}}` |

---

## Tech Stack

- Vanilla JS — no frameworks, no build step
- Chrome Extensions API (Manifest V3)
  - `chrome.storage.local` — all settings and stats
  - `chrome.alarms` — minute tick for pending changes + block expiry cleanup
  - `chrome.notifications` — binge warning at 80% threshold
  - `chrome.tabs` — tab lifecycle + popup→content messaging
- Web Audio API — alert sounds (gated behind user gesture)
- Pure SVG — all charts (bar, sparkline, donut, radial arcs), no libraries

---

## Installation

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select this folder

---

## Configuration

### Block a site during focus hours
1. Settings → Focus Windows → Add Window
2. Set time range and days
3. In "Block these sites" enter the domain, e.g. `reddit.com`

### Limit time on a site (Binge Guard)
1. Settings → Binge Guard → Add Rule
2. Enter domain, set "Block after" (e.g. 20 min 0 sec), set rolling window (e.g. 1 hr)

### Quick-add from popup
1. Open the popup while on any site
2. Click "⏱ Binge Guard" or "🪟 Focus Window"
3. Configure and save — takes effect immediately on the current page

### Allow a specific page on a blocked site
1. Settings → Whitelist → type `reddit.com/r/MachineLearning` → Add
2. That path is now exempt from all blocking

### Change theme
Settings → Theme → click any theme to preview live → Save Theme
