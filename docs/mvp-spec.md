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
- `missed_run_policy`
- `preferences`
- `opportunity.brief`
- `opportunity.min_opportunity_score`
- `resource_policy.min_available_memory_mb`

Acceptance:

- Profile config persists.
- Disabled profiles do not run scheduled scans.
- Runtime, candidate-count, stage Top K, and concrete provider selection are not user-facing controls.
- The worker keeps scanning in persisted batches and uses free memory as the execution gate.

### F2. AI Provider Management

User can configure chat and embedding models under shared Provider groups.

Required fields:

- Provider group `name`, `type`, `base_url`, and `api_key_env` (derived from the group name)
- Optional `proxy_url_env`, referencing a server-side HTTP/SOCKS URL such as a sub2api sidecar endpoint
- One or more models with `kind`, `model`, model-level `priority`, `enabled`, and failure policy
- `reasoning_effort` for chat models; `none` means do not send `reasoning_effort`
- `dimensions` for embedding models
- `rate_limit`
- `timeout`
- `cooldown_seconds` and `cooldown_on`
- `enabled`

Acceptance:

- Chat provider cannot be selected as an embedding provider.
- Embedding provider cannot be selected as a chat provider.
- API key value is not stored, only `api_key_env`.
- The Provider group name is the user-facing connection name and determines its API key environment variable; model names are independent within the group.
- Provider names must be unique after normalization; existing single-model records migrate into one-model legacy groups.
- Test connection action verifies provider availability without printing secrets.
- Test connection action runs the production Chat analysis schema or a batch Embedding shape/dimension probe.
- Provider selection uses only `available` models, by kind and ascending model priority; an expired cooldown is first checked with a real probe and only a successful probe returns it to `available`.
- Failure codes outside `cooldown_on` enter manual `error` recovery.
- The list shows availability status, sanitized unavailable reason, recovery guidance, and cooldown deadline.
- Persistent unavailable states can return to `available` only after “检测并恢复” succeeds.
- Delete is a soft delete so historical embedding and LLM foreign keys remain valid.

### F3. GitHub Collection

System can manually run a scan for one profile.

Acceptance:

- Generates GitHub search queries from profile preferences.
- Persists L0 seen records for scanned repositories.
- Persists L1 candidate records for repositories passing hard filters.
- Stores checkpoints for pagination progress.
- Can resume an interrupted scan.
- Uses canonical repository URL as the processing key; `processed` and `skipped` are terminal, while `failed` and `exception` can be retried.

### F4. Low-Memory Queue Processing

System uses DB-backed queue stages.

Acceptance:

- No full candidate list is required in memory.
- Worker fetches small batches from `candidate_queue`.
- Job can enter `throttled`, `paused_by_memory`, and resume states.
- Resource events are recorded.
- Batch size is derived from current free memory and no user-configured candidate count ends the scan.

### F5. Scoring And Recommendations

System calculates scores and produces recommendations.

Acceptance:

- Calculates rule score from deterministic signals.
- Calculates final score using rule/context/LLM/feedback components.
- Stores `score_version`.
- Recommendations are sorted by final score.
- Every recommendation that satisfies the match and minimum opportunity score is retained; pagination is presentation-only and does not cap storage.

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
- preference: `pending`, `liked`, `disliked`
- qualification: `unassessed`, `qualified`, `not_qualified`
- stage: `observing`, `pending_validation`, `validating`, `validated`, `monetization_ready`, `abandoned`
- `track`

Acceptance:

- Feedback persists.
- Feedback updates only its corresponding status axis; save, hide, and track remain independent timestamps.
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
  missed_run_policy: skip
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
  min_available_memory_mb: 512
opportunity:
  brief: 寻找可做 SaaS、托管版、私有化部署或集成服务的项目
  min_opportunity_score: 0.55
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
POST   /api/ai-providers/:id/recover

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
- Missed-run policy.
- Preferences.
- Opportunity brief and minimum score.
- Minimum available memory.

### System Operations

- Scan-cycle history and recovery controls.
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
- Priority, reasoning effort, and availability details.
- Test connection action.
- Detection and recovery action.

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
- Provider priority, error classification, rotation, and recovery behavior.
- Canonical URL processing deduplication.
- Memory-driven batch selection.
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
