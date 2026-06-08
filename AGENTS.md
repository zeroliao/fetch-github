# Project Instructions

## Project Overview

- 项目用户界面和面向用户的文档尽量使用中文；代码标识、API 字段、命令和技术术语保留英文。
- `fetchGithub` is planned as a GitHub repository discovery, analysis, recommendation, and knowledge-sync system.
- The project should discover useful GitHub repositories through scheduled/manual scans, configurable preferences, GitHub context, embeddings, third-party LLM analysis, scoring, and user feedback.
- This repository is currently unimplemented. Do not assume a framework, package manager, database, task runner, or test command until real project files define them.
- Keep `fetchGithub` as the source of truth for discovery data, scoring, snapshots, feedback, and sync state.
- Treat sibling project `../ai-knowledge-base` as an optional derived knowledge index only. Do not share databases or make it a hard runtime dependency without explicit user approval.

## Commands

| Task | Command |
|------|---------|
| List files | `rg --files` |
| Dev server | `pnpm dev` |
| Build | `pnpm build` |
| Typecheck | `pnpm typecheck` |
| Worker dev | `pnpm worker:dev` |
| Worker start | `pnpm worker:start` |
| Start database | `docker compose up -d postgres` |
| Apply database schema | `pnpm db:init` |
| Local setup | `pnpm setup:local` |
| Tests | Not defined yet |
| Lint | Not defined yet |

When package, build, or test configuration is added, update this table with commands verified from repository files.

## Planned Architecture

- `Scheduler`: scan cycles, cron/start time, missed-run policy, job queueing.
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
- Prefer storage and longer runtime over reducing discovery or analysis capability.
- Do not store plaintext GitHub tokens, LLM API keys, cookies, private keys, or full sensitive HTTP headers.
- Private repository content must not be sent to third-party AI providers unless an explicit project setting enables it.

## AI Provider Rules

- Configure chat/LLM providers and embedding providers separately.
- API keys should be referenced by environment variable name, not stored in database records or logs.
- Project matching should combine deterministic filters, rule scoring, embeddings, LLM structured judgment, and user feedback. Do not make the LLM the only ranking authority.
- Version prompts and scoring logic with fields such as `prompt_version` and `score_version`.

## UI Expectations

- Build a working discovery dashboard, not a marketing landing page.
- Main MVP pages: `Recommendations`, `Repo Detail Drawer`, `Profiles`, `Scan Jobs`, `My GitHub`, `AI Providers`, and optional `Knowledge Sync`.
- Repository names and GitHub action buttons must open the repository `html_url` in a new tab with `rel="noopener noreferrer"`.
- Prefer dense, tool-focused tables for recommendation lists; use drawers or panels for detailed summaries and reasons.

## Verification

- For documentation-only edits, run `git diff --check`.
- After code exists, run the most targeted available tests first.
- For changes touching shared logic, scan jobs, scoring, AI providers, persistence, or user workflows, run broader validation once commands exist.
- If validation commands are unavailable, state that clearly in the final response and do not claim tests passed.
