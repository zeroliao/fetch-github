# MVP Spec

## MVP Objective

Build the first usable version of `fetchGithub` that can scan GitHub repositories, rank useful projects, explain recommendations with AI, collect feedback, and open GitHub repository URLs from the UI.

The MVP should be independent from `../ai-knowledge-base`. Knowledge sync can be implemented as an optional feature after core recommendation flows work.

## Recommended Implementation Stack

```text
Next.js + TypeScript
PostgreSQL + pgvector
Node.js worker
Docker Compose
OpenAI-compatible chat API
OpenAI-compatible embedding API
```

If implementation chooses a different stack, update `AGENTS.md`, this document, and the technical design before building major modules.

## MVP Features

### F1. Profile Management

User can create and edit discovery profiles.

Required fields:

- `name`
- `enabled`
- `schedule`
- `limits`
- `preferences`
- `resource_policy`
- `chat_provider_id`
- `embedding_provider_id`

Acceptance:

- Profile config persists.
- Disabled profiles do not run scheduled scans.
- Limits include initial candidates, rule top K, detail top K, LLM top K, final report top K.

### F2. AI Provider Management

User can configure chat and embedding providers separately.

Required fields:

- `name`
- `kind`: `chat` or `embedding`
- `base_url`
- `api_key_env`
- `model`
- `dimensions` for embeddings
- `rate_limit`
- `timeout`
- `enabled`

Acceptance:

- Chat provider cannot be selected as an embedding provider.
- Embedding provider cannot be selected as a chat provider.
- API key value is not stored, only `api_key_env`.
- Test connection action verifies provider availability without printing secrets.

### F3. GitHub Collection

System can manually run a scan for one profile.

Acceptance:

- Generates GitHub search queries from profile preferences.
- Persists L0 seen records for scanned repositories.
- Persists L1 candidate records for repositories passing hard filters.
- Stores checkpoints for pagination progress.
- Can resume an interrupted scan.

### F4. Low-Memory Queue Processing

System uses DB-backed queue stages.

Acceptance:

- No full candidate list is required in memory.
- Worker fetches small batches from `candidate_queue`.
- Job can enter `throttled`, `paused_by_memory`, and resume states.
- Resource events are recorded.

### F5. Scoring And Recommendations

System calculates scores and produces recommendations.

Acceptance:

- Calculates rule score from deterministic signals.
- Calculates final score using rule/context/LLM/feedback components.
- Stores `score_version`.
- Recommendations are sorted by final score.
- Final report respects `final_report_top_k`.

### F6. README And AI Analysis

System analyzes selected repositories with third-party AI APIs.

Acceptance:

- README content is fetched only for selected detailed candidates.
- Long README content is chunked.
- Embedding vectors are stored with model, dimensions, and content hash.
- LLM output is structured JSON.
- Stores `prompt_version`.
- Reuses cached AI results when content hash, model, and prompt version match.

### F7. Recommendations UI

User can review recommendations.

Acceptance:

- Table displays repository name, score, stars, language, updated time, matched reasons, and actions.
- Clicking repository name opens `html_url` in a new tab.
- An `Open GitHub` action opens `html_url` in a new tab.
- Detail drawer shows summary, reasons, risks, and related user repositories.

### F8. Feedback

User can mark recommendations.

Actions:

- `save`
- `hide`
- `like`
- `dislike`
- `track`

Acceptance:

- Feedback persists.
- Feedback updates recommendation status.
- Future scoring includes feedback score.

### F9. My GitHub Context

User can connect or configure GitHub context.

MVP scope:

- Sync public owned repositories.
- Sync starred repositories if token permissions allow it.
- Select which repositories participate in recommendation context.

Acceptance:

- User repositories are stored with language, topics, description, and optional README summary.
- Candidate recommendations can show related user repositories.

### F10. Optional Knowledge Sync

After core MVP, high-value repositories can sync to `../ai-knowledge-base` or FastGPT.

Acceptance:

- Only L4 repositories sync by default.
- Sync status is stored in `knowledge_syncs`.
- Content hash prevents duplicate sync.
- Sync failure does not affect discovery or scoring.

## Profile Config Shape

```yaml
name: AI Dev Tools
enabled: true
schedule:
  type: cron
  cron: "0 9 * * *"
  timezone: Asia/Shanghai
  start_at: "2026-06-08 09:00:00"
  max_runtime_minutes: 120
  missed_run_policy: skip
limits:
  source_limit_per_query: 100
  max_candidates: 5000
  rule_filter_top_k: 1000
  detail_fetch_top_k: 300
  embedding_top_k: 1000
  llm_analyze_top_k: 100
  final_report_top_k: 30
preferences:
  keywords: ["agent", "llm", "rag", "workflow"]
  topics: ["ai", "developer-tools", "automation"]
  languages:
    TypeScript: 1.2
    Python: 1.1
  exclude_keywords: ["crypto", "gambling"]
  min_stars: 100
  pushed_within_days: 180
  exclude_archived: true
  exclude_forks: true
sources:
  - id: github_search_preferences
    enabled: true
    weight: 1.0
  - id: github_topics
    enabled: true
    weight: 1.08
  - id: github_search_stars
    enabled: true
    weight: 1.04
  - id: github_search_recent_growth
    enabled: true
    weight: 1.12
  - id: github_trending
    enabled: false
    weight: 1.15
  - id: github_explore
    enabled: false
    weight: 1.1
  - id: ossinsight_trending
    enabled: false
    weight: 1.12
  - id: gharchive_velocity
    enabled: false
    weight: 1.14
  - id: openssf_scorecard
    enabled: true
    weight: 0.98
  - id: ecosystems_usage
    enabled: true
    weight: 1.02
resource_policy:
  mode: complete_low_memory
  memory:
    target_available_mb: 1024
    min_available_mb: 512
    critical_available_mb: 256
  execution:
    batch_size: 10
    max_concurrency: 1
    checkpoint_every_items: 10
    pause_on_pressure: true
ai:
  chat_provider_id: default_chat
  embedding_provider_id: default_embedding
```

## Key API Contracts

These routes are illustrative and should be adapted to the chosen framework conventions.

```text
GET    /api/profiles
POST   /api/profiles
GET    /api/profiles/:id
PUT    /api/profiles/:id

GET    /api/ai-providers
POST   /api/ai-providers
POST   /api/ai-providers/:id/test

POST   /api/scans
GET    /api/scans/:id
POST   /api/scans/:id/pause
POST   /api/scans/:id/resume

GET    /api/recommendations
GET    /api/repositories/:id
POST   /api/repositories/:id/feedback

GET    /api/github-context/repos
POST   /api/github-context/sync
PUT    /api/github-context/repos/:id

GET    /api/knowledge-syncs
POST   /api/knowledge-syncs/run
```

## UI Screens

### Recommendations

- Profile selector.
- Scan now button.
- Current job/resource status.
- Filter controls.
- Recommendation table.
- GitHub external link.
- Feedback actions.

### Repo Detail Drawer

- Summary.
- Core features.
- Risks.
- Recommendation reason.
- Related user repositories.
- GitHub metadata.
- Open GitHub action.

### Profiles

- Basic settings.
- Schedule.
- Limits.
- Preferences.
- Resource policy.
- AI provider selection.

### Scan Jobs

- Job table.
- Stage progress.
- Checkpoints.
- Memory/resource events.
- Retry and failure details.

### My GitHub

- Connected account.
- Owned repositories.
- Starred repositories.
- Selected context repositories.

### AI Providers

- Chat providers tab.
- Embedding providers tab.
- Test connection action.

## Delivery Phases

### Phase 1: Foundation

- Project scaffold.
- Database schema.
- Profile CRUD.
- AI provider CRUD.
- Worker bootstrap.
- DB-backed queue.

### Phase 2: GitHub Scan

- GitHub Search collection.
- L0/L1 persistence.
- Checkpoint/resume.
- Basic job UI.

### Phase 3: Ranking

- Rule filters.
- Rule scoring.
- Recommendation persistence.
- Recommendations UI with GitHub links.

### Phase 4: AI Analysis

- Embedding provider calls.
- Chat provider calls.
- README chunking.
- Structured LLM output.
- AI-enriched detail drawer.

### Phase 5: Personalization

- My GitHub context sync.
- Context fit scoring.
- Feedback actions.
- Preference signal updates.

### Phase 6: Resource And Sync

- ResourceGovernor dynamic throttling.
- Cost/token dashboard.
- Optional knowledge sync.

## Test Strategy

When implementation exists, add tests for:

- Profile config validation.
- AI provider kind separation.
- GitHub query generation.
- Layered persistence transitions.
- Scoring formula.
- Queue checkpoint/resume.
- README chunking.
- LLM JSON parsing and retry behavior.
- Feedback scoring.
- GitHub external link rendering.

## Risks

- GitHub API rate limits can slow scans.
- Third-party AI APIs can fail, rate-limit, or return invalid JSON.
- README and raw LLM input retention can grow storage quickly.
- Private repository handling must remain conservative.
- First scan may take hours in complete low-memory mode.

## MVP Done Criteria

- One profile can scan GitHub and produce recommendations.
- Recommendations can be reviewed in the UI.
- GitHub repository links work.
- Chat and embedding providers are configured separately.
- Low-memory processing uses persisted queues and checkpoints.
- Feedback persists and influences future scoring.
- No plaintext API keys or GitHub tokens are stored.
