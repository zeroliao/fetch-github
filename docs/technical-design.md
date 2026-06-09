# Technical Design

## Architecture

`fetchGithub` should be implemented as an independent service with a UI/API layer, a worker layer, and a persistent database.

Recommended stack for the one-step implementation:

```text
Frontend/API: Next.js + TypeScript
Worker: Node.js + TypeScript
Database: PostgreSQL + pgvector
Queue: DB-backed job and queue tables
AI: third-party OpenAI-compatible chat provider and embedding provider
Deployment: Docker Compose
```

Redis is not required for MVP because DB-backed queues are simpler and preserve low-memory resumability. It can be added later if throughput requires it.

## System Diagram

```text
User
  |
  v
Next.js UI/API
  |       \
  |        \ feedback, profiles, provider config
  v
PostgreSQL + pgvector
  ^
  |
Worker
  |- Scheduler
  |- GitHubCollector
  |- ResourceGovernor
  |- ScoringEngine
  |- EmbeddingEngine
  |- LLMAnalyzer
  |- PreferenceLearner
  `- KnowledgeBaseConnector
```

## Module Responsibilities

### Scheduler

- Evaluates profile schedules.
- Supports cron, interval, timezone, start time, max runtime, and missed-run policy.
- Enqueues scan jobs.
- Prevents unbounded concurrent profile scans.

### GitHubCollector

- Generates GitHub search query plans from profile preferences and enabled discovery sources.
- Uses GitHub API to collect repository metadata.
- Fetches details, topics, languages, README, and snapshots when a repository reaches the appropriate stage.
- Respects API rate limits and stores checkpoints.

### DiscoverySourceRegistry

- Defines authority sources and default weights.
- Implemented scan sources: `github_search_preferences`, `github_topics`, `github_search_stars`, `github_search_recent_growth`.
- Planned adapter sources: `github_trending`, `github_explore`, `ossinsight_trending`, `gharchive_velocity`.
- Quality signal sources: `openssf_scorecard`, `ecosystems_usage`.
- Source weight affects candidate queue priority, not final recommendation authority by itself.

### ResourceGovernor

- Monitors available memory and process memory.
- Adjusts batch size, concurrency, page delay, and AI job concurrency.
- Pauses jobs when memory is critical.
- Records resource events for observability.

### ScoringEngine

- Applies hard filters.
- Calculates rule score from keywords, topics, language, stars, growth, freshness, and quality.
- Combines rule, context, LLM, and feedback scores.
- Writes `score_version`.

### EmbeddingEngine

- Uses the configured embedding provider.
- Embeds repository summaries, README summaries, user preferences, and user GitHub project summaries.
- Stores vectors with provider, model, dimensions, and content hash.
- Calculates semantic similarity and GitHub context fit.

### LLMAnalyzer

- Uses the configured chat provider.
- Produces structured JSON for summary, categories, risks, match judgment, and recommendation reason.
- Processes long README content using chunk summaries and hierarchical summaries.
- Writes `prompt_version`.

### PreferenceLearner

- Converts user feedback into preference signals.
- Tracks language, topic, keyword, category, and negative signals.
- Optionally asks the LLM to extract higher-level preference changes.

### KnowledgeBaseConnector

- Optional.
- Generates Markdown documents for L4 high-value repositories.
- Syncs to FastGPT or `../ai-knowledge-base`.
- Stores external document IDs and content hashes.
- Does not become a source of truth.

## Data Model

### Repository Data

```text
repos
- id
- github_id
- full_name
- owner
- name
- html_url
- description
- primary_language
- languages_json
- topics_json
- license
- stars
- forks
- watchers
- open_issues
- default_branch
- created_at
- pushed_at
- updated_at
- archived
- fork
- private
- data_level
- first_seen_at
- last_seen_at
```

```text
repo_snapshots
- id
- repo_id
- captured_at
- stars
- forks
- watchers
- open_issues
- pushed_at
```

```text
repo_documents
- id
- repo_id
- type
- source_url
- content_hash
- raw_content_compressed
- summary
- extracted_keywords_json
- captured_at
```

### Profiles And Jobs

```text
discovery_profiles
- id
- name
- enabled
- config_json
- created_at
- updated_at
```

```text
scan_schedules
- id
- profile_id
- type
- cron
- interval_hours
- timezone
- start_at
- max_runtime_minutes
- missed_run_policy
- enabled
```

```text
discovery_jobs
- id
- profile_id
- type
- status
- stage
- max_candidates
- fetched_count
- processed_count
- analyzed_count
- started_at
- finished_at
- error_message
- archived_at
```

```text
scan_checkpoints
- id
- job_id
- source
- query_hash
- page
- cursor
- processed_count
- stage
- updated_at
```

```text
candidate_queue
- id
- job_id
- repo_id
- priority_score
- stage
- status
- attempts
- next_run_at
- queued_at
```

### AI And Scoring

```text
ai_providers
- id
- name
- kind              # chat | embedding
- type              # openai_compatible | custom
- base_url
- api_key_env
- model
- dimensions
- config_json
- enabled
```

```text
repo_embeddings
- id
- repo_id
- provider_id
- model
- dimensions
- content_hash
- vector
- created_at
```

```text
llm_jobs
- id
- repo_id
- job_type
- status
- input_hash
- provider_id
- model
- prompt_version
- attempts
- token_usage_json
- created_at
- finished_at
```

```text
llm_results
- id
- repo_id
- provider_id
- model
- job_type
- prompt_version
- structured_json
- raw_response_compressed
- created_at
```

```text
repo_scores
- id
- repo_id
- profile_id
- rule_score
- github_context_fit
- llm_match_score
- feedback_score
- final_score
- score_version
- reasons_json
- calculated_at
```

```text
recommendations
- id
- job_id
- profile_id
- repo_id
- rank
- final_score
- reasons_json
- status
- created_at
```

### User Context And Feedback

```text
github_accounts
- id
- username
- token_ref
- connected_at
- last_synced_at
```

```text
user_repos
- id
- github_account_id
- github_id
- full_name
- description
- primary_language
- topics_json
- visibility
- readme_summary
- dependencies_json
- last_synced_at
```

```text
repo_context_matches
- id
- candidate_repo_id
- user_repo_id
- match_score
- match_reasons_json
- calculated_at
```

```text
feedback
- id
- repo_id
- profile_id
- action
- note
- created_at
```

```text
preference_signals
- id
- profile_id
- signal_type
- value
- weight
- source
- updated_at
```

### Knowledge Sync

```text
knowledge_syncs
- id
- repo_id
- target
- dataset_id
- external_doc_id
- content_hash
- status
- synced_at
- error_message
```

## Scan State Machine

```text
pending
running
throttled
paused_by_memory
paused_by_runtime
paused_by_user
retry_later
completed
failed
```

Stage values:

```text
collect
profile
document
embed
llm
rank
sync
```

## Complete Low-Memory Execution

The system must avoid memory growth with candidate volume.

Rules:

- Process GitHub pages one batch at a time.
- Upsert candidates immediately.
- Use database unique indexes for deduplication.
- Use DB-backed queue rows instead of in-memory queues.
- Fetch queue work with small `LIMIT` queries.
- Process stages serially when low-memory mode is enabled.
- Store checkpoints frequently.
- Split long README content into chunks and persist each step.
- Pause or throttle when memory crosses configured thresholds.
- On worker startup, requeue stale `running` candidates and continue resumable scan jobs.
- Completed and failed scan jobs can be soft-archived with `archived_at`; archived jobs are hidden from default task lists but retained for audit.

Example policy:

```yaml
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
```

## AI Provider Design

Chat and embedding providers must be independent.

```yaml
ai:
  providers:
    default_chat:
      kind: chat
      type: openai_compatible
      base_url: https://api.example.com/v1
      api_key_env: CHAT_API_KEY
      model: chat-model
      supports_json_schema: true
    default_embedding:
      kind: embedding
      type: openai_compatible
      base_url: https://api.example.com/v1
      api_key_env: EMBEDDING_API_KEY
      model: embedding-model
      dimensions: 1536
```

The API key value must never be stored in the database. Store only the environment variable name.

Provider records store `base_url`, `api_key_env`, `model`, `dimensions`, `enabled`, timeout and rate-limit metadata in one place. The API key value can be written to `.env.local` through the UI, but the database only stores the environment variable name.

## LLM Structured Output

LLM analysis should return JSON:

```json
{
  "summary": "Short project summary",
  "categories": ["AI", "Developer Tools"],
  "target_users": ["solo developers"],
  "core_features": ["GitHub discovery", "ranking"],
  "maturity": "early",
  "is_match": true,
  "match_score": 0.86,
  "confidence": 0.78,
  "matched_preferences": ["AI developer tools"],
  "risks": ["limited documentation"],
  "recommendation_reason": "Matches the configured GitHub discovery profile."
}
```

## Security And Privacy

- Never log plaintext tokens or API keys.
- Never persist private repository content unless explicitly enabled.
- Do not send private repository README or code to third-party AI services by default.
- Do not expose raw storage directories publicly.
- Retain raw LLM inputs and raw GitHub responses only according to retention policy.
- Use `rel="noopener noreferrer"` for external GitHub links.

## Knowledge Base Integration

`fetchGithub` remains the source of truth.

Knowledge sync is derived:

```text
fetchGithub L4 repository
 -> generated Markdown
 -> FastGPT / ai-knowledge-base
 -> vectorized knowledge document
```

Only content hash changes should trigger resync.

MVP implementation writes a `local-derived-index` sync record and content hash to `knowledge_syncs`. A real FastGPT or `../ai-knowledge-base` adapter remains optional and must not replace `fetchGithub` as the source of truth.

## Observability

Track:

- Scan progress by job and stage.
- GitHub API request count, timeout events, and rate limit events.
- AI token usage, timeout events, cache hit ratio, and estimated cost.
- Memory resource events.
- Queue depth.
- Recommendation save/hide ratio.
- Knowledge sync success/failure.

## Current Implementation Status

- GitHub context uses `GITHUB_TOKEN` from environment or `.env.local`; plaintext tokens are not stored in the database.
- AI providers use OpenAI-compatible third-party APIs with separate chat and embedding provider records.
- UI is implemented with Next.js client components, project CSS, and `lucide-react` icons.
- Production deployment currently runs web and worker systemd services behind `github.zero007.chat`.
- FastGPT / `../ai-knowledge-base` write adapter, cost dashboard, richer context-match audit table, and automated API tests remain future work.
