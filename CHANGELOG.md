# Changelog

All notable changes to this project will be documented in this file.

## 0.0.2

- Switched the panel to search-first rendering instead of scanning on open.
- Improved Windows native port lookup with structured PowerShell commands.
- Refined environment switching and exact port filtering behavior.

## 0.0.1

- Initial release of `Port Inspector`.
- Added status bar entry and main editor panel.
- Added Windows, Linux, and WSL environment detection.
- Added manual environment override in the panel.
- Added fallback TCP listener probing when native commands are unavailable.
- Added process termination flow with confirmation.