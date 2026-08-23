# Project Instructions

## Rule Inheritance

- Global Codex rules apply automatically.
- This file contains project-specific facts and constraints only.
- Project rules may add detail but must not weaken global safety, authorization, or verification requirements.

## Project Overview

- 面向用户的界面和文档默认使用中文。
- `fetchGithub` is a Next.js + TypeScript GitHub discovery, analysis, recommendation, and knowledge-sync application.
- The web/API layer and Node.js worker share PostgreSQL + pgvector persistence, with a JSON-file fallback for local degraded operation.
- The system discovers repositories through continuous scheduled/manual scans, configurable preferences, GitHub context, embeddings, third-party LLM analysis, scoring, and user feedback.
- Keep `fetchGithub` as the source of truth for discovery data, scoring, snapshots, feedback, and sync state.
- Treat sibling project `../ai-knowledge-base` as an optional derived knowledge index only. Do not share databases or make it a hard runtime dependency without explicit user approval.

## Commands

| Task                  | Command                                                            |
| --------------------- | ------------------------------------------------------------------ |
| List files            | `rg --files`                                                       |
| Dev server            | `pnpm dev`                                                         |
| Build                 | `pnpm build`                                                       |
| Typecheck             | `pnpm typecheck`                                                   |
| Worker dev            | `pnpm worker:dev`                                                  |
| Worker start          | `pnpm worker:start`                                                |
| Start database        | `docker compose up -d postgres`                                    |
| Apply database schema | `pnpm db:init`                                                     |
| Local setup           | `pnpm setup:local`                                                 |
| Tests                 | `pnpm test`                                                        |
| Cloudflare Access SSH | `.\\scripts\\invoke-cloudflare-ssh.ps1 -RemoteCommand "<command>"` |
| Lint                  | Not defined yet                                                    |

When package, build, or test configuration is added, update this table with commands verified from repository files.

## Project Layout

- `src/app/`: Next.js pages and authenticated API routes.
- `src/components/`: dashboard UI.
- `src/server/`: scheduler, scan worker stages, provider policy, persistence, scoring, and integrations.
- `src/worker/`: continuous worker process.
- `db/schema.sql`: idempotent PostgreSQL schema and migrations.
- `tests/`: Node test runner tests executed through `tsx`.
- `docs/`: product, technical, setup, audit, and release documentation.

## Architecture

- `Scheduler`: fixed internal wake-up cycles, missed-run policy, and one active job per profile.
- `GitHubCollector`: GitHub Search/API collection, repository metadata, README, topics, snapshots.
- `ResourceGovernor`: adaptive low-memory execution using small batches, checkpointing, persisted queues, and dynamic throttling.
- `ScoringEngine`: hard filters, rule scoring, growth/freshness/quality scoring, final ranking.
- `EmbeddingEngine`: separately configured embedding provider for semantic similarity and GitHub-context matching.
- `LLMAnalyzer`: separately configured chat/LLM provider for summaries, classification, risks, match judgment, reranking, and recommendation reasons.
- `PreferenceLearner`: updates profile signals from save/hide/like/dislike feedback.
- `KnowledgeBaseConnector`: optional sync of high-value L4 results to `../ai-knowledge-base` or FastGPT.

## Data And Storage Rules

- Use layered persistence:
  - `L0 Seen`: minimal record for every scanned repository for deduplication and scan history.
  - `L1 Candidate`: basic metadata for repositories that pass hard filters.
  - `L2 Profiled`: detailed metadata, README, releases, issue/activity data for selected candidates.
  - `L3 Analyzed`: structured AI analysis, summaries, risks, match scores.
  - `L4 Recommended/Saved/Tracked`: long-term recommendations, feedback, snapshots, and optional knowledge-base sync.
- Do not keep full candidate pools in memory. Stream, batch, persist, and resume from checkpoints.
- Use canonical GitHub repository URLs for processing deduplication. `processed` and `skipped` are terminal; `failed` and `exception` remain retryable.
- Prefer storage and longer runtime over reducing discovery or analysis capability.
- Do not store plaintext GitHub tokens, LLM API keys, cookies, private keys, or full sensitive HTTP headers.
- Private repository content must not be sent to third-party AI providers unless an explicit project setting enables it.

## AI Provider Rules

- Configure chat/LLM providers and embedding providers separately.
- Select enabled providers by `priority ASC`; discovery profiles must not bind concrete provider IDs.
- Parsing/schema failures rotate a provider after the configured internal threshold. Auth, permission, invalid configuration, rate limits, network, timeout, and 5xx failures follow their own availability policies and do not increment parsing-failure counts.
- Persistent unavailable states must expose a sanitized reason and recovery suggestion and require a successful detection before returning to `available`.
- API keys should be referenced by environment variable name, not stored in database records or logs.
- Project matching should combine deterministic filters, rule scoring, embeddings, LLM structured judgment, and user feedback. Do not make the LLM the only ranking authority.
- Version prompts and scoring logic with fields such as `prompt_version` and `score_version`.

## UI Expectations

- Build a working discovery dashboard, not a marketing landing page.
- Main MVP pages: `Recommendations`, `Repo Detail Drawer`, `Profiles`, `My GitHub`, `AI Providers`, `System Operations` (including scan-cycle recovery and history), and optional `Knowledge Sync`.
- Repository names and GitHub action buttons must open the repository `html_url` in a new tab with `rel="noopener noreferrer"`.
- Prefer dense, tool-focused tables for recommendation lists; use drawers or panels for detailed summaries and reasons.

## Project Documentation

- 发布和文档收尾遵循全局规则；项目具体步骤见 `docs/version-management.md`。
- 产品需求：`docs/prd.md`
- MVP 规格：`docs/mvp-spec.md`
- 技术设计：`docs/technical-design.md`
- 本地设置：`docs/local-setup.md`
- 功能收尾审计：`docs/feature-closure-audit.md`
- 单版本证据：`docs/releases/<version>.md`
