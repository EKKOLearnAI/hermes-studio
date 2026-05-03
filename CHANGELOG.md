# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.7] - 2026-05-03

### Changed

#### Session Sync
- **Optimized context compression**: Improved compression algorithm for better token estimation and reduced overhead
- **Enhanced session synchronization**: More reliable session state synchronization between Hermes and local database
- **Reduced sync latency**: Faster session data fetching and state updates

### Fixed

#### Database
- **Resource race conditions**: Added startup delays to prevent database connection race conditions (#398)
  - Fixes intermittent "database is locked" errors on startup
  - Improves connection stability under high concurrency
  - Better handling of SQLite WAL mode initialization

#### Performance
- **Connection handling**: Enhanced database connection management for improved reliability
- **State management**: Improved session state consistency across concurrent operations

---

## [0.5.6] - 2026-04-27

### Added

#### Chat Features
- **ContentBlock attachments**: Redesigned attachment system with structured ContentBlock format
- **File downloads**: Added support for downloading uploaded files through the web UI
- **Voice playback**: Integrated text-to-speech with auto-play and visual feedback effects
- **Skills enhancements**:
  - Usage statistics tracking for skills
  - Source filtering for skill queries
  - Archived skills support
  - Skill provenance tracking
  - Pin/unlock toggle for skills
- **Usage analytics**: Expanded daily statistics with detailed token breakdown per model/provider

#### Database
- **Schema synchronization**: Complete rewrite of database schema synchronization with automatic recovery
- **Sidebar improvements**: Added collapse toggle for compact icon-rail mode

#### Providers
- **Xiaomi Token Plan**: Added support for Xiaomi's Token Plan provider
- **CLIProxyAPI**: Added CLIProxyAPI provider support

### Fixed

#### Chat
- **Session history scope**: Clarified and fixed session history visibility
- **LLM JSON parser**: Added robust JSON parser for improved Group Chat schema handling

---

## [0.5.5] - 2026-04-25

### Added

#### History Page
- **Session browser**: New page for browsing and searching Hermes sessions
  - Filter sessions by date, model, provider
  - Full-text search across session content
  - View detailed session information and message history
  - Pagination and infinite scroll support

---

## [0.5.4] - 2026-04-23

### Fixed

#### WebSocket & Concurrency
- **Session event isolation**: Refactored WebSocket event handling to prevent interference between concurrent sessions
- **Cron job payloads**: Fixed malformed cron job edit payloads
- **Terminal access**: Fixed Docker startup issue blocking hermes CLI usage in web terminal
- **Workspace i18n**: Fixed internationalization for workspace dialog in concurrent sessions

#### Database & Usage
- **Session usage alignment**: Aligned usage analytics with Hermes state.db schema
- **Code block copy**: Added feedback notification when copying code blocks

---

## [0.5.3] - 2026-04-22

### Fixed

#### Migration
- **Legacy session_usage**: Recovered and fixed migration for legacy session_usage data

### Added

#### Cron Jobs
- **Run history panel**: Added panel to display cron job execution history
- **Job model display**: Show model configuration for each cron job

#### Chat Format
- **Anthropic format conversion**: Added support for Anthropic message format in chat runs

---

## [0.5.2] - 2026-04-20

### Fixed

#### Authentication
- **EventSource authorization**: Use Authorization header instead of query token for SSE connections (#318)
  - Improves security by avoiding token exposure in URLs
  - Fixes issues with proxies that strip query parameters

#### Database & Schema
- **Missing column handling**: Added type guard for `estimated_cost_usd` to prevent NOT NULL errors
- **Legacy migration**: Fixed handling of missing `estimated_cost_usd` column in old Hermes state.db

#### Configuration
- **Profile names**: Normalize profile names to lowercase before sending to hermes-agent
- **Model list layout**: Improved display of model list in ProviderCard

#### Profile Management
- **Credential cleanup**: Smart cleanup of exclusive platform credentials on profile clone (#283)

#### Code Blocks
- **Overflow handling**: Fixed code block overflow in cron task messages (#291)

#### Session Management
- **Tool call reconstruction**: Reconstruct `tool_call_id` from conversation context to fix #298 (#309)

### Refactored

#### Database
- **Unified schema management**: Unified SQLite table schema management and initialization (#310)

---

## [0.5.0] - 2026-04-18

### Added

#### Multi-Profile Support
- **Profile-based usage tracking**: Added `profile` field to `session_usage` table for filtering statistics by profile
- **Profile-aware session management**: All sessions now track their originating profile (default, hermes, custom)
- **Group chat agent profiles**: Each agent can run with its own Hermes profile configuration
- **Cross-profile usage aggregation**: Usage stats page correctly filters by active profile

#### Group Chat Enhancements
- **Context compression with multi-profile**: Group chat compression now uses agent's own profile
- **Usage tracking for compression**: Token usage from context compression runs is recorded with room ID
- **Session profile mapping**: New `gc_session_profiles` table tracks ephemeral session to profile relationships

#### Single Chat Improvements
- **Ephemeral session cleanup**: Automatic deletion of temporary Hermes sessions after sync
- **User message persistence**: User messages are now properly saved to local database
- **Usage synchronization**: Token usage from Hermes sessions correctly syncs to local usage store

### Fixed

#### Token Estimation
- **Fixed overestimation**: Removed `senderName` from token calculation to avoid inflated estimates
- **Configurable estimation**: Token estimation now uses `charsPerToken` config instead of hardcoded value
- **Adjusted compression trigger**: Increased `charsPerToken` from 4 to 6 for more conservative estimation
  - This prevents premature compression triggering in group chats
  - Better matches actual LLM tokenization (~6-8 chars/token for English)

#### WSL Compatibility
- **Auto-detect WSL environment**: Database path automatically uses WSL local filesystem when detected
- **Improved SQLite settings**: Changed to WAL mode with `synchronous=NORMAL` and `busy_timeout=5000`
  - Fixes cross-filesystem write failures in WSL2 environments
  - Better concurrency and reliability

#### Database Schema
- **Unified table initialization**: Created `initAllStores()` for consistent table creation across all stores
- **Session usage schema**: Added `id` PRIMARY KEY AUTOINCREMENT for better query performance
- **Production environment**: Set `NODE_ENV=production` in production start scripts for correct database path

#### Logging
- **Enhanced error logging**: Improved error messages in `syncFromHermes` with detailed context
- **Database path logging**: Added explicit logging of Hermes state.db path for debugging

---

## [0.4.9] - 2026-04-17

### Fixed

#### Search & Queries
- **N+1 query optimization**: Optimized database queries to eliminate N+1 problems
- **CJK search support**: Fixed 500 error when searching sessions with non-CJK input
- **Session lineage projection**: Hardened compressed session lineage projection

#### Authentication
- **Login validation**: Use Hermes session endpoint for login token validation

#### Security
- **Mermaid rendering**: Secure rendering of Mermaid code fences to prevent XSS

#### Session Display
- **Lineage visibility**: Fixed chat session lineage visibility issues

#### Markdown
- **Nested fence truncation**: Fixed rendering truncation for nested markdown code fences

---

## [0.4.6] - 2026-04-12

### Added

- Restore `fetchAvailableModels` to fix provider lost as custom (#194)

---

## [0.4.5] - 2026-04-11

### Fixed

- Group chat mobile UX and UI polish (#188)

---

## [0.4.3] - 2026-04-09

### Added

- Add v0.4.3 changelog entries

---

## [0.4.2] - 2026-04-08

### Added

- Bump version to 0.4.2-beta.1 and improve chat UX (#122)

---

## [0.4.1] - 2026-04-06

### Fixed

- Auth bypass, SPA serving, and provider improvements (#97)

---

## [0.3.8] - 2026-03-XX

### Added

- Release v0.3.8

---

## [0.3.7] - 2026-03-XX

### Added

- Release v0.3.7

---

## [0.3.6] - 2026-03-XX

### Added

- Release v0.3.6

---

## [0.3.5] - 2026-03-XX

### Added

- Release v0.3.5

---

## [0.3.4] - 2026-03-XX

### Added

- Release v0.3.4

---

## [0.3.2] - 2026-03-XX

### Added

- Release v0.3.2

---

## [0.3.1] - 2026-03-XX

### Added

- Release v0.3.1

---

## [0.3.0] - 2026-03-XX

### Added

- Release v0.3.0

---

## [0.2.9] - 2026-XX-XX

### Added

- Release v0.2.9

---

## [0.2.7] - 2026-XX-XX

### Added

- Release v0.2.7

---

## [0.2.5] - 2026-XX-XX

### Added

- Release v0.2.5

---

## [0.2.2] - 2026-XX-XX

### Added

- Release v0.2.2

---

## [0.2.0] - 2026-XX-XX

### Added

- Release v0.2.0

---

## [0.2.0-beta.1] - 2026-XX-XX

### Added

- Release v0.2.0-beta.1

---

## [0.1.9] - 2026-XX-XX

### Added

- Release v0.1.9

---

## [0.1.7] - 2026-XX-XX

### Added

- Release v0.1.7

---

## [0.1.6] - 2026-XX-XX

### Added

- Release v0.1.6

---

## [0.1.5] - 2026-XX-XX

### Added

- Release v0.1.5

---

## [0.1.4] - 2026-XX-XX

### Added

- Release v0.1.4

---

[Unreleased]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.5.7...HEAD
[0.5.7]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.5.0...v0.5.2
[0.5.0]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.4.6...v0.4.9
[0.4.6]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.4.3...v0.4.5
[0.4.3]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.3.8...v0.4.1
[0.3.8]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.3.2...v0.3.4
[0.3.2]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.2.9...v0.3.0
[0.2.9]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.2.7...v0.2.9
[0.2.7]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.2.5...v0.2.7
[0.2.5]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.2.2...v0.2.5
[0.2.2]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.2.0-beta.1...v0.2.0
[0.2.0-beta.1]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.1.9...v0.2.0-beta.1
[0.1.9]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.1.7...v0.1.9
[0.1.7]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/EKKOLearnAI/hermes-web-ui/compare/v0.1.4...v0.1.5
