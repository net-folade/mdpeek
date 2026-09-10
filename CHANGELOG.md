# Changelog

All notable changes to mdpeek are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-10

### Added

- Reader test coverage: unit tests for rendering, sidebar and app wiring, plus a
  Playwright UI spec (#4).
- Continuous integration on macOS running the unit tests, the WebKit UI tests,
  `cargo test` and a debug Tauri build (#4).

### Fixed

- Sidebar navigation and document layout in the reader (#3).

## [0.1.0] - 2026-08-12

### Added

- Initial release: a lightweight Markdown reader built on Tauri, with
  frontmatter, local image and link rendering, syntax highlighting, KaTeX math
  and Mermaid diagrams.

[1.0.0]: https://github.com/net-folade/mdpeek/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/net-folade/mdpeek/releases/tag/v0.1.0
