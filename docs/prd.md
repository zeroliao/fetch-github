# Product Requirements Document

## Summary

`fetchGithub` is a GitHub repository discovery, analysis, recommendation, and knowledge-sync system. It helps the user continuously find useful GitHub projects through scheduled or manual scans, personalized preferences, GitHub account context, embedding similarity, third-party LLM analysis, and feedback learning.

The system must support large first scans without exhausting memory. It may trade time and storage for lower memory usage, but must not reduce discovery or analysis capability.

## Goals

- Discover useful GitHub repositories from high-star projects, popular topics, recent activity, and fast-growing projects.
- Support configurable scan profiles with preferences, schedules, start times, candidate limits, and resource policies.
- Associate recommendations with the user's own GitHub repositories and starred repositories.
- Use third-party AI API services for semantic understanding, structured analysis, and recommendation explanations.
- Configure chat/LLM models and embedding models separately.
- Persist enough data to support deduplication, trend tracking, reranking, feedback learning, and job recovery.
- Provide a practical dashboard where repository names and actions can open the GitHub repository URL.
- Optionally sync high-value results to `../ai-knowledge-base` or FastGPT as a derived knowledge index.

## Non-Goals

- Do not use `../ai-knowledge-base` as the source of truth for discovery, scoring, or scan jobs.
- Do not make FastGPT or `../ai-knowledge-base` a required runtime dependency for the MVP.
- Do not clone repositories by default.
- Do not run local LLM or local embedding models as a required capability.
- Do not send private repository content to third-party AI services unless explicitly enabled.
- Do not store plaintext GitHub tokens, LLM API keys, cookies, or private keys.

## Users

- Primary user: an individual developer who wants personalized GitHub project discovery.
- Secondary user: an AI coding assistant or automation agent that needs a stable project context and recommendation history.

## Core Workflows

### 1. Configure A Discovery Profile

The user creates a profile with:

- Name and enabled status.
- Scan schedule, timezone, start time, and max runtime.
- GitHub query preferences: keywords, topics, languages, minimum stars, updated/pushed recency, excluded keywords.
- Discovery sources: GitHub Search preference queries, GitHub Topics, high-star search, recent-activity search, and optional authority signals such as GitHub Trending, GitHub Explore, OSS Insight, GH Archive, OpenSSF Scorecard, and ecosyste.ms.
- Candidate limits: source query limit, max candidates, rule-filter top K, detail-fetch top K, LLM/embedding top K, final report top K.
- Resource policy: complete low-memory mode, batch size, concurrency, memory thresholds.
- AI providers: one chat provider and one embedding provider.

### 2. Scan GitHub Projects

The system can scan:

- Manually through a "Scan now" action.
- On a configured schedule.
- As a first scan with checkpointed batch processing.
- As an incremental scheduled scan after baseline snapshots exist.
- From enabled discovery sources. Implemented source adapters use GitHub Search API queries; planned adapters may use GitHub Trending/Explore, OSS Insight, GH Archive, OpenSSF Scorecard, and ecosyste.ms as authority or quality signals.

First scans may discover many repositories. The system must stream and persist candidates rather than keeping all candidates in memory.

### 3. Analyze And Rank Projects

The system ranks candidates through:

- Hard filters.
- Rule scoring.
- GitHub context matching.
- Embedding similarity.
- LLM structured analysis.
- User feedback scoring.

The LLM is not the only ranking authority.

### 4. Review Recommendations

The user can:

- View recommended repositories in a dense dashboard table.
- Click a repository name or GitHub action button to open the GitHub repository in a new tab.
- Open a detail drawer showing summary, reasons, risks, matching preferences, and related user repositories.
- Save, hide, like, dislike, or track a repository.

### 5. Learn From Feedback

The system records user actions and updates preference signals over time:

- Positive signals from `save`, `like`, and `track`.
- Negative signals from `hide` and `dislike`.
- Optional LLM-assisted extraction of preference patterns from feedback.

### 6. Optional Knowledge Sync

For high-value repositories, the system can generate Markdown knowledge documents and sync them to `../ai-knowledge-base` or FastGPT.

Only L4 high-value repositories should sync by default:

- Saved repositories.
- Tracked repositories.
- Top recommendations selected by configuration.

## Matching And Scoring

Final ranking should combine deterministic and AI-assisted signals:

```text
final_score =
  rule_score * 0.30 +
  github_context_fit * 0.25 +
  llm_match_score * 0.30 +
  feedback_score * 0.15
```

The scoring weights must be configurable by profile and versioned with `score_version`.

## Data Persistence Requirements

Use layered persistence:

```text
L0 Seen:
Minimal record for every scanned repository.

L1 Candidate:
Basic metadata for repositories that pass hard filters.

L2 Profiled:
Detailed metadata, README, languages, release and activity data.

L3 Analyzed:
AI summaries, categories, risks, match scores, structured reasons.

L4 Recommended/Saved/Tracked:
Long-term recommendations, feedback, snapshots, and optional knowledge sync state.
```

## Resource Requirements

The system must support a complete low-memory mode:

- No full in-memory candidate pool.
- DB-backed queues.
- Small batches.
- Checkpoint and resume.
- Dynamic throttling based on available memory.
- README chunking for LLM analysis.
- Persisted intermediate results.

Target resource envelope for personal deployment:

```text
Common memory: 150 MB - 400 MB
First scan peak memory: 300 MB - 800 MB
Suggested disk: 50 GB+
```

## UI Requirements

MVP pages:

- `Recommendations`
- `Repo Detail Drawer`
- `Profiles`
- `Scan Jobs`
- `My GitHub`
- `AI Providers`
- `Knowledge Sync` optional

GitHub repository links must use:

```tsx
<a href={repo.htmlUrl} target="_blank" rel="noopener noreferrer">
  {repo.fullName}
</a>
```

## Acceptance Criteria

- A profile can be created with scan preferences, schedule, limits, and resource policy.
- A manual scan can collect GitHub repositories and persist layered records.
- A first scan can pause and resume without losing progress.
- Repository recommendations include score, summary, reasons, risks, and GitHub URL.
- Clicking a repository name or action opens the GitHub repository URL in a new tab.
- Chat provider and embedding provider are configured separately.
- User feedback affects future recommendations.
- Private repository content is not sent to third-party AI providers by default.
- High-value repositories can be optionally synced to a knowledge base without making the knowledge base the source of truth.
