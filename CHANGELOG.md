# Changelog

All notable changes to Antigravity Pulse will be documented in this file to keep the project transparent and open-source.

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
