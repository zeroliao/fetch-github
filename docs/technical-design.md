# Technical Design

## Architecture

`fetchGithub` is implemented as an independent service with a UI/API layer, a worker layer, and persistent storage.

Current stack:

```text
Frontend/API: Next.js + TypeScript
Worker: Node.js + TypeScript
Database: PostgreSQL + pgvector, with JSON-file fallback for local degraded operation
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

- Wakes on an internal 60-second interval while global scanning is enabled.
- Exposes only the missed-run policy: `skip`, `run_once`, or `resume`.
- Enqueues scan jobs.
- Keeps at most one active scan per profile, including `exception` jobs awaiting manual recovery.
- Starts the next scan cycle after the previous job reaches a terminal state, so scanning continues without a candidate-count or runtime cutoff.

### GitHubCollector

- Generates GitHub search query plans from profile preferences and enabled discovery sources.
- Uses GitHub API to collect repository metadata.
- Fetches details, topics, languages, README, and snapshots when a repository reaches the appropriate stage.
- Respects API rate limits and stores checkpoints.
- Uses 100 as the internal GitHub page size and continues pagination until results end or GitHub Search's 1000-result boundary is reached. This is an upstream API boundary, not a user-configured candidate limit.
- Claims processing by canonical repository URL. Repositories already marked `processed` or `skipped` are not analyzed again; `failed` and `exception` records can be claimed by a later scan.

### DiscoverySourceRegistry

- Defines authority sources and default weights.
- Implemented scan sources: `github_search_preferences`, `github_topics`, `github_search_stars`, `github_search_recent_growth`.
- Planned adapter sources: `github_trending`, `github_explore`, `ossinsight_trending`, `gharchive_velocity`.
- Quality signal sources: `openssf_scorecard`, `ecosystems_usage`.
- Source weight affects candidate queue priority, not final recommendation authority by itself.

### ResourceGovernor

- Monitors available memory and process memory.
- Calculates each stage's batch size from current free memory and an internal per-item estimate.
- Pauses jobs when memory is critical.
- Automatically resumes memory-paused jobs when free memory returns above the configured floor.
- Records resource events for observability.

### ScoringEngine

- Applies hard filters.
- Calculates rule score from keywords, topics, language, stars, growth, freshness, and quality.
- Combines rule, context, LLM, and feedback scores.
- Writes `score_version`.

### EmbeddingEngine

- Selects an enabled embedding provider by `priority ASC`.
- Embeds repository summaries, README summaries, user preferences, and user GitHub project summaries.
- Stores vectors with provider, model, dimensions, and content hash.
- Calculates semantic similarity and GitHub context fit.

### LLMAnalyzer

- Selects an enabled chat provider by `priority ASC`.
- Produces structured JSON for summary, categories, risks, match judgment, and recommendation reason.
- Processes long README content using chunk summaries and hierarchical summaries.
- Writes `prompt_version`.
- Counts only JSON parsing and output-schema failures toward the consecutive parse threshold. After three such failures in one job, it rotates to the next chat provider.
- Auth, permission, invalid configuration, rate limit, network, timeout, and 5xx errors use separate blocked/cooldown handling and never increment the parse counter.
- If no provider of the required kind remains, the scan enters `exception` and stops until the user restores a provider and resumes the job.

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
scan_schedule_state
- profile_id
- last_checked_at
- last_scheduled_at
- last_job_id
- updated_at
```

The historical `scan_schedules` table and old schedule fields in profile JSON remain migration-compatible but are not used by the current scheduler. `missed_run_policy` is read from the profile.

```text
discovery_jobs
- id
- profile_id
- type
- status
- stage
- max_candidates      # legacy compatibility; runtime value is 0 and is not a limit
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
- api_key_env                 # unique provider-scoped env var name
- model
- dimensions
- priority
- reasoning_effort
- availability_status
- unavailable_code
- unavailable_reason
- recovery_suggestion
- cooldown_until
- archived_at
- config_json
- enabled
```

```text
repo_processing
- canonical_url       # primary key
- repo_id
- status              # pending | processing | processed | skipped | failed | exception
- job_id
- skip_reason_code
- error_code
- error_message
- claimed_at
- processed_at
- updated_at
```

```text
scan_provider_states
- job_id
- provider_id
- kind
- consecutive_parse_failures
- exhausted
- last_error_code
- last_error_message
- updated_at
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
- preference_status   # pending | liked | disliked
- opportunity_status  # unassessed | qualified | not_qualified
- opportunity_stage   # observing | pending_validation | validating | validated | monetization_ready | abandoned
- viewed_at
- saved_at
- hidden_at
- tracked_at
- status              # legacy compatibility projection
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
exception
```

`exception` is reserved for a scan that cannot continue because the required AI model pool is exhausted. The worker does not auto-run it. Recovery requires fixing or adding an appropriate provider, successfully running “检测并恢复”, and then manually resuming the scan.

## State Transitions

Repository processing is keyed only by canonical GitHub URL:

```text
absent | pending | failed | exception
  -> processing
  -> processed   (recommendation persisted successfully; terminal)
  -> skipped     (hard filter, LLM mismatch, or opportunity score below threshold; terminal)
  -> failed      (repository-level error; retryable)
  -> exception   (job stopped because the model pool is exhausted; retryable)
```

Recommendation state is split into independent axes:

| Axis                      | Initial value                                  | Operations and transitions                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preference                | `pending`                                      | `set_liked`/`like` -> `liked`; `set_disliked`/`dislike` -> `disliked`; `set_pending` -> `pending`                                                                                                     |
| Opportunity qualification | `qualified` for newly accepted recommendations | `mark_qualified` -> `qualified`; `mark_not_qualified` -> `not_qualified`; `reset_qualification` -> `unassessed`                                                                                       |
| Opportunity stage         | `observing`                                    | `to_validate` -> `pending_validation`; `validating` -> `validating`; `mark_validated` -> `validated`; `monetization_ready` -> `monetization_ready`; `abandon` -> `abandoned`; `reopen` -> `observing` |
| User actions              | timestamps are initially empty                 | `save`/`unsave`, `hide`/`restore`, and `track`/`untrack` update only their own timestamps                                                                                                             |

The legacy recommendation `status` column remains a compatibility projection for existing clients and historical rows. New UI filtering and operations use the independent fields above.

Provider availability transitions:

| Failure or action                                            | Provider state                                                    | Parse counter | Recovery                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| Valid call                                                   | `available`                                                       | reset to 0    | automatic                                                       |
| JSON parse or output Schema failure                          | remains selectable until the third consecutive failure in the job | +1            | rotate after threshold; a later job may try it again            |
| 401 or missing API Key                                       | `blocked_auth`                                                    | unchanged     | fix credentials, then “检测并恢复”                              |
| 403                                                          | `blocked_permission`                                              | unchanged     | fix account/model permission, then “检测并恢复”                 |
| Unsupported parameter/model or invalid request configuration | `invalid_config`                                                  | unchanged     | fix configuration, then “检测并恢复”                            |
| 429                                                          | `cooldown`                                                        | unchanged     | honor `Retry-After`, then automatically retry                   |
| Network, timeout, or 5xx                                     | `cooldown`                                                        | unchanged     | limited retries and automatic retry after cooldown              |
| User starts recovery probe                                   | `recovering`                                                      | unchanged     | success -> `available`; failure -> classified unavailable state |

Scan job transitions are resumable:

```text
pending -> running <-> throttled
running -> paused_by_memory -> running
running -> retry_later -> running
running -> exception -> running  # manual resume after provider recovery
running -> completed
running -> failed
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

Current user-facing resource policy:

```yaml
resource_policy:
  min_available_memory_mb: 512
```

## AI Provider Design

Chat and embedding providers are independent and profiles do not bind provider IDs.

```yaml
ai:
  providers:
    default_chat:
      kind: chat
      type: openai_compatible
      base_url: https://api.example.com/v1
      api_key_env: OPENAI_GPT_5
      model: chat-model
      priority: 10
      reasoning_effort: low
    default_embedding:
      kind: embedding
      type: openai_compatible
      base_url: https://api.example.com/v1
      api_key_env: OPENAI_EMBEDDING
      model: embedding-model
      dimensions: 1536
      priority: 10
```

The API key value must never be stored in the database. The provider name is normalized into the single API key environment variable name, and names must be unique. Renaming a provider requires entering its API key again because the environment variable name changes.

Provider records also store priority, reasoning effort, availability, sanitized failure reason, recovery guidance, and cooldown state. A lower priority value is selected first. The API key value can be written to `.env.local` through the UI, but the database only stores the environment variable name.

Persistent provider states are `blocked_auth`, `blocked_permission`, and `invalid_config`; they require user correction followed by “检测并恢复”. `cooldown` automatically becomes eligible after its deadline. `recovering` prevents selection while a manual probe is in progress.

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

The MVP writes a `local-derived-index` sync record and content hash to `knowledge_syncs`. When `AI_KNOWLEDGE_BASE_DIR` is configured, the implemented local adapter also writes derived Markdown under `derived/fetchGithub`; FastGPT remains optional. Neither target replaces `fetchGithub` as the source of truth.

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
- The local `ai-knowledge-base` write adapter and cost dashboard are implemented. FastGPT integration, a richer context-match audit table, cache-hit reporting, and broader automated API tests remain future work.
