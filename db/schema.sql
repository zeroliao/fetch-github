CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'embedding')),
  type TEXT NOT NULL DEFAULT 'openai_compatible',
  base_url TEXT NOT NULL,
  api_key_env TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER,
  priority INTEGER NOT NULL DEFAULT 100,
  reasoning_effort TEXT,
  availability_status TEXT NOT NULL DEFAULT 'available',
  unavailable_code TEXT,
  unavailable_reason TEXT,
  recovery_suggestion TEXT,
  unavailable_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  github_id BIGINT UNIQUE,
  full_name TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  html_url TEXT NOT NULL,
  description TEXT,
  primary_language TEXT,
  languages_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  topics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  license TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  forks INTEGER NOT NULL DEFAULT 0,
  watchers INTEGER NOT NULL DEFAULT 0,
  open_issues INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  created_at TIMESTAMPTZ,
  pushed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  fork BOOLEAN NOT NULL DEFAULT FALSE,
  private BOOLEAN NOT NULL DEFAULT FALSE,
  data_level TEXT NOT NULL DEFAULT 'L0',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repo_snapshots (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stars INTEGER NOT NULL,
  forks INTEGER NOT NULL,
  watchers INTEGER NOT NULL,
  open_issues INTEGER NOT NULL,
  pushed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS repo_documents (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  raw_content_compressed BYTEA,
  summary TEXT,
  extracted_keywords_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_documents_repo_type_hash
  ON repo_documents(repo_id, type, content_hash);

CREATE TABLE IF NOT EXISTS scan_schedules (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES discovery_profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  cron TEXT,
  interval_hours INTEGER,
  timezone TEXT NOT NULL,
  start_at TIMESTAMPTZ,
  max_runtime_minutes INTEGER,
  missed_run_policy TEXT NOT NULL DEFAULT 'skip',
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS scan_schedule_state (
  profile_id TEXT PRIMARY KEY REFERENCES discovery_profiles(id) ON DELETE CASCADE,
  last_checked_at TIMESTAMPTZ,
  last_scheduled_at TIMESTAMPTZ,
  last_job_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES discovery_profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  max_candidates INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  analyzed_count INTEGER NOT NULL DEFAULT 0,
  new_repo_count INTEGER NOT NULL DEFAULT 0,
  updated_repo_count INTEGER NOT NULL DEFAULT 0,
  unchanged_repo_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  failed_candidate_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  error_code TEXT,
  error_resolution TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scan_checkpoints (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  page INTEGER,
  cursor TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_checkpoints_job_source_hash_stage
  ON scan_checkpoints(job_id, source, query_hash, stage);

CREATE TABLE IF NOT EXISTS candidate_queue (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  priority_score NUMERIC NOT NULL DEFAULT 0,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  next_run_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(job_id, repo_id, stage)
);

CREATE TABLE IF NOT EXISTS repo_processing (
  canonical_url TEXT PRIMARY KEY,
  repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'skipped', 'failed', 'exception')),
  job_id TEXT REFERENCES discovery_jobs(id) ON DELETE SET NULL,
  skip_reason_code TEXT,
  error_code TEXT,
  error_message TEXT,
  claimed_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_provider_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'openai_compatible',
  base_url TEXT NOT NULL,
  api_key_env TEXT NOT NULL,
  proxy_url_env TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ai_provider_groups
  DROP CONSTRAINT IF EXISTS ai_provider_groups_api_key_env_key;

CREATE TABLE IF NOT EXISTS resource_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  available_mb INTEGER NOT NULL,
  rss_mb INTEGER NOT NULL,
  heap_used_mb INTEGER NOT NULL,
  total_mb INTEGER NOT NULL,
  batch_size INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repo_embeddings (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id),
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  vector vector,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repo_id, provider_id, content_hash)
);

CREATE TABLE IF NOT EXISTS embedding_cache (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id),
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  vector vector,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS llm_jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  job_id TEXT REFERENCES discovery_jobs(id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  token_usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS llm_results (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id),
  model TEXT NOT NULL,
  job_type TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT,
  structured_json JSONB NOT NULL,
  raw_response_compressed BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_health_events (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  availability_status TEXT NOT NULL,
  code TEXT,
  reason TEXT,
  recovery_suggestion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scan_provider_states (
  job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id),
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'embedding')),
  consecutive_parse_failures INTEGER NOT NULL DEFAULT 0,
  exhausted BOOLEAN NOT NULL DEFAULT FALSE,
  last_error_code TEXT,
  last_error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, provider_id)
);

CREATE TABLE IF NOT EXISTS repo_scores (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES discovery_profiles(id) ON DELETE CASCADE,
  rule_score NUMERIC NOT NULL,
  github_context_fit NUMERIC NOT NULL,
  llm_match_score NUMERIC NOT NULL,
  feedback_score NUMERIC NOT NULL,
  final_score NUMERIC NOT NULL,
  score_version TEXT NOT NULL,
  reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES discovery_jobs(id) ON DELETE SET NULL,
  profile_id TEXT NOT NULL REFERENCES discovery_profiles(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  final_score NUMERIC NOT NULL,
  reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'new',
  preference_status TEXT NOT NULL DEFAULT 'pending',
  opportunity_status TEXT NOT NULL DEFAULT 'unassessed',
  opportunity_stage TEXT NOT NULL DEFAULT 'observing',
  viewed_at TIMESTAMPTZ,
  saved_at TIMESTAMPTZ,
  hidden_at TIMESTAMPTZ,
  tracked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  token_ref TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_repos (
  id TEXT PRIMARY KEY,
  github_account_id TEXT REFERENCES github_accounts(id) ON DELETE CASCADE,
  github_id BIGINT,
  full_name TEXT NOT NULL,
  description TEXT,
  primary_language TEXT,
  topics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility TEXT NOT NULL DEFAULT 'public',
  readme_summary TEXT,
  dependencies_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_for_context BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_repos_account_full_name
  ON user_repos(github_account_id, full_name);

CREATE TABLE IF NOT EXISTS repo_context_matches (
  id TEXT PRIMARY KEY,
  candidate_repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_repo_id TEXT NOT NULL REFERENCES user_repos(id) ON DELETE CASCADE,
  match_score NUMERIC NOT NULL,
  match_reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(candidate_repo_id, user_repo_id)
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES discovery_profiles(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preference_signals (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES discovery_profiles(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  value TEXT NOT NULL,
  weight NUMERIC NOT NULL,
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(profile_id, signal_type, value, source)
);

CREATE TABLE IF NOT EXISTS knowledge_syncs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  dataset_id TEXT,
  external_doc_id TEXT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  synced_at TIMESTAMPTZ,
  error_message TEXT,
  UNIQUE(repo_id, target, dataset_id, content_hash)
);

CREATE TABLE IF NOT EXISTS mark_directories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  parent_id TEXT REFERENCES mark_directories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  deleted_at TIMESTAMPTZ,
  deleted_root BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 1 AND 100)
);

CREATE TABLE IF NOT EXISTS mark_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  directory_id TEXT REFERENCES mark_directories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  deleted_root BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 1 AND 180),
  CHECK (size_bytes BETWEEN 0 AND 2097152)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mark_directories_active_name
  ON mark_directories(user_id, COALESCE(parent_id, ''), lower(name))
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mark_files_active_name
  ON mark_files(user_id, COALESCE(directory_id, ''), lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mark_directories_user_parent
  ON mark_directories(user_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mark_files_user_directory
  ON mark_files(user_id, directory_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mark_directories_trash
  ON mark_directories(user_id, deleted_at DESC) WHERE deleted_root = TRUE;
CREATE INDEX IF NOT EXISTS idx_mark_files_trash
  ON mark_files(user_id, deleted_at DESC) WHERE deleted_root = TRUE;

CREATE INDEX IF NOT EXISTS idx_repos_full_name ON repos(full_name);
CREATE INDEX IF NOT EXISTS idx_repos_stars ON repos(stars DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON discovery_jobs(status, stage);
CREATE INDEX IF NOT EXISTS idx_candidate_queue_work ON candidate_queue(status, stage, priority_score DESC);
ALTER TABLE candidate_queue
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE candidate_queue
  ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE discovery_jobs
  ADD COLUMN IF NOT EXISTS failed_candidate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_jobs
  ADD COLUMN IF NOT EXISTS job_id TEXT REFERENCES discovery_jobs(id) ON DELETE SET NULL;
ALTER TABLE llm_jobs
  ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE llm_results
  ADD COLUMN IF NOT EXISTS input_hash TEXT;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS availability_status TEXT NOT NULL DEFAULT 'available';
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS unavailable_code TEXT;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS unavailable_reason TEXT;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS recovery_suggestion TEXT;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS unavailable_at TIMESTAMPTZ;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS provider_group_id TEXT REFERENCES ai_provider_groups(id);
INSERT INTO ai_provider_groups
  (id, name, type, base_url, api_key_env, enabled, archived_at, created_at, updated_at)
SELECT
  'legacy-' || id, name, type, base_url, api_key_env, enabled, archived_at, created_at, updated_at
FROM ai_providers
WHERE provider_group_id IS NULL
ON CONFLICT (id) DO NOTHING;
UPDATE ai_providers
SET provider_group_id = 'legacy-' || id
WHERE provider_group_id IS NULL;
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS preference_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS opportunity_status TEXT NOT NULL DEFAULT 'unassessed';
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS opportunity_stage TEXT NOT NULL DEFAULT 'observing';
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ;
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS tracked_at TIMESTAMPTZ;
UPDATE recommendations
SET preference_status = CASE status
      WHEN 'liked' THEN 'liked'
      WHEN 'disliked' THEN 'disliked'
      ELSE preference_status
    END,
    opportunity_stage = CASE status
      WHEN 'to_validate' THEN 'pending_validation'
      WHEN 'validating' THEN 'validating'
      WHEN 'monetization_ready' THEN 'monetization_ready'
      WHEN 'abandoned' THEN 'abandoned'
      ELSE opportunity_stage
    END,
    viewed_at = CASE WHEN status = 'viewed' AND viewed_at IS NULL THEN created_at ELSE viewed_at END,
    saved_at = CASE WHEN status = 'saved' AND saved_at IS NULL THEN created_at ELSE saved_at END,
    hidden_at = CASE WHEN status = 'hidden' AND hidden_at IS NULL THEN created_at ELSE hidden_at END,
    tracked_at = CASE WHEN status = 'tracked' AND tracked_at IS NULL THEN created_at ELSE tracked_at END;
INSERT INTO repo_processing (canonical_url, repo_id, status, processed_at, updated_at)
SELECT
  'https://github.com/' || lower(
    regexp_replace(
      split_part(
        split_part(
          regexp_replace(repo.html_url, '^https?://(www\.)?github\.com/', '', 'i'),
          '?',
          1
        ),
        '#',
        1
      ),
      '(\.git)?/+$',
      '',
      'i'
    )
  ),
  repo.id,
  'processed',
  now(),
  now()
FROM repos repo
WHERE repo.data_level IN ('L3', 'L4')
   OR EXISTS (SELECT 1 FROM recommendations rec WHERE rec.repo_id = repo.id)
   OR EXISTS (SELECT 1 FROM llm_results result WHERE result.repo_id = repo.id)
ON CONFLICT (canonical_url) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_repo_processing_status ON repo_processing(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_provider_health_events_provider ON provider_health_events(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_providers_selection ON ai_providers(kind, enabled, availability_status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_providers_group ON ai_providers(provider_group_id, kind, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_recommendations_profile ON recommendations(profile_id, final_score DESC);
