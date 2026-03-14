# Changelog

All notable changes to Antigravity Pulse will be documented in this file to keep the project transparent and open-source.

## [1.5.0] - 2026-03-14

### Added
- **Click-to-options menu** — clicking the status bar now opens a quick-pick menu with all extension controls in one place: refresh quota, toggle display mode, clock format, reset time, smart polling, and a shortcut to open Pulse settings
- Each menu item shows its **current value** and previews the next state (e.g. `Display: full → compact`)
- Refresh Quota option shows the timestamp of the last successful refresh

### Changed
- Status bar click behavior changed from "refresh" to "open options menu" — refresh is now the first item in the menu
- Hover tooltip footer updated from "Click to refresh" to "Click for options" across all states (loading, error, no data, active)
- Removed redundant `showInformationMessage` notifications from individual toggle commands — feedback is now visual through the menu and status bar

## [1.4.3] - 2026-03-04

### Added
- Compact display mode for narrow windows — abbreviated pool names and simplified reset times in the status bar
- New setting `antigravityPulse.displayMode` (`full` / `compact`)
- New command **Cycle Display Mode** (`Cmd+Shift+P` / `Ctrl+Shift+P`) to switch between full and compact

### Compact mode details
- Pool names are shortened: Gemini → Gem, Claude → Cla, All Models → All
- When both Gemini Pro and Flash coexist, the redundant "Gem" prefix is dropped: Pro, Flash
- Reset times are simplified to the major unit: `2h 15m` → `[2h]`, `1d 3h` → `[1d]`

## [1.4.2] - 2026-02-28

### Fixed
- Progress bar in tooltip renders at double height on Windows — the `░` glyph inflated the line box inside code spans; bar now rendered as plain text to avoid monospace font metrics

### Changed
- Extension categories moved from "Other" to "Machine Learning" + "Visualization" for better marketplace placement
- Added search keywords (`antigravity`, `quota`, `ai`, `codeium`, `windsurf`) for marketplace discoverability
- Added gallery banner with dark theme for branded marketplace page

## [1.4.0] - 2026-02-27

### Added
- Smart polling — polling pauses entirely when the Antigravity window is not focused and resumes with an immediate refresh when you return, reducing unnecessary CPU and battery usage
- New command **Toggle Smart Polling** (`Cmd+Shift+P` / `Ctrl+Shift+P`) and setting `antigravityPulse.smartPolling` to enable/disable it

### Changed
- README install instructions now recommend searching `Antigravity Pulse @sort:name` for easier discovery

## [1.3.9] - 2026-02-26

### Fixed
- Pool label "All Models" now only appears when all models genuinely share the same pool. When quotas diverge (e.g. Gemini Pro exhausted while Flash/Claude remain), each pool gets a specific name like "Gem Flash & Claude" instead of "All Models"
- Progress bar no longer wraps to a second line on narrow tooltips (reduced from 20 to 15 characters), preventing the "double-height bar" visual glitch on Windows

## [1.3.8] - 2026-02-26

### Added
- Optional reset countdown in the status bar — see time until quota resets at a glance: `🟢 Gemini 80% [2h 15m] | 🟡 Claude 40% [45m]`
- New setting `antigravityPulse.showResetTime` to enable/disable the countdown
- New command **Toggle Reset Countdown in Status Bar** (`Cmd+Shift+P` / `Ctrl+Shift+P`)

### Fixed
- Status bar now shows "All Models 100%" instead of "all 100%" when all models share the same pool

## [1.3.7] - 2026-02-25

### Fixed
- Pool label now shows "All Models" when all quotas share the same reset time, instead of only showing "Gemini"
- README corrections and improvements

## [1.3.6] - 2026-02-25

### Added
- Clock format setting (`antigravityPulse.clockFormat`) — choose between `auto` (OS locale), `12h`, or `24h` for reset times in the tooltip

### Fixed
- HTTP/HTTPS fallback for API communication (contributed by [@saifulabidin](https://github.com/saifulabidin) in PR #3)
- Enhanced Linux process port detection via `ss` output parsing

### Changed
- README overhaul with badges, improved install instructions, and full configuration reference

## [1.3.5] - 2026-02-24

### Fixed
- Quota data could be read from the wrong workspace's language server when multiple windows were open, causing stale or incorrect values
- Reset time now shows days when more than 24 hours away (e.g. `1d 12h` instead of `36h 0m`)
- Tooltip includes the date when reset is more than a day away (e.g. `Feb 26, 6:44 PM`)

### Added
- CHANGELOG.md for transparency with users
- CI/CD workflow: pushing a version tag now auto-builds, creates a GitHub Release, and publishes to Open VSX

### Changed
- Default polling interval reduced from 120s to 30s for fresher quota data

## [1.3.4] - 2026-02-23

### Added
- Dynamic quota pool detection based on real-time data
- Reset time displayed in status bar tooltip

## [1.3.2]

### Added
- Visual confirmation on manual refresh

## [1.0.0]

### Added
- Initial release
- Real-time quota monitoring for Antigravity models
- Status bar integration with color indicators
- Support for macOS, Linux, and Windows
