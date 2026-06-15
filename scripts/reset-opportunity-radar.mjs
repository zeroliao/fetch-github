import pg from "pg";
import { loadLocalEnv } from "./load-env.mjs";

const { Client } = pg;

loadLocalEnv();

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://fetchgithub:fetchgithub@127.0.0.1:5433/fetchgithub";

const client = new Client({ connectionString: databaseUrl });

const now = new Date().toISOString();

const defaultProviders = [
  {
    id: "default_chat",
    name: "默认 Chat 模型",
    kind: "chat",
    type: "openai_compatible",
    baseUrl: "https://api.example.com/v1",
    apiKeyEnv: "CHAT_API_KEY",
    model: "chat-model",
    dimensions: null,
    config: {
      rateLimit: {
        requestsPerMinute: 30,
        tokensPerMinute: 60000
      },
      timeoutSeconds: 60
    },
    enabled: false
  },
  {
    id: "default_embedding",
    name: "默认 Embedding 模型",
    kind: "embedding",
    type: "openai_compatible",
    baseUrl: "https://api.example.com/v1",
    apiKeyEnv: "EMBEDDING_API_KEY",
    model: "embedding-model",
    dimensions: 1536,
    config: {
      rateLimit: {
        requestsPerMinute: 120,
        tokensPerMinute: 300000
      },
      timeoutSeconds: 30
    },
    enabled: false
  }
];

const opportunityProfile = {
  goals: ["SaaS", "私有化部署服务", "AI Agent 工具", "二次开发/集成服务", "内容/课程/咨询"],
  targetCustomers: ["开发者", "中小企业", "企业研发团队", "内容创作者", "AI 工具用户"],
  monetizationChannels: ["订阅制 SaaS", "托管版", "私有化部署", "插件/模板", "咨询与实施", "课程/内容"],
  preferredAdvantages: ["可中文化", "可托管", "可私有化", "可集成现有工作流", "低成本交付", "开发者愿意付费"],
  excludeSignals: ["纯学术实验", "加密货币/博彩", "版权风险高", "过度依赖闭源平台", "长期不维护"],
  minOpportunityScore: 0.55
};

const defaultSources = [
  { id: "github_search_preferences", enabled: true, weight: 1 },
  { id: "github_topics", enabled: true, weight: 1.08 },
  { id: "github_search_stars", enabled: true, weight: 1.04 },
  { id: "github_search_recent_growth", enabled: true, weight: 1.12 },
  { id: "github_trending", enabled: true, weight: 1.15 },
  { id: "github_explore", enabled: false, weight: 1.1 },
  { id: "ossinsight_trending", enabled: true, weight: 1.12 },
  { id: "gharchive_velocity", enabled: false, weight: 1.14 },
  { id: "openssf_scorecard", enabled: false, weight: 0.98 },
  { id: "ecosystems_usage", enabled: false, weight: 1.02 }
];

try {
  await client.connect();
  await client.query("begin");

  const chatProviderId = "default_chat";
  const embeddingProviderId = "default_embedding";

  await client.query(
    `truncate table
      app_state,
      auth_sessions,
      knowledge_syncs,
      feedback,
      repo_context_matches,
      recommendations,
      repo_scores,
      llm_results,
      llm_jobs,
      repo_embeddings,
      candidate_queue,
      scan_checkpoints,
      resource_events,
      discovery_jobs,
      scan_schedule_state,
      scan_schedules,
      repo_documents,
      repo_snapshots,
      repos,
      preference_signals,
      user_repos,
      github_accounts,
      discovery_profiles,
      ai_providers
    restart identity cascade`
  );

  for (const provider of defaultProviders) {
    await client.query(
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
        provider.dimensions,
        JSON.stringify(provider.config),
        provider.enabled,
        now,
        now
      ]
    );
  }

  const config = {
    schedule: {
      type: "cron",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      startAt: "2026-06-08 09:00:00",
      maxRuntimeMinutes: 120,
      missedRunPolicy: "skip"
    },
    limits: {
      sourceLimitPerQuery: 100,
      maxCandidates: 5000,
      ruleFilterTopK: 1000,
      detailFetchTopK: 300,
      embeddingTopK: 1000,
      llmAnalyzeTopK: 100,
      finalReportTopK: 30
    },
    preferences: {
      keywords: ["agent", "llm", "rag", "workflow", "automation", "mcp", "saas", "dashboard", "api"],
      topics: ["ai", "developer-tools", "automation", "agents", "rag", "workflow"],
      languages: {
        TypeScript: 1.2,
        Python: 1.1,
        Go: 1,
        Rust: 0.95
      },
      excludeKeywords: ["crypto", "gambling", "casino", "nft"],
      minStars: 20,
      pushedWithinDays: 180,
      excludeArchived: true,
      excludeForks: true
    },
    opportunity: opportunityProfile,
    sources: defaultSources,
    resourcePolicy: {
      mode: "complete_low_memory",
      memory: {
        targetAvailableMb: 1024,
        minAvailableMb: 512,
        criticalAvailableMb: 256
      },
      execution: {
        batchSize: 10,
        maxConcurrency: 1,
        checkpointEveryItems: 10,
        pauseOnPressure: true
      }
    },
    ai: {
      chatProviderId,
      embeddingProviderId
    }
  };

  await client.query(
    `insert into discovery_profiles (id, name, enabled, config_json, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      "opportunity-radar",
      "变现机会雷达",
      true,
      JSON.stringify(config),
      now,
      now
    ]
  );

  await client.query(
    `insert into app_state (key, value_json, updated_at)
     values ('seed_data_initialized', $1, now())
     on conflict (key) do update set value_json=excluded.value_json, updated_at=now()`,
    [
      JSON.stringify({
        insertedDemoData: false,
        version: 2,
        resetFor: "opportunity-radar",
        resetAt: now
      })
    ]
  );

  await client.query("commit");
  console.log(
    `Opportunity radar clean reset complete. profile=opportunity-radar chat=${chatProviderId} embedding=${embeddingProviderId}`
  );
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
