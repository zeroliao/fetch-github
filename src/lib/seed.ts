import type {
  AiProvider,
  DashboardSnapshot,
  DiscoveryProfile,
  GithubAccount,
  KnowledgeSync,
  Recommendation,
  ScanJob,
  UserGitHubRepo
} from "./types";
import { defaultDiscoverySources } from "./discoverySources";
import { defaultOpportunityProfile } from "./opportunity";
import { defaultAppSettings } from "./settings";

const now = new Date().toISOString();

export const seedProviders: AiProvider[] = [
  {
    id: "default_chat",
    name: "默认 Chat 模型",
    kind: "chat",
    type: "openai_compatible",
    baseUrl: "https://api.example.com/v1",
    apiKeyEnv: "CHAT_API_KEY",
    model: "chat-model",
    enabled: false,
    rateLimit: {
      requestsPerMinute: 30,
      tokensPerMinute: 60000
    },
    timeoutSeconds: 60,
    createdAt: now,
    updatedAt: now
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
    enabled: false,
    rateLimit: {
      requestsPerMinute: 120,
      tokensPerMinute: 300000
    },
    timeoutSeconds: 30,
    createdAt: now,
    updatedAt: now
  }
];

export const seedProfiles: DiscoveryProfile[] = [
  {
    id: "ai-dev-tools",
    name: "变现机会雷达",
    enabled: true,
    config: {
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
        semanticFitThreshold: 0.42,
        finalReportTopK: 30
      },
      preferences: {
        keywords: ["agent", "llm", "rag", "workflow"],
        topics: ["ai", "developer-tools", "automation"],
        languages: {
          TypeScript: 1.2,
          Python: 1.1
        },
        excludeKeywords: ["crypto", "gambling"],
        minStars: 100,
        pushedWithinDays: 180,
        excludeArchived: true,
        excludeForks: true
      },
      opportunity: defaultOpportunityProfile,
      sources: defaultDiscoverySources(),
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
        chatProviderId: "default_chat",
        embeddingProviderId: "default_embedding"
      }
    },
    createdAt: now,
    updatedAt: now
  }
];

export const seedGithubRepos: UserGitHubRepo[] = [
  {
    id: "user-fetchgithub",
    githubAccountId: "github-account-demo",
    fullName: "your-name/fetchGithub",
    description: "GitHub 仓库发现与推荐系统。",
    primaryLanguage: "TypeScript",
    topics: ["github", "recommendation", "ai"],
    visibility: "public",
    readmeSummary: "用于扫描 GitHub 项目并生成个性化推荐的系统。",
    selectedForContext: true,
    lastSyncedAt: now
  }
];

export const seedGithubAccounts: GithubAccount[] = [
  {
    id: "github-account-demo",
    username: "your-name",
    tokenRef: "GITHUB_TOKEN",
    connectedAt: now,
    lastSyncedAt: now
  }
];

export const seedKnowledgeSyncs: KnowledgeSync[] = [];

export const seedRecommendations: Recommendation[] = [
  {
    id: "rec-vercel-ai",
    profileId: "ai-dev-tools",
    rank: 1,
    repo: {
      id: "repo-vercel-ai",
      githubId: 741941671,
      fullName: "vercel/ai",
      owner: "vercel",
      name: "ai",
      htmlUrl: "https://github.com/vercel/ai",
      description: "面向 TypeScript 应用的 AI 工具包。",
      primaryLanguage: "TypeScript",
      topics: ["ai", "sdk", "developer-tools"],
      stars: 18000,
      forks: 2500,
      openIssues: 210,
      pushedAt: "2026-06-06T10:00:00.000Z",
      updatedAt: "2026-06-06T10:00:00.000Z",
      archived: false,
      fork: false
    },
    scores: {
      rule: 0.86,
      githubContextFit: 0.82,
      llmMatch: 0.91,
      feedback: 0.1,
      opportunity: 0.82,
      monetization: 0.8,
      growth: 0.78,
      execution: 0.86,
      differentiation: 0.72,
      technicalQuality: 0.84,
      final: 0.86,
      scoreVersion: "opportunity-radar-v1"
    },
    summary: "这是一个 TypeScript AI SDK，适合作为 fetchGithub 构建模型接入层、推荐解释和前端交互时的参考项目。",
    opportunity: {
      type: "集成/API 机会",
      score: 0.82,
      monetizationScore: 0.8,
      growthSignal: 0.78,
      executionFit: 0.86,
      differentiationSpace: 0.72,
      technicalQuality: 0.84,
      targetCustomers: ["开发者", "企业研发团队", "AI 工具用户"],
      monetizationPaths: ["插件/API 集成", "托管版 SaaS", "咨询与实施"],
      validationSteps: ["验证中文开发者对统一模型接入层的付费意愿。", "包装一个小型托管 Demo。"],
      suggestedAction: "validate",
      evidence: ["生态信号强，适合观察 AI SDK 商业化形态。"]
    },
    reasons: [
      "符合 TypeScript 和 AI 开发工具方向的偏好。",
      "可以参考它的模型 provider 接入方式和前端交互模式。",
      "生态信号强，维护活跃度较高。"
    ],
    risks: ["生态覆盖面较大，MVP 阶段接入时需要控制范围。"],
    matchedPreferences: ["ai", "developer-tools", "TypeScript"],
    relatedUserRepos: [
      {
        fullName: "your-name/fetchGithub",
        reason: "可作为 Chat provider 接入和 AI 结果展示的参考。",
        score: 0.82
      }
    ],
    status: "new",
    createdAt: now
  },
  {
    id: "rec-langchain",
    profileId: "ai-dev-tools",
    rank: 2,
    repo: {
      id: "repo-langchain",
      githubId: 551224641,
      fullName: "langchain-ai/langchain",
      owner: "langchain-ai",
      name: "langchain",
      htmlUrl: "https://github.com/langchain-ai/langchain",
      description: "用于开发语言模型应用的框架。",
      primaryLanguage: "Python",
      topics: ["llm", "agents", "rag"],
      stars: 99000,
      forks: 16000,
      openIssues: 1200,
      pushedAt: "2026-06-05T18:00:00.000Z",
      updatedAt: "2026-06-05T18:00:00.000Z",
      archived: false,
      fork: false
    },
    scores: {
      rule: 0.78,
      githubContextFit: 0.7,
      llmMatch: 0.84,
      feedback: 0.05,
      opportunity: 0.74,
      monetization: 0.72,
      growth: 0.82,
      execution: 0.62,
      differentiation: 0.65,
      technicalQuality: 0.78,
      final: 0.77,
      scoreVersion: "opportunity-radar-v1"
    },
    summary: "这是一个覆盖面很广的 LLM 应用框架，适合用来理解 Agent、RAG 和 AI 工作流生态。",
    opportunity: {
      type: "Agent 自动化机会",
      score: 0.74,
      monetizationScore: 0.72,
      growthSignal: 0.82,
      executionFit: 0.62,
      differentiationSpace: 0.65,
      technicalQuality: 0.78,
      targetCustomers: ["企业研发团队", "AI 工具用户", "开发者"],
      monetizationPaths: ["自动化方案服务", "私有化部署", "课程/内容"],
      validationSteps: ["选择一个垂直 Agent 场景做需求访谈。", "评估中文化模板和交付服务空间。"],
      suggestedAction: "track",
      evidence: ["生态规模大，可作为市场信号和竞品参考。"]
    },
    reasons: [
      "在 LLM、Agent 和 RAG 主题上匹配度较高。",
      "流行度高，生态相关性强。",
      "适合作为 AI 工作流项目推荐时的对照样本。"
    ],
    risks: ["issue 数量较高，可能意味着使用和维护复杂度也较高。"],
    matchedPreferences: ["llm", "rag", "agents", "Python"],
    relatedUserRepos: [
      {
        fullName: "your-name/fetchGithub",
        reason: "有助于判断 fetchGithub 发现的 AI 工作流项目类型。",
        score: 0.7
      }
    ],
    status: "new",
    createdAt: now
  }
];

export const seedJobs: ScanJob[] = [
  {
    id: "job-demo-first-scan",
    profileId: "ai-dev-tools",
    type: "first_scan",
    status: "throttled",
    stage: "profile",
    maxCandidates: 5000,
    fetchedCount: 340,
    processedCount: 210,
    analyzedCount: 24,
    newRepoCount: 0,
    updatedRepoCount: 0,
    unchangedRepoCount: 0,
    candidateCount: 210,
    startedAt: now,
    createdAt: now
  }
];

export const seedSnapshot: DashboardSnapshot = {
  settings: defaultAppSettings,
  profiles: seedProfiles,
  aiProviders: seedProviders,
  recommendations: seedRecommendations,
  jobs: seedJobs,
  githubAccounts: seedGithubAccounts,
  githubRepos: seedGithubRepos,
  knowledgeSyncs: seedKnowledgeSyncs,
  queueStats: [],
  operations: {
    resourceEvents: [],
    aiJobs: [],
    aiCostSummary: {
      totalJobs: 0,
      totalTokens: 0,
      estimatedCostUsd: 0
    }
  }
};
