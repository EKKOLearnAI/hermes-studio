# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2025-04-29

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

### Changed

- **Default compression trigger**: Group chat rooms now default to 100,000 tokens (was 10,000)
- **Database location**: In WSL, database always uses `~/.hermes-web-ui/` to avoid cross-filesystem issues

### Technical Details

#### Database Tables
- `sessions`: Added `profile` field
- `session_usage`: Added `profile` field and `id` PRIMARY KEY
- `gc_pending_session_deletes`: Tracks profile-specific session cleanup
- `gc_session_profiles`: Maps ephemeral sessions to profiles and rooms

#### Code Organization
- Created `packages/server/src/db/hermes/init.ts`: Unified store initialization
- Updated `packages/server/src/db/index.ts`: WSL detection and improved SQLite settings
- Refactored `packages/server/src/services/hermes/context-engine/`: Better token estimation

---

## [0.4.x] - Previous Releases

### Features
- Real-time streaming chat via SSE
- Multi-session management
- Platform channel integration (Telegram, Discord, Slack, WhatsApp)
- Usage statistics and cost tracking
- Scheduled jobs management
- Skills browsing and memory management
- Integrated terminal with node-pty

### Technical Stack
- **Frontend**: Vue 3, Naive UI, Pinia, SCSS
- **Backend**: Koa 2, @koa/router, node-pty
- **Database**: SQLite (node:sqlite)
- **Language**: TypeScript (strict mode)
