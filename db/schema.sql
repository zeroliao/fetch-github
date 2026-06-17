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
CREATE INDEX IF NOT EXISTS idx_recommendations_profile ON recommendations(profile_id, final_score DESC);
