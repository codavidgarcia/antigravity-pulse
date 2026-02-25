<p align="center">
  <img src="https://raw.githubusercontent.com/codavidgarcia/antigravity-pulse/main/icon.png" alt="Antigravity Pulse" width="120">
</p>

<h1 align="center">Antigravity Pulse</h1>

<p align="center">
  <strong>Real-time AI quota monitor for your status bar</strong><br>
  100% local · 120 KB · zero dependencies · zero telemetry
</p>

<p align="center">
  <a href="https://github.com/codavidgarcia/antigravity-pulse/releases/latest"><img src="https://img.shields.io/github/v/release/codavidgarcia/antigravity-pulse?style=flat-square&color=2ea043&labelColor=333" alt="Release"></a>
  <a href="https://github.com/codavidgarcia/antigravity-pulse/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square&labelColor=333" alt="MIT License"></a>
  <a href="https://github.com/codavidgarcia/antigravity-pulse/stargazers"><img src="https://img.shields.io/github/stars/codavidgarcia/antigravity-pulse?style=flat-square&color=e3b341&labelColor=333" alt="Stars"></a>
  <a href="https://open-vsx.org/extension/codavidgarcia/antigravity-pulse"><img src="https://img.shields.io/open-vsx/dt/codavidgarcia/antigravity-pulse?style=flat-square&color=e07c34&labelColor=333" alt="Open VSX Downloads"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/codavidgarcia/antigravity-pulse/main/screenshot.png" alt="Antigravity Pulse in action" width="520">
</p>

<p align="center">
  <em>Hover for a rich Markdown tooltip with per-pool progress bars, model breakdown, and reset timers.</em>
</p>

---

## Why Antigravity Pulse?

Antigravity Pro & Ultra users get quota-limited access to AI models — but there's no built-in way to monitor your remaining usage. This extension solves that with a single status bar indicator that shows exactly how much quota you have left, per pool, per model.

No browser tabs. No dashboard polling. No OAuth. Just a glance at your status bar.

## Privacy first

Everything runs **100% on your machine**. The extension reads quota data from the Antigravity process already running locally — no requests ever leave `localhost`.

- No internet requests — every call stays on `127.0.0.1`
- No Google authentication — no OAuth, no tokens stored, no login required
- No data sent to any server — your usage patterns stay private
- No special permissions — no filesystem access, no telemetry

## Lightweight

The entire extension is **120 KB** unpacked. No bundled webviews, no CSS frameworks, no localization files. Three TypeScript files compiled to plain JavaScript.

- Activates in milliseconds
- Polls every 30 seconds with a single local HTTPS POST (~1ms round trip)
- Zero dependencies beyond the VS Code API

## Clear at a glance

Each model pool gets a **color-coded health indicator** directly in the status bar:

| Icon | Status | Remaining |
|---|---|---|
| 🟢 | Healthy | > 50% |
| 🟡 | Low | 20% – 50% |
| 🔴 | Critical | < 20% |

## Per-pool quota tracking

Antigravity groups AI models into **independent quota pools**, each resetting every ~5 hours:

| Label | Pool | Includes |
|---|---|---|
| **Gemini** | Gemini 3.x | Gemini 3 Pro (High), Gemini 3 Pro (Low), Gemini 3 Flash |
| **Claude** | Claude / GPT | Claude Sonnet 4.5, Claude Opus 4.5, GPT-OSS 120B |
| **Gemini 2.5** | Gemini 2.5 | Gemini 2.5 Flash |

Each pool's quota is tracked independently — exhausting Claude/GPT does not affect your Gemini quota.

## Hover tooltip

Hover over the status bar item for a detailed, formatted breakdown:

- Per-pool remaining percentage with visual progress bars
- Time until reset for each pool
- Individual model quotas when models within a pool differ
- Clean Markdown formatting, no popup windows

## How it works

1. **Process detection** — scans for the Antigravity `language_server` process
2. **Token extraction** — reads the CSRF token from the process arguments
3. **Port discovery** — finds the correct local API port
4. **Local API call** — `POST https://127.0.0.1:{port}/.../GetUserStatus` — strictly local
5. **Display** — groups models by pool, updates the status bar every 30 seconds

## Install

**Install from [Open VSX](https://open-vsx.org/extension/codavidgarcia/antigravity-pulse)** — search for **Antigravity Pulse** in your Extensions panel and click Install. You'll get automatic updates with every new release.

<details>
<summary>Manual install (no auto-updates)</summary>

1. Download the `.vsix` from [Releases](https://github.com/codavidgarcia/antigravity-pulse/releases/latest)
2. `Cmd+Shift+P` → **Extensions: Install from VSIX...**
3. Select the file and reload

</details>

## Configuration

| Setting | Default | Description |
|---|---|---|
| `antigravityPulse.pollingInterval` | `30` | Refresh interval in seconds (min: 30) |
| `antigravityPulse.clockFormat` | `auto` | Clock format for reset times: `auto` (OS locale), `12h`, or `24h` |

## Requirements

- Antigravity IDE must be running (the extension reads from its local process)
- Pro or Ultra subscription for meaningful quota tracking

## Contributing

This is an open-source project and contributions are welcome. If you find a bug, have a feature request, or want to submit a PR, head to the [GitHub repo](https://github.com/codavidgarcia/antigravity-pulse).

If Antigravity Pulse saves you time, consider giving it a ⭐ — it helps others find it.

## License

[MIT](https://github.com/codavidgarcia/antigravity-pulse/blob/main/LICENSE)
