import type {
  AiProvider,
  AppSettings,
  CachedEmbedding,
  DashboardSnapshot,
  DiscoveryProfile,
  Feedback,
  FeedbackAction,
  GithubAccount,
  KnowledgeSync,
  OperationsSnapshot,
  OpportunityAnalysis,
  PreferenceSignal,
  Recommendation,
  RepoDataLevel,
  RepoSummary,
  ResourceEvent,
  ScanCheckpoint,
  ScanJob,
  UpsertRepoStats,
  UserGitHubRepo
} from "@/lib/types";
import { defaultAppSettings, normalizeAppSettings } from "@/lib/settings";
import { normalizeDiscoveryLimits } from "@/lib/semanticGate";
import {
  seedGithubAccounts,
  seedGithubRepos,
  seedProfiles,
  seedProviders,
  seedRecommendations
} from "@/lib/seed";
import { normalizeDiscoverySources } from "@/lib/discoverySources";
import { normalizeOpportunityProfile } from "@/lib/opportunity";
import { annotateRecommendationClusters } from "@/lib/repoCluster";
import {
  repoHasMaterialMetadataChanges,
  shouldAnalyzeDiscoveredRepo
} from "@/lib/repoRefresh";
import {
  ensureChineseSummary,
  normalizeChineseLabels
} from "@/lib/recommendationText";
import { calculateFinalScore } from "@/lib/scoring";
import { getPool } from "./db";

interface RepoDocumentInput {
  repoId: string;
  type: string;
  sourceUrl?: string;
  contentHash: string;
  rawContent?: string;
  summary?: string;
  extractedKeywords?: string[];
}

interface LlmResultInput {
  repoId: string;
  providerId: string;
  model: string;
  jobType: string;
  promptVersion: string;
  inputHash?: string;
  structured: Record<string, unknown>;
  rawResponse?: string;
}

type Json = Record<string, unknown> | unknown[];
type QueryRunner = {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
};

const JOB_SELECT_FIELDS = `id, profile_id, type, status, stage, max_candidates, fetched_count,
            processed_count, analyzed_count, new_repo_count, updated_repo_count,
            unchanged_repo_count, candidate_count, started_at, finished_at,
            error_message, archived_at, created_at`;

export async function ensureSeedData() {
  const pool = getPool();
  const client = await pool.connect();
  await client.query("select pg_advisory_lock(hashtext('fetchgithub_seed_data'))");

  try {
    await client.query(
      `create table if not exists app_state (
        key text primary key,
        value_json jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now()
      )`
    );
    await client.query(
      `create table if not exists auth_sessions (
        id text primary key,
        user_id text not null,
        expires_at timestamptz not null,
        created_at timestamptz not null default now()
      )`
    );
    await client.query(
      `create table if not exists scan_schedule_state (
        profile_id text primary key references discovery_profiles(id) on delete cascade,
        last_checked_at timestamptz,
        last_scheduled_at timestamptz,
        last_job_id text,
        updated_at timestamptz not null default now()
      )`
    );
    await client.query(
      `alter table candidate_queue
       add column if not exists updated_at timestamptz not null default now()`
    );
    await client.query(
      `alter table llm_results
       add column if not exists input_hash text`
    );
    await client.query(
      `alter table discovery_jobs
       add column if not exists archived_at timestamptz`
    );
    await client.query(
      `alter table discovery_jobs
       add column if not exists new_repo_count integer not null default 0`
    );
    await client.query(
      `alter table discovery_jobs
       add column if not exists updated_repo_count integer not null default 0`
    );
    await client.query(
      `alter table discovery_jobs
       add column if not exists unchanged_repo_count integer not null default 0`
    );
    await client.query(
      `alter table discovery_jobs
       add column if not exists candidate_count integer not null default 0`
    );
    await client.query(
      `create table if not exists embedding_cache (
        id text primary key,
        cache_key text not null unique,
        provider_id text not null references ai_providers(id),
        model text not null,
        dimensions integer not null,
        content_hash text not null,
        vector vector,
        created_at timestamptz not null default now()
      )`
    );
    await client.query(
      `insert into app_state (key, value_json, updated_at)
       values ('app_settings', $1, now())
       on conflict (key) do nothing`,
      [JSON.stringify(defaultAppSettings)]
    );

    const seedState = await client.query(
      `select value_json from app_state where key = 'seed_data_initialized'`
    );

    if (seedState.rows[0]) {
      return;
    }

    const existingData = await client.query(
      `select
        (select count(*)::int from discovery_profiles) as profiles,
        (select count(*)::int from ai_providers) as providers,
        (select count(*)::int from recommendations) as recommendations,
        (select count(*)::int from user_repos) as user_repos`
    );
    const counts = existingData.rows[0] as Record<string, number>;
    const hasBusinessData =
      Number(counts.profiles) +
        Number(counts.providers) +
        Number(counts.recommendations) +
        Number(counts.user_repos) >
      0;

    if (hasBusinessData) {
      await markSeedDataInitialized(false, client);
      return;
    }

    for (const provider of seedProviders) {
      await client.query(
        `insert into ai_providers
          (id, name, kind, type, base_url, api_key_env, model, dimensions, config_json, enabled, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (id) do nothing`,
        [
          provider.id,
          provider.name,
          provider.kind,
          provider.type,
          provider.baseUrl,
          provider.apiKeyEnv,
          provider.model,
          provider.dimensions ?? null,
          JSON.stringify({
            rateLimit: provider.rateLimit,
            timeoutSeconds: provider.timeoutSeconds
          }),
          provider.enabled,
          provider.createdAt,
          provider.updatedAt
        ]
      );
    }

    for (const profile of seedProfiles) {
      await client.query(
        `insert into discovery_profiles (id, name, enabled, config_json, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (id) do nothing`,
        [
          profile.id,
          profile.name,
          profile.enabled,
          JSON.stringify(profile.config),
          profile.createdAt,
          profile.updatedAt
        ]
      );
    }

    for (const recommendation of seedRecommendations) {
      await upsertRepos([recommendation.repo]);
      await upsertRecommendations([recommendation]);
    }

    for (const account of seedGithubAccounts) {
      await client.query(
        `insert into github_accounts (id, username, token_ref, connected_at, last_synced_at)
         values ($1,$2,$3,$4,$5)
         on conflict (id) do nothing`,
        [
          account.id,
          account.username,
          account.tokenRef ?? null,
          account.connectedAt,
          account.lastSyncedAt ?? null
        ]
      );
    }

    for (const repo of seedGithubRepos) {
      await client.query(
        `insert into user_repos
          (id, github_account_id, full_name, description, primary_language, topics_json, visibility, readme_summary, selected_for_context, last_synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (id) do nothing`,
        [
          repo.id,
          repo.githubAccountId ?? null,
          repo.fullName,
          repo.description,
          repo.primaryLanguage,
          JSON.stringify(repo.topics),
          repo.visibility,
          repo.readmeSummary ?? null,
          repo.selectedForContext,
          repo.lastSyncedAt ?? null
        ]
      );
    }

    await markSeedDataInitialized(true, client);
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext('fetchgithub_seed_data'))")
      .catch(() => undefined);
    client.release();
  }
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  await ensureSeedData();
  const [
    profiles,
    aiProviders,
    recommendations,
    jobs,
    githubAccounts,
    githubRepos,
    knowledgeSyncs
  ] =
    await Promise.all([
      listProfiles(),
      listAiProviders(),
      listRecommendations(),
      listScanJobs(),
      listGithubAccounts(),
      listGithubRepos(),
      listKnowledgeSyncs()
    ]);

  return {
    settings: await getAppSettings(),
    profiles,
    aiProviders,
    recommendations,
    jobs,
    githubAccounts,
    githubRepos,
    knowledgeSyncs,
    queueStats: await getQueueStats(),
    operations: await getOperationsSnapshot()
  };
}

export async function getAppSettings(): Promise<AppSettings> {
  await ensureSeedDataOnce();
  const result = await getPool().query(
    `select value_json from app_state where key='app_settings'`
  );

  return normalizeAppSettings(result.rows[0]?.value_json as Partial<AppSettings> | undefined);
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getAppSettings();
  const next = normalizeAppSettings({
    ...current,
    ...patch
  });

  await getPool().query(
    `insert into app_state (key, value_json, updated_at)
     values ('app_settings', $1, now())
     on conflict (key) do update set value_json=excluded.value_json, updated_at=now()`,
    [JSON.stringify(next)]
  );

  return next;
}

export async function listProfiles(): Promise<DiscoveryProfile[]> {
  await ensureSeedDataOnce();
  const result = await getPool().query(
    `select id, name, enabled, config_json, created_at, updated_at
     from discovery_profiles
     order by created_at asc`
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    config: normalizeProfileConfig(row.config_json),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  }));
}

export async function createProfile(
  input: Omit<DiscoveryProfile, "id" | "createdAt" | "updatedAt">
): Promise<DiscoveryProfile> {
  const now = new Date().toISOString();
  const profile: DiscoveryProfile = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now
  };

  await getPool().query(
    `insert into discovery_profiles (id, name, enabled, config_json, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      profile.id,
      profile.name,
      profile.enabled,
      JSON.stringify(profile.config),
      profile.createdAt,
      profile.updatedAt
    ]
  );

  return profile;
}

export async function updateProfile(
  id: string,
  patch: Partial<Pick<DiscoveryProfile, "config" | "enabled" | "name">>
): Promise<DiscoveryProfile | undefined> {
  const existing = (await listProfiles()).find((profile) => profile.id === id);
  if (!existing) {
    return undefined;
  }

  const updated: DiscoveryProfile = {
    ...existing,
    ...patch,
    config: patch.config ?? existing.config,
    updatedAt: new Date().toISOString()
  };

  const result = await getPool().query(
    `update discovery_profiles
     set name=$2, enabled=$3, config_json=$4, updated_at=$5
     where id=$1
     returning id, name, enabled, config_json, created_at, updated_at`,
    [
      updated.id,
      updated.name,
      updated.enabled,
      JSON.stringify(updated.config),
      updated.updatedAt
    ]
  );

  if (!result.rows[0]) {
    return undefined;
  }

  return {
    id: result.rows[0].id,
    name: result.rows[0].name,
    enabled: result.rows[0].enabled,
    config: normalizeProfileConfig(result.rows[0].config_json),
    createdAt: toIso(result.rows[0].created_at),
    updatedAt: toIso(result.rows[0].updated_at)
  };
}

export async function listAiProviders(): Promise<AiProvider[]> {
  await ensureSeedDataOnce();
  const result = await getPool().query(
    `select id, name, kind, type, base_url, api_key_env, model, dimensions, config_json, enabled, created_at, updated_at
     from ai_providers
     order by created_at asc`
  );

  return result.rows.map(mapProviderRow);
}

export async function createAiProvider(
  input: Omit<AiProvider, "id" | "createdAt" | "updatedAt">
): Promise<AiProvider> {
  const now = new Date().toISOString();
  const provider: AiProvider = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now
  };

  await getPool().query(
    `insert into ai_providers
      (id, name, kind, type, base_url, api_key_env, model, dimensions, config_json, enabled, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      provider.id,
      provider.name,
      provider.kind,
      provider.type,
      provider.baseUrl,
      provider.apiKeyEnv,
      provider.model,
      provider.dimensions ?? null,
      JSON.stringify({
        rateLimit: provider.rateLimit,
        timeoutSeconds: provider.timeoutSeconds
      }),
      provider.enabled,
      provider.createdAt,
      provider.updatedAt
    ]
  );

  return provider;
}

export async function getAiProvider(id: string): Promise<AiProvider | undefined> {
  const result = await getPool().query(
    `select id, name, kind, type, base_url, api_key_env, model, dimensions, config_json, enabled, created_at, updated_at
     from ai_providers
     where id = $1`,
    [id]
  );

  return result.rows[0] ? mapProviderRow(result.rows[0]) : undefined;
}

export async function updateAiProvider(
  id: string,
  patch: Partial<Pick<AiProvider, "enabled">>
): Promise<{ provider?: AiProvider; reason?: string }> {
  const provider = await getAiProvider(id);
  if (!provider) {
    return {};
  }

  if (patch.enabled === false) {
    const inUse = await findProfileUsingProvider(id);
    if (inUse) {
      return {
        reason: `该 AI 配置正在被发现配置「${inUse.name}」使用，请先修改发现配置的 AI 绑定。`
      };
    }
  }

  const enabled = patch.enabled ?? provider.enabled;
  const result = await getPool().query(
    `update ai_providers
     set enabled=$2, updated_at=now()
     where id=$1
     returning id, name, kind, type, base_url, api_key_env, model, dimensions, config_json, enabled, created_at, updated_at`,
    [id, enabled]
  );

  return { provider: result.rows[0] ? mapProviderRow(result.rows[0]) : undefined };
}

export async function deleteAiProvider(id: string): Promise<{
  deleted: boolean;
  reason?: string;
}> {
  const inUse = await findProfileUsingProvider(id);
  if (inUse) {
    return {
      deleted: false,
      reason: `该 AI 配置正在被发现配置「${inUse.name}」使用，不能删除。`
    };
  }

  await getPool().query(`delete from ai_providers where id=$1`, [id]);
  return { deleted: true };
}

export async function listScanJobs(): Promise<ScanJob[]> {
  const result = await getPool().query(
    `select ${JOB_SELECT_FIELDS}
     from discovery_jobs
     where archived_at is null
     order by created_at desc
     limit 100`
  );

  return result.rows.map(mapJobRow);
}

export async function getScanJob(jobId: string): Promise<ScanJob | undefined> {
  const result = await getPool().query(
    `select ${JOB_SELECT_FIELDS}
     from discovery_jobs
     where id = $1`,
    [jobId]
  );

  return result.rows[0] ? mapJobRow(result.rows[0]) : undefined;
}

export async function archiveScanJob(jobId: string): Promise<ScanJob | undefined> {
  const result = await getPool().query(
    `update discovery_jobs
     set archived_at=now()
     where id=$1
       and status in ('completed', 'failed')
       and archived_at is null
     returning ${JOB_SELECT_FIELDS}`,
    [jobId]
  );

  return result.rows[0] ? mapJobRow(result.rows[0]) : undefined;
}

export async function listRunnableScanJobs(limit = 1): Promise<ScanJob[]> {
  const result = await getPool().query(
    `select ${JOB_SELECT_FIELDS}
     from discovery_jobs
     where status in ('pending', 'running', 'throttled', 'retry_later', 'paused_by_memory', 'paused_by_runtime')
       and archived_at is null
     order by created_at asc
     limit $1`,
    [limit]
  );

  return result.rows.map(mapJobRow);
}

export async function findActiveScanJobByProfile(profileId: string): Promise<ScanJob | undefined> {
  const result = await getPool().query(
    `select ${JOB_SELECT_FIELDS}
     from discovery_jobs
     where profile_id=$1
       and status in ('pending', 'running', 'throttled', 'retry_later', 'paused_by_user', 'paused_by_memory', 'paused_by_runtime')
       and archived_at is null
     order by created_at desc
     limit 1`,
    [profileId]
  );

  return result.rows[0] ? mapJobRow(result.rows[0]) : undefined;
}

export async function getScheduleState(profileId: string) {
  const result = await getPool().query(
    `select last_checked_at, last_scheduled_at, last_job_id
     from scan_schedule_state
     where profile_id=$1`,
    [profileId]
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    lastCheckedAt: row.last_checked_at ? toIso(row.last_checked_at) : undefined,
    lastScheduledAt: row.last_scheduled_at ? toIso(row.last_scheduled_at) : undefined,
    lastJobId: row.last_job_id as string | undefined
  };
}

export async function touchScheduleState(input: {
  profileId: string;
  checkedAt: string;
  scheduledAt?: string;
  jobId?: string;
}) {
  await getPool().query(
    `insert into scan_schedule_state
      (profile_id, last_checked_at, last_scheduled_at, last_job_id, updated_at)
     values ($1,$2,$3,$4,now())
     on conflict (profile_id) do update set
       last_checked_at=excluded.last_checked_at,
       last_scheduled_at=coalesce(excluded.last_scheduled_at, scan_schedule_state.last_scheduled_at),
       last_job_id=coalesce(excluded.last_job_id, scan_schedule_state.last_job_id),
       updated_at=now()`,
    [input.profileId, input.checkedAt, input.scheduledAt ?? null, input.jobId ?? null]
  );
}

export async function createScanJob(
  profileId: string,
  type: ScanJob["type"] = "manual_scan"
): Promise<ScanJob> {
  const profile = (await listProfiles()).find((item) => item.id === profileId);
  const now = new Date().toISOString();
  const job: ScanJob = {
    id: crypto.randomUUID(),
    profileId,
    type,
    status: "pending",
    stage: "collect",
    maxCandidates: profile?.config.limits.maxCandidates ?? 0,
    fetchedCount: 0,
    processedCount: 0,
    analyzedCount: 0,
    newRepoCount: 0,
    updatedRepoCount: 0,
    unchangedRepoCount: 0,
    candidateCount: 0,
    createdAt: now
  };

  await getPool().query(
    `insert into discovery_jobs
      (id, profile_id, type, status, stage, max_candidates, fetched_count, processed_count,
       analyzed_count, new_repo_count, updated_repo_count, unchanged_repo_count, candidate_count, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      job.id,
      job.profileId,
      job.type,
      job.status,
      job.stage,
      job.maxCandidates,
      job.fetchedCount,
      job.processedCount,
      job.analyzedCount,
      job.newRepoCount,
      job.updatedRepoCount,
      job.unchangedRepoCount,
      job.candidateCount,
      job.createdAt
    ]
  );

  return job;
}

export async function updateScanJob(
  jobId: string,
  patch: Partial<ScanJob>
): Promise<ScanJob | undefined> {
  const current = await getPool().query(
    `select ${JOB_SELECT_FIELDS}
     from discovery_jobs
     where id = $1`,
    [jobId]
  );

  if (!current.rows[0]) {
    return undefined;
  }

  const job = {
    ...mapJobRow(current.rows[0]),
    ...patch
  };
  const hasErrorPatch = Object.prototype.hasOwnProperty.call(patch, "errorMessage");
  const hasStatusReasonPatch = Object.prototype.hasOwnProperty.call(patch, "statusReason");
  const nextErrorMessage =
    hasErrorPatch
      ? patch.errorMessage
      : hasStatusReasonPatch
        ? patch.statusReason
        : job.errorMessage;

  const updated = await getPool().query(
    `update discovery_jobs
     set status=$2, stage=$3, max_candidates=$4, fetched_count=$5, processed_count=$6,
         analyzed_count=$7, new_repo_count=$8, updated_repo_count=$9,
         unchanged_repo_count=$10, candidate_count=$11, started_at=$12,
         finished_at=$13, error_message=$14
     where id=$1
     returning ${JOB_SELECT_FIELDS}`,
    [
      job.id,
      job.status,
      job.stage,
      job.maxCandidates,
      job.fetchedCount,
      job.processedCount,
      job.analyzedCount,
      job.newRepoCount,
      job.updatedRepoCount,
      job.unchangedRepoCount,
      job.candidateCount,
      job.startedAt ?? null,
      job.finishedAt ?? null,
      nextErrorMessage ?? null
    ]
  );

  return updated.rows[0] ? mapJobRow(updated.rows[0]) : undefined;
}

export async function upsertRepos(
  repos: RepoSummary[],
  dataLevel: RepoDataLevel = "L1"
): Promise<UpsertRepoStats> {
  const pool = getPool();
  const stats: UpsertRepoStats = {
    newCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    repos: []
  };

  for (const repo of repos) {
    const existingRepoId = await resolvePersistedRepoId(repo);
    const repoId = existingRepoId ?? repo.id;
    const existingRepo = existingRepoId ? await getRepoWithDataLevel(existingRepoId) : undefined;
    const changed = existingRepo ? repoHasMaterialChanges(existingRepo.repo, repo) : true;
    const analysisDecision = shouldAnalyzeDiscoveredRepo({
      existing: existingRepo?.repo,
      existingDataLevel: existingRepo?.dataLevel,
      next: repo
    });
    const result = existingRepoId
      ? await pool.query(
        `update repos
         set github_id=coalesce($2, github_id),
             full_name=$3,
             owner=$4,
             name=$5,
             html_url=$6,
             description=$7,
             primary_language=$8,
             topics_json=$9,
             stars=$10,
             forks=$11,
             open_issues=$12,
             pushed_at=$13,
             updated_at=$14,
             archived=$15,
             fork=$16,
             data_level = case
               when data_level = 'L4' or $17 = 'L4' then 'L4'
               when data_level = 'L3' or $17 = 'L3' then 'L3'
               when data_level = 'L2' or $17 = 'L2' then 'L2'
               when data_level = 'L1' or $17 = 'L1' then 'L1'
               else 'L0'
             end,
             last_seen_at=now()
         where id=$1
         returning id`,
        [
          repoId,
          repo.githubId ?? null,
          repo.fullName,
          repo.owner,
          repo.name,
          repo.htmlUrl,
          repo.description,
          repo.primaryLanguage,
          JSON.stringify(repo.topics ?? []),
          repo.stars,
          repo.forks,
          repo.openIssues,
          repo.pushedAt,
          repo.updatedAt,
          repo.archived,
          repo.fork,
          dataLevel
        ]
      )
      : await pool.query(
        `insert into repos
        (id, github_id, full_name, owner, name, html_url, description, primary_language,
         topics_json, stars, forks, open_issues, pushed_at, updated_at, archived, fork, data_level,
         first_seen_at, last_seen_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now())
       on conflict (full_name) do update set
         github_id=excluded.github_id,
         owner=excluded.owner,
         name=excluded.name,
         html_url=excluded.html_url,
         description=excluded.description,
         primary_language=excluded.primary_language,
         topics_json=excluded.topics_json,
         stars=excluded.stars,
         forks=excluded.forks,
         open_issues=excluded.open_issues,
         pushed_at=excluded.pushed_at,
         updated_at=excluded.updated_at,
         archived=excluded.archived,
         fork=excluded.fork,
         data_level = case
           when repos.data_level = 'L4' or excluded.data_level = 'L4' then 'L4'
           when repos.data_level = 'L3' or excluded.data_level = 'L3' then 'L3'
           when repos.data_level = 'L2' or excluded.data_level = 'L2' then 'L2'
           when repos.data_level = 'L1' or excluded.data_level = 'L1' then 'L1'
           else 'L0'
         end,
         last_seen_at=now()
       returning id`,
        [
          repoId,
          repo.githubId ?? null,
          repo.fullName,
          repo.owner,
          repo.name,
          repo.htmlUrl,
          repo.description,
          repo.primaryLanguage,
          JSON.stringify(repo.topics ?? []),
          repo.stars,
          repo.forks,
          repo.openIssues,
          repo.pushedAt,
          repo.updatedAt,
          repo.archived,
          repo.fork,
          dataLevel
        ]
      );
    const persistedRepoId = result.rows[0]?.id as string | undefined;
    if (!persistedRepoId) {
      throw new Error(`Failed to persist repository ${repo.fullName}`);
    }

    repo.id = persistedRepoId;
    if (existingRepoId) {
      if (changed) {
        stats.updatedCount += 1;
      } else {
        stats.unchangedCount += 1;
      }
    } else {
      stats.newCount += 1;
    }
    stats.repos.push({
      repo,
      status: existingRepoId ? (changed ? "updated" : "unchanged") : "new",
      existingDataLevel: existingRepo?.dataLevel,
      shouldAnalyze: analysisDecision.shouldAnalyze,
      analyzeReason: analysisDecision.reason
    });

    await pool.query(
      `insert into repo_snapshots
        (id, repo_id, stars, forks, watchers, open_issues, pushed_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        crypto.randomUUID(),
        persistedRepoId,
        repo.stars,
        repo.forks,
        repo.stars,
        repo.openIssues,
        repo.pushedAt
      ]
    );
  }

  return stats;
}

async function resolvePersistedRepoId(
  repo: Pick<RepoSummary, "id" | "fullName" | "githubId">
): Promise<string | undefined> {
  const result = await getPool().query(
    `select id
     from repos
     where id=$1 or full_name=$2 or github_id=$3
     order by
       case
         when github_id=$3 then 0
         when id=$1 then 1
         else 2
       end
     limit 1`,
    [repo.id, repo.fullName, repo.githubId ?? null]
  );

  return result.rows[0]?.id as string | undefined;
}

export async function upsertRecommendations(
  recommendations: Recommendation[]
): Promise<void> {
  const pool = getPool();

  for (const recommendation of annotateRecommendationClusters(recommendations)) {
    const repoId = await resolvePersistedRepoId(recommendation.repo);
    if (!repoId) {
      await upsertRepos([recommendation.repo], "L3");
    }
    const persistedRepoId = repoId ?? recommendation.repo.id;

    const reasonsPayload = JSON.stringify({
      reasons: recommendation.reasons,
      risks: recommendation.risks,
      summary: recommendation.summary,
      summaryZh: recommendation.summaryZh ?? ensureChineseSummary(
        recommendation.summary,
        recommendation.repo,
        recommendation.matchedPreferences
      ),
      opportunity: recommendation.opportunity,
      matchedPreferences: recommendation.matchedPreferences,
      relatedUserRepos: recommendation.relatedUserRepos,
      cluster: recommendation.cluster,
      scores: recommendation.scores
    });

    await pool.query(
      `insert into repo_scores
        (id, repo_id, profile_id, rule_score, github_context_fit, llm_match_score,
         feedback_score, final_score, score_version, reasons_json, calculated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (id) do update set
         rule_score=excluded.rule_score,
         github_context_fit=excluded.github_context_fit,
         llm_match_score=excluded.llm_match_score,
         feedback_score=excluded.feedback_score,
         final_score=excluded.final_score,
         score_version=excluded.score_version,
         reasons_json=excluded.reasons_json,
         calculated_at=excluded.calculated_at`,
      [
        `score-${recommendation.id}`,
        persistedRepoId,
        recommendation.profileId,
        recommendation.scores.rule,
        recommendation.scores.githubContextFit,
        recommendation.scores.llmMatch,
        recommendation.scores.feedback,
        recommendation.scores.final,
        recommendation.scores.scoreVersion,
        reasonsPayload,
        recommendation.createdAt
      ]
    );

    await pool.query(
      `insert into recommendations
        (id, profile_id, repo_id, rank, final_score, reasons_json, status, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set
         rank=excluded.rank,
         final_score=excluded.final_score,
         reasons_json=excluded.reasons_json`,
      [
        recommendation.id,
        recommendation.profileId,
        persistedRepoId,
        recommendation.rank,
        recommendation.scores.final,
        reasonsPayload,
        recommendation.status,
        recommendation.createdAt
      ]
    );

    await upsertRepoContextMatches(
      persistedRepoId,
      recommendation.relatedUserRepos
    );
  }
}

async function upsertRepoContextMatches(
  candidateRepoId: string,
  relatedUserRepos: Recommendation["relatedUserRepos"]
) {
  const pool = getPool();
  const userRepoIds = relatedUserRepos
    .map((repo) => repo.userRepoId)
    .filter((id): id is string => Boolean(id));

  if (userRepoIds.length === 0) {
    await pool.query(`delete from repo_context_matches where candidate_repo_id=$1`, [
      candidateRepoId
    ]);
    return;
  }

  await pool.query(
    `delete from repo_context_matches
     where candidate_repo_id=$1
       and user_repo_id <> all($2::text[])`,
    [candidateRepoId, userRepoIds]
  );

  for (const repo of relatedUserRepos) {
    if (!repo.userRepoId) {
      continue;
    }

    await pool.query(
      `insert into repo_context_matches
        (id, candidate_repo_id, user_repo_id, match_score, match_reasons_json, calculated_at)
       values ($1,$2,$3,$4,$5,now())
       on conflict (candidate_repo_id, user_repo_id) do update set
         match_score=excluded.match_score,
         match_reasons_json=excluded.match_reasons_json,
         calculated_at=excluded.calculated_at`,
      [
        crypto.randomUUID(),
        candidateRepoId,
        repo.userRepoId,
        repo.score,
        JSON.stringify([repo.reason])
      ]
    );
  }
}

export async function enqueueCandidates(
  jobId: string,
  candidates: Array<{ repo: RepoSummary; priorityScore: number; stage?: string }>
): Promise<void> {
  const pool = getPool();

  for (const candidate of candidates) {
    let repoId = await resolvePersistedRepoId(candidate.repo);
    if (!repoId) {
      await upsertRepos([candidate.repo], "L1");
      repoId = candidate.repo.id;
    }

    await pool.query(
      `insert into candidate_queue
        (id, job_id, repo_id, priority_score, stage, status, attempts, queued_at, updated_at)
       values ($1,$2,$3,$4,$5,'pending',0,now(),now())
       on conflict (job_id, repo_id, stage) do update set
          priority_score=excluded.priority_score,
          status='pending',
          next_run_at=null,
          queued_at=now(),
          updated_at=now()`,
      [
        crypto.randomUUID(),
        jobId,
        repoId,
        candidate.priorityScore,
        candidate.stage ?? "profile"
      ]
    );
  }
}

export async function upgradeRepoDataLevel(
  repos: RepoSummary[],
  dataLevel: RepoDataLevel
): Promise<void> {
  const pool = getPool();

  for (const repo of repos) {
    const repoId = await resolvePersistedRepoId(repo);
    if (!repoId) {
      continue;
    }

    await pool.query(
      `update repos
       set data_level = case
         when data_level = 'L4' or $2 = 'L4' then 'L4'
         when data_level = 'L3' or $2 = 'L3' then 'L3'
         when data_level = 'L2' or $2 = 'L2' then 'L2'
         when data_level = 'L1' or $2 = 'L1' then 'L1'
         else 'L0'
       end,
       last_seen_at=now()
       where id=$1`,
      [repoId, dataLevel]
    );
    repo.id = repoId;
  }
}

export async function upsertScanCheckpoint(
  checkpoint: Omit<ScanCheckpoint, "id" | "updatedAt">
): Promise<ScanCheckpoint> {
  const id = crypto.randomUUID();
  const result = await getPool().query(
    `insert into scan_checkpoints
      (id, job_id, source, query_hash, page, cursor, processed_count, stage, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (job_id, source, query_hash, stage) do update set
       page=excluded.page,
       cursor=excluded.cursor,
       processed_count=excluded.processed_count,
       updated_at=now()
     returning id, job_id, source, query_hash, page, cursor, processed_count, stage, updated_at`,
    [
      id,
      checkpoint.jobId,
      checkpoint.source,
      checkpoint.queryHash,
      checkpoint.page,
      checkpoint.cursor ?? null,
      checkpoint.processedCount,
      checkpoint.stage
    ]
  );

  return mapCheckpointRow(result.rows[0]);
}

export async function getScanCheckpoint(
  jobId: string,
  source: string,
  queryHash: string,
  stage: string
): Promise<ScanCheckpoint | undefined> {
  const result = await getPool().query(
    `select id, job_id, source, query_hash, page, cursor, processed_count, stage, updated_at
     from scan_checkpoints
     where job_id=$1 and source=$2 and query_hash=$3 and stage=$4`,
    [jobId, source, queryHash, stage]
  );

  return result.rows[0] ? mapCheckpointRow(result.rows[0]) : undefined;
}

export async function listScanCheckpoints(jobId: string): Promise<ScanCheckpoint[]> {
  const result = await getPool().query(
    `select id, job_id, source, query_hash, page, cursor, processed_count, stage, updated_at
     from scan_checkpoints
     where job_id=$1
     order by updated_at desc`,
    [jobId]
  );

  return result.rows.map(mapCheckpointRow);
}

export async function upsertRepoDocument(input: RepoDocumentInput) {
  const result = await getPool().query(
    `insert into repo_documents
      (id, repo_id, type, source_url, content_hash, raw_content_compressed, summary, extracted_keywords_json, captured_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (repo_id, type, content_hash) do update set
       source_url=excluded.source_url,
       raw_content_compressed=excluded.raw_content_compressed,
       summary=excluded.summary,
       extracted_keywords_json=excluded.extracted_keywords_json,
       captured_at=now()
     returning id, repo_id, type, source_url, content_hash, summary, extracted_keywords_json, captured_at`,
    [
      crypto.randomUUID(),
      input.repoId,
      input.type,
      input.sourceUrl ?? null,
      input.contentHash,
      input.rawContent ? Buffer.from(input.rawContent, "utf8") : null,
      input.summary ?? null,
      JSON.stringify(input.extractedKeywords ?? [])
    ]
  );

  return result.rows[0];
}

export async function getLatestRepoDocument(repoId: string, type: string) {
  const result = await getPool().query(
    `select id, repo_id, type, source_url, content_hash, raw_content_compressed, summary, extracted_keywords_json, captured_at
     from repo_documents
     where repo_id=$1 and type=$2
     order by captured_at desc
     limit 1`,
    [repoId, type]
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    id: row.id as string,
    repoId: row.repo_id as string,
    type: row.type as string,
    sourceUrl: row.source_url as string | undefined,
    contentHash: row.content_hash as string,
    rawContent: row.raw_content_compressed
      ? Buffer.from(row.raw_content_compressed).toString("utf8")
      : "",
    summary: row.summary as string | undefined,
    extractedKeywords: normalizeJsonArray(row.extracted_keywords_json),
    capturedAt: toIso(row.captured_at)
  };
}

export async function upsertRepoEmbedding(input: {
  repoId: string;
  providerId: string;
  model: string;
  dimensions: number;
  contentHash: string;
  vector: number[];
}) {
  await getPool().query(
    `insert into repo_embeddings
      (id, repo_id, provider_id, model, dimensions, content_hash, vector, created_at)
     values ($1,$2,$3,$4,$5,$6,$7::vector,now())
     on conflict (repo_id, provider_id, content_hash) do update set
       model=excluded.model,
       dimensions=excluded.dimensions,
       vector=excluded.vector,
       created_at=now()`,
    [
      crypto.randomUUID(),
      input.repoId,
      input.providerId,
      input.model,
      input.dimensions,
      input.contentHash,
      `[${input.vector.join(",")}]`
    ]
  );
}

export async function getRepoEmbedding(input: {
  repoId: string;
  providerId: string;
  model: string;
  contentHash: string;
}) {
  const result = await getPool().query(
    `select id, repo_id, provider_id, model, dimensions, content_hash, created_at
     from repo_embeddings
     where repo_id=$1 and provider_id=$2 and model=$3 and content_hash=$4
     order by created_at desc
     limit 1`,
    [input.repoId, input.providerId, input.model, input.contentHash]
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    id: row.id as string,
    repoId: row.repo_id as string,
    providerId: row.provider_id as string,
    model: row.model as string,
    dimensions: Number(row.dimensions),
    contentHash: row.content_hash as string,
    createdAt: toIso(row.created_at)
  };
}

export async function getRepoEmbeddingVector(input: {
  repoId: string;
  providerId: string;
  model?: string;
  contentHash?: string;
}) {
  const conditions = ["repo_id=$1", "provider_id=$2"];
  const values: unknown[] = [input.repoId, input.providerId];

  if (input.model) {
    values.push(input.model);
    conditions.push(`model=$${values.length}`);
  }
  if (input.contentHash) {
    values.push(input.contentHash);
    conditions.push(`content_hash=$${values.length}`);
  }

  const result = await getPool().query(
    `select id, repo_id, provider_id, model, dimensions, content_hash, vector, created_at
     from repo_embeddings
     where ${conditions.join(" and ")}
     order by created_at desc
     limit 1`,
    values
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    id: row.id as string,
    repoId: row.repo_id as string,
    providerId: row.provider_id as string,
    model: row.model as string,
    dimensions: Number(row.dimensions),
    contentHash: row.content_hash as string,
    vector: parseVector(row.vector),
    createdAt: toIso(row.created_at)
  };
}

export async function upsertCachedEmbedding(input: {
  cacheKey: string;
  providerId: string;
  model: string;
  dimensions: number;
  contentHash: string;
  vector: number[];
}) {
  await getPool().query(
    `insert into embedding_cache
      (id, cache_key, provider_id, model, dimensions, content_hash, vector, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,now())
     on conflict (cache_key) do update set
       provider_id=excluded.provider_id,
       model=excluded.model,
       dimensions=excluded.dimensions,
       content_hash=excluded.content_hash,
       vector=excluded.vector,
       created_at=now()`,
    [
      crypto.randomUUID(),
      input.cacheKey,
      input.providerId,
      input.model,
      input.dimensions,
      input.contentHash,
      toVector(input.vector)
    ]
  );
}

export async function getCachedEmbedding(input: {
  cacheKey: string;
  providerId: string;
  model: string;
  contentHash: string;
}): Promise<CachedEmbedding | undefined> {
  const result = await getPool().query(
    `select provider_id, model, dimensions, content_hash, vector, created_at
     from embedding_cache
     where cache_key=$1 and provider_id=$2 and model=$3 and content_hash=$4`,
    [input.cacheKey, input.providerId, input.model, input.contentHash]
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    providerId: row.provider_id,
    model: row.model,
    dimensions: Number(row.dimensions),
    contentHash: row.content_hash,
    vector: parseVector(row.vector),
    createdAt: toIso(row.created_at)
  };
}

export async function getRepoEmbeddingSimilarity(input: {
  repoId: string;
  providerId: string;
  queryVector: number[];
}) {
  const result = await getPool().query(
    `select 1 - (vector <=> $3::vector) as similarity
     from repo_embeddings
     where repo_id=$1 and provider_id=$2
     order by created_at desc
     limit 1`,
    [input.repoId, input.providerId, `[${input.queryVector.join(",")}]`]
  );

  return result.rows[0]?.similarity === undefined
    ? undefined
    : Number(result.rows[0].similarity);
}

export async function rerankRecommendationsWithSemanticFit(input: {
  profileId: string;
  providerId: string;
  queryVector: number[];
}) {
  const recommendations = await listRecommendations();
  const target = recommendations.filter((item) => item.profileId === input.profileId);
  const reranked = [];

  for (const recommendation of target) {
    const similarity = await getRepoEmbeddingSimilarity({
      repoId: recommendation.repo.id,
      providerId: input.providerId,
      queryVector: input.queryVector
    });
    const semanticFit =
      similarity === undefined
        ? recommendation.scores.githubContextFit
        : Math.max(0, Math.min(1, similarity));

    const scores = {
      ...recommendation.scores,
      githubContextFit: Math.max(recommendation.scores.githubContextFit, semanticFit)
    };
    scores.final = calculateFinalScore({
      ruleScore: scores.rule,
      githubContextFit: scores.githubContextFit,
      llmMatchScore: scores.llmMatch,
      feedbackScore: scores.feedback,
      opportunityScore: scores.opportunity,
      monetizationScore: scores.monetization,
      growthSignal: scores.growth,
      executionFit: scores.execution,
      differentiationSpace: scores.differentiation,
      technicalQuality: scores.technicalQuality
    });

    reranked.push({
      ...recommendation,
      scores
    });
  }

  reranked.sort((a, b) => b.scores.final - a.scores.final);
  await upsertRecommendations(
    reranked.map((recommendation, index) => ({
      ...recommendation,
      rank: index + 1
    }))
  );
}

export async function createLlmJob(input: {
  repoId: string;
  jobType: string;
  status: string;
  inputHash: string;
  providerId: string;
  model: string;
  promptVersion: string;
}) {
  const id = crypto.randomUUID();
  await getPool().query(
    `insert into llm_jobs
      (id, repo_id, job_type, status, input_hash, provider_id, model, prompt_version, attempts, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,1,now())`,
    [
      id,
      input.repoId,
      input.jobType,
      input.status,
      input.inputHash,
      input.providerId,
      input.model,
      input.promptVersion
    ]
  );

  return id;
}

export async function finishLlmJob(
  id: string,
  status: string,
  tokenUsage: Record<string, unknown> = {}
) {
  await getPool().query(
    `update llm_jobs
     set status=$2, token_usage_json=$3, finished_at=now()
     where id=$1`,
    [id, status, JSON.stringify(tokenUsage)]
  );
}

export async function getOperationsSnapshot(): Promise<OperationsSnapshot> {
  const [resourceEvents, aiJobs] = await Promise.all([
    listRecentResourceEvents(),
    listAiJobMetrics()
  ]);
  const aiCostSummary = aiJobs.reduce(
    (summary, job) => ({
      totalJobs: summary.totalJobs + 1,
      totalTokens: summary.totalTokens + job.totalTokens,
      estimatedCostUsd: summary.estimatedCostUsd + job.estimatedCostUsd
    }),
    { totalJobs: 0, totalTokens: 0, estimatedCostUsd: 0 }
  );

  return {
    resourceEvents,
    aiJobs,
    aiCostSummary
  };
}

export async function upsertLlmResult(input: LlmResultInput) {
  await getPool().query(
    `insert into llm_results
      (id, repo_id, provider_id, model, job_type, prompt_version, input_hash, structured_json, raw_response_compressed, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
    [
      crypto.randomUUID(),
      input.repoId,
      input.providerId,
      input.model,
      input.jobType,
      input.promptVersion,
      input.inputHash ?? null,
      JSON.stringify(input.structured),
      input.rawResponse ? Buffer.from(input.rawResponse, "utf8") : null
    ]
  );
}

export async function getLatestLlmResult(
  repoId: string,
  jobType: string,
  options: {
    providerId?: string;
    model?: string;
    promptVersion?: string;
    inputHash?: string;
  } = {}
) {
  const conditions = ["repo_id=$1", "job_type=$2"];
  const values: unknown[] = [repoId, jobType];

  if (options.providerId) {
    values.push(options.providerId);
    conditions.push(`provider_id=$${values.length}`);
  }
  if (options.model) {
    values.push(options.model);
    conditions.push(`model=$${values.length}`);
  }
  if (options.promptVersion) {
    values.push(options.promptVersion);
    conditions.push(`prompt_version=$${values.length}`);
  }
  if (options.inputHash) {
    values.push(options.inputHash);
    conditions.push(`input_hash=$${values.length}`);
  }

  const result = await getPool().query(
    `select structured_json
     from llm_results
     where ${conditions.join(" and ")}
     order by created_at desc
     limit 1`,
    values
  );

  return result.rows[0]?.structured_json as Record<string, unknown> | undefined;
}

export async function listRecommendations(): Promise<Recommendation[]> {
  await ensureSeedDataOnce();
  const result = await getPool().query(
    `select
       rec.id, rec.profile_id, rec.rank, rec.final_score, rec.reasons_json, rec.status, rec.created_at,
       repo.id as repo_id, repo.github_id, repo.full_name, repo.owner, repo.name, repo.html_url,
       repo.description, repo.primary_language, repo.topics_json, repo.stars, repo.forks,
       repo.open_issues, repo.pushed_at, repo.updated_at, repo.archived, repo.fork,
       score.rule_score, score.github_context_fit, score.llm_match_score, score.feedback_score,
       score.score_version,
       coalesce(context_matches.matches_json, '[]'::jsonb) as context_matches_json
     from recommendations rec
     join repos repo on repo.id = rec.repo_id
     left join repo_scores score on score.id = concat('score-', rec.id)
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'userRepoId', user_repo.id,
           'fullName', user_repo.full_name,
           'reason', coalesce(match.match_reasons_json->>0, '与当前发现偏好存在关联。'),
           'score', match.match_score
         )
         order by match.match_score desc, user_repo.full_name asc
       ) as matches_json
       from repo_context_matches match
       join user_repos user_repo on user_repo.id = match.user_repo_id
       where match.candidate_repo_id = repo.id
     ) context_matches on true
     order by rec.final_score desc, rec.rank asc
     limit 100`
  );

  return result.rows.map(mapRecommendationRow);
}

export async function recordFeedback(
  repoId: string,
  profileId: string,
  action: FeedbackAction,
  note?: string
): Promise<Feedback> {
  const feedback: Feedback = {
    id: crypto.randomUUID(),
    repoId,
    profileId,
    action,
    note,
    createdAt: new Date().toISOString()
  };

  await getPool().query(
    `insert into feedback (id, repo_id, profile_id, action, note, created_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [feedback.id, repoId, profileId, action, note ?? null, feedback.createdAt]
  );

  const status =
    action === "save"
      ? "saved"
      : action === "hide"
        ? "hidden"
        : action === "restore"
          ? "viewed"
          : action === "track"
            ? "tracked"
            : action === "to_validate"
              ? "to_validate"
              : action === "validating"
                ? "validating"
                : action === "monetization_ready"
                  ? "monetization_ready"
                  : action === "abandon"
                    ? "abandoned"
                    : null;

  if (status) {
    await getPool().query(
      `update recommendations set status=$3 where repo_id=$1 and profile_id=$2`,
      [repoId, profileId, status]
    );
  }

  const repo = await getRepoById(repoId);
  if (repo) {
    await upsertPreferenceSignals(buildPreferenceSignals(repo, profileId, action));
  }

  return feedback;
}

export async function getRepoById(repoId: string): Promise<RepoSummary | undefined> {
  const row = await getRepoWithDataLevel(repoId);
  return row?.repo;
}

async function getRepoWithDataLevel(repoId: string): Promise<
  { repo: RepoSummary; dataLevel: RepoDataLevel } | undefined
> {
  const result = await getPool().query(
    `select id as repo_id, github_id, full_name, owner, name, html_url, description, primary_language,
            topics_json, stars, forks, open_issues, pushed_at, updated_at, archived, fork, data_level
     from repos
     where id=$1`,
    [repoId]
  );

  return result.rows[0]
    ? {
        repo: mapRepoRow(result.rows[0]),
        dataLevel: result.rows[0].data_level
      }
    : undefined;
}

export async function upsertPreferenceSignals(
  signals: Array<Omit<PreferenceSignal, "id" | "updatedAt">>
) {
  for (const signal of signals) {
    await getPool().query(
      `insert into preference_signals
        (id, profile_id, signal_type, value, weight, source, updated_at)
       values ($1,$2,$3,$4,$5,$6,now())
       on conflict (profile_id, signal_type, value, source) do update set
         weight = greatest(-1, least(1, preference_signals.weight + excluded.weight)),
         updated_at=now()`,
      [
        crypto.randomUUID(),
        signal.profileId,
        signal.signalType,
        signal.value,
        signal.weight,
        signal.source
      ]
    );
  }
}

export async function listPreferenceSignals(profileId: string): Promise<PreferenceSignal[]> {
  const result = await getPool().query(
    `select id, profile_id, signal_type, value, weight, source, updated_at
     from preference_signals
     where profile_id=$1
     order by updated_at desc`,
    [profileId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    profileId: row.profile_id,
    signalType: row.signal_type,
    value: row.value,
    weight: Number(row.weight),
    source: row.source,
    updatedAt: toIso(row.updated_at)
  }));
}

export async function listGithubRepos(): Promise<UserGitHubRepo[]> {
  const result = await getPool().query(
    `select id, github_account_id, github_id, full_name, description, primary_language, topics_json, visibility,
            readme_summary, selected_for_context, last_synced_at
     from user_repos
     order by full_name asc`
  );

  return result.rows.map((row) => ({
    id: row.id,
    githubAccountId: row.github_account_id ?? undefined,
    githubId: row.github_id ? Number(row.github_id) : undefined,
    fullName: row.full_name,
    description: row.description ?? "",
    primaryLanguage: row.primary_language ?? "Unknown",
    topics: normalizeJsonArray(row.topics_json),
    visibility: row.visibility,
    readmeSummary: row.readme_summary ?? undefined,
    selectedForContext: row.selected_for_context,
    lastSyncedAt: row.last_synced_at ? toIso(row.last_synced_at) : undefined
  }));
}

export async function updateGithubRepoContext(
  id: string,
  patch: Pick<UserGitHubRepo, "selectedForContext">
): Promise<UserGitHubRepo | undefined> {
  const result = await getPool().query(
    `update user_repos
     set selected_for_context=$2
     where id=$1
     returning id, full_name, description, primary_language, topics_json, visibility,
       readme_summary, selected_for_context, last_synced_at`,
    [id, patch.selectedForContext]
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    id: row.id,
    githubAccountId: row.github_account_id ?? undefined,
    githubId: row.github_id ? Number(row.github_id) : undefined,
    fullName: row.full_name,
    description: row.description ?? "",
    primaryLanguage: row.primary_language ?? "Unknown",
    topics: normalizeJsonArray(row.topics_json),
    visibility: row.visibility,
    readmeSummary: row.readme_summary ?? undefined,
    selectedForContext: row.selected_for_context,
    lastSyncedAt: row.last_synced_at ? toIso(row.last_synced_at) : undefined
  };
}

export async function listGithubAccounts() {
  const result = await getPool().query(
    `select id, username, token_ref, connected_at, last_synced_at
     from github_accounts
     order by connected_at desc`
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    username: row.username as string,
    tokenRef: row.token_ref ?? undefined,
    connectedAt: toIso(row.connected_at),
    lastSyncedAt: row.last_synced_at ? toIso(row.last_synced_at) : undefined
  }));
}

export async function upsertGithubAccount(input: {
  username: string;
  tokenRef?: string;
}) {
  const result = await getPool().query(
    `insert into github_accounts (id, username, token_ref, connected_at, last_synced_at)
     values ($1,$2,$3,now(),now())
     on conflict (username) do update set
       token_ref=excluded.token_ref,
       last_synced_at=now()
     returning id, username, token_ref, connected_at, last_synced_at`,
    [crypto.randomUUID(), input.username, input.tokenRef ?? null]
  );

  const row = result.rows[0];
  return {
    id: row.id as string,
    username: row.username as string,
    tokenRef: row.token_ref ?? undefined,
    connectedAt: toIso(row.connected_at),
    lastSyncedAt: row.last_synced_at ? toIso(row.last_synced_at) : undefined
  };
}

export async function replaceUserRepos(
  githubAccountId: string,
  repos: UserGitHubRepo[]
) {
  const pool = getPool();
  await pool.query(`delete from user_repos where github_account_id=$1`, [githubAccountId]);
  for (const repo of repos) {
    await pool.query(
      `insert into user_repos
        (id, github_account_id, github_id, full_name, description, primary_language, topics_json,
         visibility, readme_summary, dependencies_json, selected_for_context, last_synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
      [
        repo.id,
        githubAccountId,
        repo.githubId ?? null,
        repo.fullName,
        repo.description,
        repo.primaryLanguage,
        JSON.stringify(repo.topics ?? []),
        repo.visibility,
        repo.readmeSummary ?? null,
        JSON.stringify({}),
        repo.selectedForContext
      ]
    );
  }
}

export async function listKnowledgeSyncs(): Promise<KnowledgeSync[]> {
  const result = await getPool().query(
    `select
       sync.id, sync.repo_id, repo.full_name, sync.target, sync.dataset_id,
       sync.external_doc_id, sync.content_hash, sync.status, sync.synced_at,
       sync.error_message
     from knowledge_syncs sync
     join repos repo on repo.id = sync.repo_id
     order by coalesce(sync.synced_at, now()) desc, repo.full_name asc
     limit 200`
  );

  return result.rows.map(mapKnowledgeSyncRow);
}

export async function upsertKnowledgeSync(input: {
  repoId: string;
  target: string;
  datasetId?: string;
  externalDocId?: string;
  contentHash: string;
  status: KnowledgeSync["status"];
  syncedAt?: string;
  errorMessage?: string;
}): Promise<KnowledgeSync> {
  const result = await getPool().query(
    `insert into knowledge_syncs
      (id, repo_id, target, dataset_id, external_doc_id, content_hash, status, synced_at, error_message)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (repo_id, target, dataset_id, content_hash) do update set
       external_doc_id=excluded.external_doc_id,
       status=excluded.status,
       synced_at=excluded.synced_at,
       error_message=excluded.error_message
     returning id, repo_id, target, dataset_id, external_doc_id, content_hash, status, synced_at, error_message`,
    [
      crypto.randomUUID(),
      input.repoId,
      input.target,
      input.datasetId ?? null,
      input.externalDocId ?? null,
      input.contentHash,
      input.status,
      input.syncedAt ?? null,
      input.errorMessage ?? null
    ]
  );

  const row = result.rows[0];
  const repo = await getRepoById(row.repo_id);
  return mapKnowledgeSyncRow({ ...row, full_name: repo?.fullName });
}

export async function getQueueStats() {
  const result = await getPool().query(
    `select stage, status, count(*)::int as count
     from candidate_queue
     group by stage, status
     order by stage asc, status asc`
  );

  return result.rows.map((row) => ({
    stage: row.stage,
    status: row.status,
    count: Number(row.count)
  }));
}

export async function claimCandidateBatch(stage = "profile", limit = 10) {
  const result = await getPool().query(
    `with picked as (
       select id
       from candidate_queue
       where stage = $1
         and status = 'pending'
         and (next_run_at is null or next_run_at <= now())
       order by priority_score desc, queued_at asc
       limit $2
       for update skip locked
     )
     update candidate_queue q
     set status = 'running',
        attempts = attempts + 1,
        updated_at = now()
     from picked
     where q.id = picked.id
     returning q.id, q.job_id, q.repo_id, q.priority_score, q.stage, q.status, q.attempts`,
    [stage, limit]
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    jobId: row.job_id as string,
    repoId: row.repo_id as string,
    priorityScore: Number(row.priority_score),
    stage: row.stage as string,
    status: row.status as string,
    attempts: Number(row.attempts)
  }));
}

export async function getQueuedRepoBatch(
  jobId: string,
  stage = "profile",
  status = "pending",
  limit = 10
): Promise<Array<{ queueId: string; priorityScore: number; repo: RepoSummary }>> {
  const result = await getPool().query(
    `select
       q.id as queue_id, q.priority_score,
       repo.id as repo_id, repo.github_id, repo.full_name, repo.owner, repo.name, repo.html_url,
       repo.description, repo.primary_language, repo.topics_json, repo.stars, repo.forks,
       repo.open_issues, repo.pushed_at, repo.updated_at, repo.archived, repo.fork
     from candidate_queue q
     join repos repo on repo.id = q.repo_id
     where q.job_id=$1 and q.stage=$2 and q.status=$3
     order by q.priority_score desc, q.queued_at asc
     limit $4`,
    [jobId, stage, status, limit]
  );

  return result.rows.map((row) => ({
    queueId: row.queue_id as string,
    priorityScore: Number(row.priority_score),
    repo: mapRepoRow(row)
  }));
}

export async function claimQueuedRepoBatch(
  jobId: string,
  stage = "profile",
  limit = 10
): Promise<Array<{ queueId: string; priorityScore: number; attempts: number; repo: RepoSummary }>> {
  const result = await getPool().query(
    `with picked as (
       select id
       from candidate_queue
       where job_id=$1
         and stage=$2
         and status='pending'
         and (next_run_at is null or next_run_at <= now())
       order by priority_score desc, queued_at asc
       limit $3
       for update skip locked
     ),
     updated as (
       update candidate_queue q
        set status='running',
            attempts=attempts + 1,
            updated_at=now()
       from picked
       where q.id = picked.id
       returning q.id, q.repo_id, q.priority_score, q.attempts
     )
     select
       updated.id as queue_id, updated.priority_score, updated.attempts,
       repo.id as repo_id, repo.github_id, repo.full_name, repo.owner, repo.name, repo.html_url,
       repo.description, repo.primary_language, repo.topics_json, repo.stars, repo.forks,
       repo.open_issues, repo.pushed_at, repo.updated_at, repo.archived, repo.fork
     from updated
     join repos repo on repo.id = updated.repo_id
     order by updated.priority_score desc`,
    [jobId, stage, limit]
  );

  return result.rows.map((row) => ({
    queueId: row.queue_id as string,
    priorityScore: Number(row.priority_score),
    attempts: Number(row.attempts),
    repo: mapRepoRow(row)
  }));
}

export async function requeueRunningCandidates(jobId: string, stage?: string) {
  const values: unknown[] = [jobId];
  const stageSql = stage ? "and stage=$2" : "";
  if (stage) {
    values.push(stage);
  }

  await getPool().query(
    `update candidate_queue
     set status='pending',
         next_run_at=now(),
         updated_at=now()
     where job_id=$1
       ${stageSql}
       and status='running'`,
    values
  );
}

export async function requeueStaleRunningCandidates(staleAfterMinutes = 5): Promise<
  Array<{ jobId: string; stage: string; count: number; total: number }>
> {
  const runningCandidates = await getPool().query(
    `select job_id, stage, count(*)::int as count
     from candidate_queue
     where status='running'
     group by job_id, stage`
  );

  const result = await getPool().query(
    `update candidate_queue
     set status='pending',
         next_run_at=now(),
         updated_at=now()
     where status='running'
     returning job_id, stage`
  );

  const countByStage = new Map<string, number>();
  for (const row of runningCandidates.rows) {
    countByStage.set(`${row.job_id}:${row.stage}`, Number(row.count));
  }

  const recovered = new Map<string, number>();
  for (const row of result.rows) {
    const key = `${row.job_id}:${row.stage}`;
    recovered.set(key, (recovered.get(key) ?? 0) + 1);
  }

  return [...recovered.entries()].map(([key, count]) => {
    const [jobId, stage] = key.split(":");
    return {
      jobId,
      stage,
      count,
      total: countByStage.get(key) ?? count
    };
  });
}

export async function failCandidate(
  id: string,
  reason: string,
  retryAfterSeconds?: number
) {
  const nextRunAt =
    retryAfterSeconds && retryAfterSeconds > 0
      ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
      : null;

  await getPool().query(
    `update candidate_queue
     set status='failed',
         next_run_at=$2,
         updated_at=now()
     where id=$1`,
    [id, nextRunAt]
  );

  void reason;
}

export async function retryCandidate(id: string, retryAfterSeconds: number) {
  const nextRunAt = new Date(Date.now() + Math.max(1, retryAfterSeconds) * 1000).toISOString();

  await getPool().query(
    `update candidate_queue
     set status='pending',
         next_run_at=$2,
         updated_at=now()
     where id=$1`,
    [id, nextRunAt]
  );
}

export async function getJobQueueCount(jobId: string, stage?: string, status?: string) {
  const conditions = ["job_id=$1"];
  const values: unknown[] = [jobId];

  if (stage) {
    values.push(stage);
    conditions.push(`stage=$${values.length}`);
  }
  if (status) {
    values.push(status);
    conditions.push(`status=$${values.length}`);
  }

  const result = await getPool().query(
    `select count(*)::int as count from candidate_queue where ${conditions.join(" and ")}`,
    values
  );

  return Number(result.rows[0]?.count ?? 0);
}

export async function completeCandidate(id: string) {
  await getPool().query(
    `update candidate_queue set status='done', updated_at=now() where id=$1`,
    [id]
  );
}

export async function trimRecommendations(profileId: string, limit: number) {
  await getPool().query(
    `with ranked as (
       select id, row_number() over (order by final_score desc, rank asc, created_at asc) as next_rank
       from recommendations
       where profile_id=$1
     ),
     updated as (
       update recommendations rec
       set rank = ranked.next_rank
       from ranked
       where rec.id = ranked.id
       returning rec.id, rec.rank
     )
     delete from recommendations
     where profile_id=$1
       and id in (select id from updated where rank > $2)`,
    [profileId, limit]
  );
}

export async function recordResourceEvent(
  event: Omit<ResourceEvent, "id" | "createdAt">
): Promise<ResourceEvent> {
  const result = await getPool().query(
    `insert into resource_events
      (id, job_id, stage, status, available_mb, rss_mb, heap_used_mb, total_mb, batch_size, reason, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     returning id, job_id, stage, status, available_mb, rss_mb, heap_used_mb, total_mb, batch_size, reason, created_at`,
    [
      crypto.randomUUID(),
      event.jobId,
      event.stage,
      event.status,
      event.availableMb,
      event.rssMb,
      event.heapUsedMb,
      event.totalMb,
      event.batchSize,
      event.reason
    ]
  );

  return mapResourceEventRow(result.rows[0]);
}

async function listRecentResourceEvents(limit = 80): Promise<ResourceEvent[]> {
  const result = await getPool().query(
    `select id, job_id, stage, status, available_mb, rss_mb, heap_used_mb, total_mb,
            batch_size, reason, created_at
     from resource_events
     order by created_at desc
     limit $1`,
    [limit]
  );

  return result.rows.map(mapResourceEventRow);
}

async function listAiJobMetrics(limit = 80): Promise<OperationsSnapshot["aiJobs"]> {
  const result = await getPool().query(
    `select
       job.id, job.repo_id, repo.full_name, job.provider_id, provider.name as provider_name,
       provider.config_json, job.model, job.job_type, job.status, job.prompt_version,
       job.attempts, job.token_usage_json, job.created_at, job.finished_at
     from llm_jobs job
     left join repos repo on repo.id = job.repo_id
     left join ai_providers provider on provider.id = job.provider_id
     order by job.created_at desc
     limit $1`,
    [limit]
  );

  return result.rows.map((row) => {
    const tokenUsage = normalizeJsonObject(row.token_usage_json);
    const providerConfig = normalizeJsonObject(row.config_json);
    const promptTokens = Number(tokenUsage.prompt_tokens ?? tokenUsage.promptTokens ?? 0);
    const completionTokens = Number(tokenUsage.completion_tokens ?? tokenUsage.completionTokens ?? 0);
    const totalTokens = Number(tokenUsage.total_tokens ?? tokenUsage.totalTokens ?? promptTokens + completionTokens);

    return {
      id: row.id,
      repoId: row.repo_id,
      repoFullName: row.full_name ?? undefined,
      providerId: row.provider_id,
      providerName: row.provider_name ?? undefined,
      model: row.model,
      jobType: row.job_type,
      status: row.status,
      promptVersion: row.prompt_version,
      attempts: Number(row.attempts ?? 0),
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd: estimateAiJobCostUsd(providerConfig, promptTokens, completionTokens),
      createdAt: toIso(row.created_at),
      finishedAt: row.finished_at ? toIso(row.finished_at) : undefined
    };
  });
}

function estimateAiJobCostUsd(
  providerConfig: Record<string, unknown>,
  promptTokens: number,
  completionTokens: number
) {
  const pricing = normalizeJsonObject(providerConfig.pricing);
  const inputPerMillion = Number(pricing.inputPerMillionTokens ?? 0);
  const outputPerMillion = Number(pricing.outputPerMillionTokens ?? 0);
  return (promptTokens / 1_000_000) * inputPerMillion + (completionTokens / 1_000_000) * outputPerMillion;
}

let seedPromise: Promise<void> | null = null;

async function ensureSeedDataOnce() {
  if (!seedPromise) {
    seedPromise = ensureSeedData();
  }

  await seedPromise;
}

async function markSeedDataInitialized(
  insertedDemoData: boolean,
  queryRunner: QueryRunner = getPool()
) {
  await queryRunner.query(
    `insert into app_state (key, value_json, updated_at)
     values ('seed_data_initialized', $1, now())
     on conflict (key) do update set value_json=excluded.value_json, updated_at=now()`,
    [
      JSON.stringify({
        insertedDemoData,
        version: 1
      })
    ]
  );
}

async function findProfileUsingProvider(id: string): Promise<{ id: string; name: string } | null> {
  const inUse = await getPool().query(
    `select id, name
     from discovery_profiles
     where config_json #>> '{ai,chatProviderId}' = $1
        or config_json #>> '{ai,embeddingProviderId}' = $1
     limit 1`,
    [id]
  );

  return inUse.rows[0] ? { id: inUse.rows[0].id, name: inUse.rows[0].name } : null;
}

function mapProviderRow(row: Record<string, any>): AiProvider {
  const config = normalizeJsonObject(row.config_json);

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    type: row.type,
    baseUrl: row.base_url,
    apiKeyEnv: row.api_key_env,
    model: row.model,
    dimensions: row.dimensions ?? undefined,
    enabled: row.enabled,
    rateLimit: config.rateLimit as AiProvider["rateLimit"],
    timeoutSeconds: config.timeoutSeconds as number | undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function normalizeProfileConfig(config: DiscoveryProfile["config"]): DiscoveryProfile["config"] {
  return {
    ...config,
    limits: normalizeDiscoveryLimits(config.limits),
    opportunity: normalizeOpportunityProfile(config.opportunity),
    sources: normalizeDiscoverySources(config.sources)
  };
}

function mapJobRow(row: Record<string, any>): ScanJob {
  return {
    id: row.id,
    profileId: row.profile_id,
    type: row.type,
    status: row.status,
    stage: row.stage,
    maxCandidates: row.max_candidates,
    fetchedCount: row.fetched_count,
    processedCount: row.processed_count,
    analyzedCount: row.analyzed_count,
    newRepoCount: Number(row.new_repo_count ?? 0),
    updatedRepoCount: Number(row.updated_repo_count ?? 0),
    unchangedRepoCount: Number(row.unchanged_repo_count ?? 0),
    candidateCount: Number(row.candidate_count ?? 0),
    statusReason: row.error_message ?? undefined,
    startedAt: row.started_at ? toIso(row.started_at) : undefined,
    finishedAt: row.finished_at ? toIso(row.finished_at) : undefined,
    errorMessage: row.error_message ?? undefined,
    archivedAt: row.archived_at ? toIso(row.archived_at) : undefined,
    createdAt: toIso(row.created_at)
  };
}

function mapCheckpointRow(row: Record<string, any>): ScanCheckpoint {
  return {
    id: row.id,
    jobId: row.job_id,
    source: row.source,
    queryHash: row.query_hash,
    page: Number(row.page ?? 0),
    cursor: row.cursor ?? undefined,
    processedCount: Number(row.processed_count ?? 0),
    stage: row.stage,
    updatedAt: toIso(row.updated_at)
  };
}

function mapResourceEventRow(row: Record<string, any>): ResourceEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    stage: row.stage,
    status: row.status,
    availableMb: Number(row.available_mb),
    rssMb: Number(row.rss_mb),
    heapUsedMb: Number(row.heap_used_mb),
    totalMb: Number(row.total_mb),
    batchSize: Number(row.batch_size),
    reason: row.reason,
    createdAt: toIso(row.created_at)
  };
}

function mapRepoRow(row: Record<string, any>): RepoSummary {
  return {
    id: row.repo_id ?? row.id,
    githubId: row.github_id ? Number(row.github_id) : undefined,
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    htmlUrl: row.html_url,
    description: row.description ?? "",
    primaryLanguage: row.primary_language ?? "Unknown",
    topics: normalizeJsonArray(row.topics_json),
    stars: row.stars,
    forks: row.forks,
    openIssues: row.open_issues,
    pushedAt: row.pushed_at ? toIso(row.pushed_at) : "",
    updatedAt: row.updated_at ? toIso(row.updated_at) : "",
    archived: row.archived,
    fork: row.fork
  };
}

function mapRecommendationRow(row: Record<string, any>): Recommendation {
  const reasonsJson = normalizeJsonObject(row.reasons_json);
  const scores = normalizeJsonObject(reasonsJson.scores);
  const repo: RepoSummary = {
    id: row.repo_id,
    githubId: row.github_id ? Number(row.github_id) : undefined,
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    htmlUrl: row.html_url,
    description: row.description ?? "",
    primaryLanguage: row.primary_language ?? "Unknown",
    topics: normalizeJsonArray(row.topics_json),
    stars: row.stars,
    forks: row.forks,
    openIssues: row.open_issues,
    pushedAt: row.pushed_at ? toIso(row.pushed_at) : "",
    updatedAt: row.updated_at ? toIso(row.updated_at) : "",
    archived: row.archived,
    fork: row.fork
  };
  const matchedPreferences = normalizeChineseLabels(
    normalizeStringArray(reasonsJson.matchedPreferences)
  );
  const summary = String(reasonsJson.summary ?? row.description ?? "");

  return {
    id: row.id,
    profileId: row.profile_id,
    rank: row.rank,
    repo,
    scores: {
      rule: Number(row.rule_score ?? scores.rule ?? 0),
      githubContextFit: Number(row.github_context_fit ?? scores.githubContextFit ?? 0),
      llmMatch: Number(row.llm_match_score ?? scores.llmMatch ?? 0),
      feedback: Number(row.feedback_score ?? scores.feedback ?? 0),
      opportunity: optionalScore(scores.opportunity),
      monetization: optionalScore(scores.monetization),
      growth: optionalScore(scores.growth),
      execution: optionalScore(scores.execution),
      differentiation: optionalScore(scores.differentiation),
      technicalQuality: optionalScore(scores.technicalQuality),
      final: Number(row.final_score ?? scores.final ?? 0),
      scoreVersion: row.score_version ?? String(scores.scoreVersion ?? "mvp-v1")
    },
    summary,
    summaryZh: ensureChineseSummary(
      String(reasonsJson.summaryZh ?? summary),
      repo,
      matchedPreferences
    ),
    opportunity: normalizePersistedOpportunity(reasonsJson.opportunity),
    reasons: normalizeChineseLabels(normalizeStringArray(reasonsJson.reasons)),
    risks: normalizeChineseLabels(normalizeStringArray(reasonsJson.risks)),
    matchedPreferences,
    relatedUserRepos: parseRelatedUserRepos(
      row.context_matches_json,
      reasonsJson.relatedUserRepos
    ),
    cluster: normalizePersistedCluster(reasonsJson.cluster),
    status: row.status,
    createdAt: toIso(row.created_at)
  };
}

function normalizePersistedCluster(value: unknown): Recommendation["cluster"] {
  const object = value && typeof value === "object" ? normalizeJsonObject(value) : null;
  if (!object) {
    return undefined;
  }

  return {
    key: String(object.key ?? ""),
    label: String(object.label ?? "未分组"),
    reason: String(object.reason ?? ""),
    representativeTerms: normalizeStringArray(object.representativeTerms),
    size: object.size === undefined ? undefined : Number(object.size),
    rankInCluster: object.rankInCluster === undefined ? undefined : Number(object.rankInCluster)
  };
}

function parseRelatedUserRepos(
  persistedMatches: unknown,
  fallbackMatches: unknown
): Recommendation["relatedUserRepos"] {
  const matches = Array.isArray(persistedMatches) && persistedMatches.length > 0
    ? persistedMatches
    : Array.isArray(fallbackMatches)
      ? fallbackMatches
      : [];

  return matches
    .map((item) => normalizeJsonObject(item))
    .map((item) => ({
      userRepoId: typeof item.userRepoId === "string" ? item.userRepoId : undefined,
      fullName: String(item.fullName ?? ""),
      reason: normalizeChineseLabels([String(item.reason ?? "")])[0] ?? "",
      score: Number(item.score ?? 0)
    }))
    .filter((item) => item.fullName);
}

function normalizePersistedOpportunity(value: unknown): OpportunityAnalysis | undefined {
  const object = value && typeof value === "object" ? normalizeJsonObject(value) : null;
  if (!object) {
    return undefined;
  }

  return {
    type: String(object.type ?? "SaaS/工具机会"),
    score: Number(object.score ?? 0),
    monetizationScore: Number(object.monetizationScore ?? 0),
    growthSignal: Number(object.growthSignal ?? 0),
    executionFit: Number(object.executionFit ?? 0),
    differentiationSpace: Number(object.differentiationSpace ?? 0),
    technicalQuality: Number(object.technicalQuality ?? 0),
    targetCustomers: normalizeStringArray(object.targetCustomers),
    monetizationPaths: normalizeStringArray(object.monetizationPaths),
    validationSteps: normalizeStringArray(object.validationSteps),
    suggestedAction: normalizeSuggestedAction(object.suggestedAction),
    evidence: normalizeStringArray(object.evidence)
  };
}

function repoHasMaterialChanges(existing: RepoSummary, next: RepoSummary) {
  return repoHasMaterialMetadataChanges(existing, next);
}

function normalizeSuggestedAction(value: unknown): OpportunityAnalysis["suggestedAction"] {
  return value === "build" ||
    value === "validate" ||
    value === "track" ||
    value === "observe" ||
    value === "ignore"
    ? value
    : "observe";
}

function optionalScore(value: unknown) {
  return value === undefined || value === null ? undefined : Number(value);
}

function mapKnowledgeSyncRow(row: Record<string, any>): KnowledgeSync {
  return {
    id: row.id,
    repoId: row.repo_id,
    repoFullName: row.full_name ?? undefined,
    target: row.target,
    datasetId: row.dataset_id ?? undefined,
    externalDocId: row.external_doc_id ?? undefined,
    contentHash: row.content_hash,
    status: row.status,
    syncedAt: row.synced_at ? toIso(row.synced_at) : undefined,
    errorMessage: row.error_message ?? undefined
  };
}

function buildPreferenceSignals(
  repo: RepoSummary,
  profileId: string,
  action: FeedbackAction
): Array<Omit<PreferenceSignal, "id" | "updatedAt">> {
  const delta =
    action === "save" ||
    action === "track" ||
    action === "to_validate" ||
    action === "validating" ||
    action === "monetization_ready"
      ? 0.18
      : action === "like"
        ? 0.1
        : action === "hide"
          ? -0.18
          : action === "dislike" || action === "abandon"
            ? -0.1
            : 0;

  if (delta === 0) {
    return [];
  }

  const values: Array<{ signalType: PreferenceSignal["signalType"]; value: string }> = [];
  if (repo.primaryLanguage && repo.primaryLanguage !== "Unknown") {
    values.push({ signalType: "language", value: repo.primaryLanguage });
  }
  for (const topic of repo.topics) {
    values.push({ signalType: "topic", value: topic.toLowerCase() });
  }
  for (const keyword of extractKeywords(`${repo.fullName} ${repo.description}`)) {
    values.push({ signalType: "keyword", value: keyword });
  }

  return values.map((signal) => ({
    profileId,
    signalType: signal.signalType,
    value: signal.value,
    weight: delta,
    source: `feedback:${action}`
  }));
}

function extractKeywords(text: string) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9+#.-]+/i)
        .map((item) => item.trim())
        .filter((item) => item.length >= 3 && !["github", "repository", "tool"].includes(item))
    )
  ].slice(0, 8);
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function normalizeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  return [];
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  return [];
}

function toVector(vector: number[]) {
  return `[${vector.map((value) => Number(value) || 0).join(",")}]`;
}

function parseVector(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(Number);
  }
  if (typeof value !== "string") {
    return [];
  }

  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
