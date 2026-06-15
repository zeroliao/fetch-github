import assert from "node:assert/strict";
import test from "node:test";
import { defaultDiscoverySources, normalizeDiscoverySources } from "../src/lib/discoverySources";
import { shouldAnalyzeDiscoveredRepo } from "../src/lib/repoRefresh";
import { ensureChineseSummary } from "../src/lib/recommendationText";
import {
  normalizeSemanticFitThreshold,
  shouldDeferLlmBySemanticFit
} from "../src/lib/semanticGate";
import { annotateRecommendationClusters, inferRecommendationCluster } from "../src/lib/repoCluster";
import { compactMarkdownForAnalysis } from "../src/lib/text";
import type { DiscoveryProfile } from "../src/lib/types";
import { buildGitHubSearchQueryPlans } from "../src/server/githubSearch";
import { buildRecommendationMarkdown } from "../src/server/knowledgeSync";
import { buildRepoAnalysisPrompt, buildRepoDeltaAnalysisPrompt } from "../src/server/llmAnalysis";
import {
  buildDiscoveryPreview,
  heuristicDiscoveryPreferences
} from "../src/server/naturalLanguageDiscovery";
import { buildRecommendation } from "../src/server/ranking";
import { buildSchedulePlan } from "../src/server/scheduler";
import {
  buildSourceAdapterPlans,
  mapOssInsightTrendingRows,
  parseGitHubTrendingRepoLinks
} from "../src/server/sourceAdapters";

const baseProfile: DiscoveryProfile = {
  id: "test-profile",
  name: "测试配置",
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  config: {
    schedule: {
      type: "cron",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
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
      keywords: ["agent", "workflow"],
      topics: ["ai", "developer-tools"],
      languages: {
        TypeScript: 1.2
      },
      excludeKeywords: ["crypto"],
      minStars: 100,
      pushedWithinDays: 180,
      excludeArchived: true,
      excludeForks: true
    },
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
  }
};

const baseRepo = {
  id: "repo-refresh",
  githubId: 1,
  fullName: "example/refresh",
  owner: "example",
  name: "refresh",
  htmlUrl: "https://github.com/example/refresh",
  description: "AI workflow tool",
  primaryLanguage: "TypeScript",
  topics: ["ai", "workflow"],
  stars: 1000,
  forks: 100,
  openIssues: 10,
  pushedAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  archived: false,
  fork: false
};

test("GitHub Search 查询会拆分多个 keyword，而不是塞进同一条 query", () => {
  const plans = buildGitHubSearchQueryPlans(baseProfile);
  assert.ok(plans.some((plan) => plan.query.startsWith("agent ")));
  assert.ok(plans.some((plan) => plan.query.startsWith("workflow ")));
  assert.ok(!plans.some((plan) => plan.query.startsWith("agent workflow ")));
});

test("incremental scan skips unchanged repositories that were already deeply analyzed", () => {
  const decision = shouldAnalyzeDiscoveredRepo({
    existing: baseRepo,
    existingDataLevel: "L3",
    next: { ...baseRepo }
  });

  assert.equal(decision.shouldAnalyze, false);
  assert.equal(decision.reason, "unchanged_snapshot_only");
});

test("incremental scan re-analyzes new, shallow, or significantly changed repositories", () => {
  assert.equal(
    shouldAnalyzeDiscoveredRepo({
      next: baseRepo
    }).reason,
    "new_repo"
  );
  assert.equal(
    shouldAnalyzeDiscoveredRepo({
      existing: baseRepo,
      existingDataLevel: "L0",
      next: { ...baseRepo }
    }).reason,
    "not_deep_analyzed"
  );
  assert.equal(
    shouldAnalyzeDiscoveredRepo({
      existing: baseRepo,
      existingDataLevel: "L3",
      next: { ...baseRepo, stars: 1250 }
    }).reason,
    "growth_signal_changed"
  );
  assert.equal(
    shouldAnalyzeDiscoveredRepo({
      existing: baseRepo,
      existingDataLevel: "L3",
      next: { ...baseRepo, description: "AI workflow monetization tool" }
    }).reason,
    "metadata_changed"
  );
});

test("查询计划会去重", () => {
  const profile = {
    ...baseProfile,
    config: {
      ...baseProfile.config,
      preferences: {
        ...baseProfile.config.preferences,
        keywords: ["agent", "agent"]
      }
    }
  };
  const plans = buildGitHubSearchQueryPlans(profile);
  const keys = plans.map((plan) => `${plan.sourceId}:${plan.query}:${plan.sort}:${plan.order}`);
  assert.equal(keys.length, new Set(keys).size);
});

test("待接入榜单来源可以保存启用状态，但不会生成未实现查询", () => {
  const sources = normalizeDiscoverySources([
    ...defaultDiscoverySources(),
    { id: "github_explore", enabled: true, weight: 1.1 }
  ]);
  assert.equal(sources.find((source) => source.id === "github_explore")?.enabled, true);

  const plans = buildGitHubSearchQueryPlans({
    ...baseProfile,
    config: {
      ...baseProfile.config,
      sources
    }
  });
  assert.ok(!plans.some((plan) => plan.sourceId === "github_explore"));
});

test("GitHub Trending 会生成 source adapter plan", () => {
  const sources = normalizeDiscoverySources([
    ...defaultDiscoverySources(),
    { id: "github_trending", enabled: true, weight: 1.15 }
  ]);
  const plans = buildSourceAdapterPlans({
    ...baseProfile,
    config: {
      ...baseProfile.config,
      sources
    }
  });

  assert.ok(plans.some((plan) => plan.sourceId === "github_trending"));
});

test("GitHub Trending HTML 可以解析出仓库链接", () => {
  const links = parseGitHubTrendingRepoLinks(`
    <article>
      <h2 class="h3 lh-condensed">
        <a href="/owner-one/repo-one">owner-one / repo-one</a>
      </h2>
      <h2 class="h3 lh-condensed">
        <a href="/owner-two/repo-two">owner-two / repo-two</a>
      </h2>
    </article>
  `);

  assert.deepEqual(links, [
    { owner: "owner-one", name: "repo-one" },
    { owner: "owner-two", name: "repo-two" }
  ]);
});

test("OSS Insight Trending 会生成 source adapter plan", () => {
  const sources = normalizeDiscoverySources([
    ...defaultDiscoverySources(),
    { id: "ossinsight_trending", enabled: true, weight: 1.12 }
  ]);
  const plans = buildSourceAdapterPlans({
    ...baseProfile,
    config: {
      ...baseProfile.config,
      sources
    }
  });

  const plan = plans.find((item) => item.sourceId === "ossinsight_trending");
  assert.equal(plan?.queryHashKey, "ossinsight_trending:past_24_hours:All");
});

test("OSS Insight Trending 响应可以映射为仓库候选", () => {
  const [repo] = mapOssInsightTrendingRows(
    [
      {
        repo_id: "1165277268",
        repo_name: "Panniantong/Agent-Reach",
        primary_language: "Python",
        description: "Give your AI agent eyes to see the entire internet.",
        stars: "102",
        forks: "11",
        collection_names: "ai,agent"
      }
    ],
    "2026-06-15T00:00:00.000Z"
  );

  assert.equal(repo.id, "github-1165277268");
  assert.equal(repo.githubId, 1165277268);
  assert.equal(repo.fullName, "Panniantong/Agent-Reach");
  assert.equal(repo.htmlUrl, "https://github.com/Panniantong/Agent-Reach");
  assert.equal(repo.primaryLanguage, "Python");
  assert.deepEqual(repo.topics, ["ai", "agent"]);
  assert.equal(repo.stars, 102);
  assert.equal(repo.forks, 11);
});

test("自然语言兜底解析会生成适合 GitHub 的英文条件", () => {
  const generated = heuristicDiscoveryPreferences(
    "找最近半年活跃、适合做 AI agent 工作流编排的 TypeScript 项目，不要加密货币相关项目，stars 超过 500"
  );
  assert.ok(generated.keywords.includes("agent"));
  assert.ok(generated.keywords.includes("workflow"));
  assert.equal(generated.languages.TypeScript, 1.2);
  assert.ok(generated.excludeKeywords.includes("crypto"));
  assert.equal(generated.minStars, 500);
  assert.equal(generated.pushedWithinDays, 180);
});

test("自然语言预览会限制查询计划数量", () => {
  const generated = heuristicDiscoveryPreferences("AI agent RAG workflow TypeScript Python Go Rust Java");
  const preview = buildDiscoveryPreview({
    profile: baseProfile,
    generated,
    mode: "merge"
  });
  assert.ok(preview.queryPlans.length <= 40);
});

test("漏跑策略 skip 只保留当前周期，不会批量补跑", () => {
  const profile: DiscoveryProfile = {
    ...baseProfile,
    config: {
      ...baseProfile.config,
      schedule: {
        ...baseProfile.config.schedule,
        missedRunPolicy: "skip",
        timezone: "Asia/Shanghai",
        cron: "0 9 * * *"
      }
    }
  };
  const plan = buildSchedulePlan(
    profile,
    { lastScheduledAt: "2026-06-08T01:00:00.000Z" },
    new Date("2026-06-10T02:00:00.000Z")
  );
  assert.equal(plan.occurrences.length, 0);
});

test("漏跑策略 run_once 补最新一次，resume 逐次补最早漏跑周期", () => {
  const base: DiscoveryProfile = {
    ...baseProfile,
    config: {
      ...baseProfile.config,
      schedule: {
        ...baseProfile.config.schedule,
        timezone: "Asia/Shanghai",
        cron: "0 9 * * *"
      }
    }
  };

  const runOncePlan = buildSchedulePlan(
    {
      ...base,
      config: {
        ...base.config,
        schedule: {
          ...base.config.schedule,
          missedRunPolicy: "run_once"
        }
      }
    },
    { lastScheduledAt: "2026-06-08T01:00:00.000Z" },
    new Date("2026-06-10T02:00:00.000Z")
  );
  assert.equal(runOncePlan.occurrences.length, 1);
  assert.equal(runOncePlan.occurrences[0].toISOString(), "2026-06-10T01:00:00.000Z");

  const resumePlan = buildSchedulePlan(
    {
      ...base,
      config: {
        ...base.config,
        schedule: {
          ...base.config.schedule,
          missedRunPolicy: "resume"
        }
      }
    },
    { lastScheduledAt: "2026-06-08T01:00:00.000Z" },
    new Date("2026-06-10T02:00:00.000Z")
  );
  assert.equal(resumePlan.occurrences.length, 1);
  assert.equal(resumePlan.occurrences[0].toISOString(), "2026-06-09T01:00:00.000Z");
});

test("推荐生成会保留关联我的 GitHub 项目的外键", () => {
  const recommendation = buildRecommendation(
    {
      id: "repo-candidate",
      fullName: "example/candidate",
      owner: "example",
      name: "candidate",
      htmlUrl: "https://github.com/example/candidate",
      description: "AI workflow developer tool",
      primaryLanguage: "TypeScript",
      topics: ["ai", "workflow"],
      stars: 1200,
      forks: 100,
      openIssues: 12,
      pushedAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      archived: false,
      fork: false
    },
    baseProfile,
    1,
    undefined,
    [],
    [
      {
        id: "user-repo-1",
        fullName: "me/fetchGithub",
        description: "GitHub 推荐系统",
        primaryLanguage: "TypeScript",
        topics: ["ai", "workflow"],
        visibility: "public",
        selectedForContext: true
      }
    ]
  );

  assert.equal(recommendation.relatedUserRepos[0]?.userRepoId, "user-repo-1");
  assert.equal(recommendation.relatedUserRepos[0]?.fullName, "me/fetchGithub");
  assert.equal(recommendation.repo.description, "AI workflow developer tool");
  assert.match(recommendation.summaryZh ?? "", /example\/candidate 是一个 TypeScript 项目/);
  assert.ok((recommendation.scores.opportunity ?? 0) > 0);
  assert.ok(recommendation.opportunity?.monetizationPaths.length);
});

test("英文 LLM 摘要不会作为中文展示摘要直接展示", () => {
  const recommendation = buildRecommendation(
    {
      id: "repo-english-summary",
      fullName: "example/english-summary",
      owner: "example",
      name: "english-summary",
      htmlUrl: "https://github.com/example/english-summary",
      description: "A production-ready open-source platform for building LLM applications.",
      primaryLanguage: "TypeScript",
      topics: ["ai", "developer-tools"],
      stars: 1500,
      forks: 120,
      openIssues: 10,
      pushedAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      archived: false,
      fork: false
    },
    baseProfile,
    1,
    {
      summary: "A production-ready open-source platform for building LLM applications.",
      categories: [],
      target_users: [],
      core_features: [],
      maturity: "active",
      is_match: true,
      match_score: 0.8,
      confidence: 0.9,
      matched_preferences: ["Matches preferred topic: developer-tools"],
      risks: [],
      recommendation_reason: "Strong match for developer-tools topic",
      opportunity: {
        type: "SaaS/工具机会",
        score: 0.88,
        monetizationScore: 0.86,
        growthSignal: 0.75,
        executionFit: 0.8,
        differentiationSpace: 0.7,
        technicalQuality: 0.82,
        targetCustomers: ["开发者", "企业研发团队"],
        monetizationPaths: ["托管版 SaaS", "私有化部署"],
        validationSteps: ["做一个付费落地页验证需求。"],
        suggestedAction: "validate",
        evidence: ["LLM 应用平台具备明确商业场景。"]
      }
    }
  );

  assert.equal(
    recommendation.repo.description,
    "A production-ready open-source platform for building LLM applications."
  );
  assert.match(recommendation.summaryZh ?? "", /example\/english-summary 是一个 TypeScript 项目/);
  assert.ok(!(recommendation.summaryZh ?? "").startsWith("A production-ready"));
  assert.deepEqual(recommendation.matchedPreferences, ["命中偏好 topic：开发者工具"]);
  assert.deepEqual(recommendation.reasons.slice(0, 1), ["与 开发者工具 topic 强匹配"]);
  assert.equal(recommendation.opportunity?.type, "SaaS/工具机会");
  assert.equal(recommendation.opportunity?.suggestedAction, "validate");
  assert.equal(recommendation.scores.opportunity, 0.88);
});

test("旧版包含原始英文描述的摘要会重建为中文展示摘要", () => {
  const summary = ensureChineseSummary(
    "example/legacy 是一个 TypeScript 项目。原始描述：A production-ready platform for LLM apps.",
    {
      id: "repo-legacy",
      fullName: "example/legacy",
      owner: "example",
      name: "legacy",
      htmlUrl: "https://github.com/example/legacy",
      description: "A production-ready platform for LLM apps.",
      primaryLanguage: "TypeScript",
      topics: ["ai", "workflow"],
      stars: 900,
      forks: 90,
      openIssues: 3,
      pushedAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      archived: false,
      fork: false
    },
    ["命中偏好 topic：ai"]
  );

  assert.match(summary, /example\/legacy 是一个 TypeScript 项目/);
  assert.doesNotMatch(summary, /原始描述/);
});

test("长 README 会压缩为保留商业分析信号的输入", () => {
  const readme = [
    "# Opportunity Tool",
    "A short intro.",
    "## Features",
    "- Self-hosted deployment",
    "- API integration",
    "## Usage",
    "```ts",
    "const app = createApp();",
    "app.start();",
    "```",
    "x".repeat(20000),
    "## License",
    "MIT"
  ].join("\n");

  const compacted = compactMarkdownForAnalysis(readme, 1200);
  assert.ok(compacted.length <= 1200);
  assert.match(compacted, /# Opportunity Tool/);
  assert.match(compacted, /Self-hosted deployment/);
  assert.match(compacted, /API integration/);
  assert.match(compacted, /License/);
});

test("LLM 分析 prompt 会使用紧凑协议和压缩 README", () => {
  const prompt = buildRepoAnalysisPrompt({
    repo: baseRepo,
    profile: baseProfile,
    readme: compactMarkdownForAnalysis(
      [
        "# Opportunity Tool",
        "A short intro.",
        "## Features",
        "- Self-hosted deployment",
        "- API integration",
        "x".repeat(12000)
      ].join("\n"),
      7000
    ),
    compressed: true
  });

  assert.ok(prompt.length < 9000);
  assert.match(prompt, /Self-hosted deployment/);
  assert.match(prompt, /JSON keys/);
  assert.doesNotMatch(prompt, /output_schema/);
});

test("语义门控只延后低相关项目，不延后高优先级或高机会项目", () => {
  assert.equal(normalizeSemanticFitThreshold(undefined), 0.42);
  assert.equal(
    shouldDeferLlmBySemanticFit({
      semanticFit: 0.2,
      threshold: 0.42,
      priorityScore: 0.4,
      opportunityScore: 0.3,
      minOpportunityScore: 0.55
    }),
    true
  );
  assert.equal(
    shouldDeferLlmBySemanticFit({
      semanticFit: 0.2,
      threshold: 0.42,
      priorityScore: 0.8,
      opportunityScore: 0.3,
      minOpportunityScore: 0.55
    }),
    false
  );
  assert.equal(
    shouldDeferLlmBySemanticFit({
      semanticFit: 0.2,
      threshold: 0.42,
      priorityScore: 0.4,
      opportunityScore: 0.7,
      minOpportunityScore: 0.55
    }),
    false
  );
});

test("重新分析 delta prompt 使用旧分析和更短上下文", () => {
  const readme = [
    "# Opportunity Tool",
    "A short intro.",
    "## Features",
    "- Self-hosted deployment",
    "- API integration",
    "x".repeat(12000)
  ].join("\n");
  const fullPrompt = buildRepoAnalysisPrompt({
    repo: baseRepo,
    profile: baseProfile,
    readme: compactMarkdownForAnalysis(readme, 7000),
    compressed: true
  });
  const deltaPrompt = buildRepoDeltaAnalysisPrompt({
    repo: baseRepo,
    profile: baseProfile,
    readme: compactMarkdownForAnalysis(readme, 2600),
    compressed: true,
    previousAnalysis: {
      summary: "已有中文摘要",
      categories: ["AI"],
      target_users: ["开发者"],
      core_features: ["workflow"],
      maturity: "growth",
      is_match: true,
      match_score: 0.8,
      confidence: 0.7,
      matched_preferences: ["agent"],
      risks: ["维护风险"],
      recommendation_reason: "适合包装成托管服务。",
      opportunity: {
        type: "SaaS/工具机会",
        score: 0.75,
        monetizationScore: 0.7,
        growthSignal: 0.6,
        executionFit: 0.8,
        differentiationSpace: 0.6,
        technicalQuality: 0.7,
        targetCustomers: ["开发者"],
        monetizationPaths: ["托管版 SaaS"],
        validationSteps: ["访谈 3 个潜在客户"],
        suggestedAction: "validate",
        evidence: ["stars 增长明显"]
      }
    }
  });

  assert.ok(deltaPrompt.length < fullPrompt.length);
  assert.match(deltaPrompt, /previous/);
  assert.match(deltaPrompt, /完整 JSON/);
});

test("知识库 Markdown 会包含推荐理由和关联项目解释", () => {
  const recommendation = buildRecommendation(
    {
      id: "repo-doc",
      fullName: "example/doc-target",
      owner: "example",
      name: "doc-target",
      htmlUrl: "https://github.com/example/doc-target",
      description: "AI agent documentation target",
      primaryLanguage: "TypeScript",
      topics: ["ai", "developer-tools"],
      stars: 800,
      forks: 80,
      openIssues: 4,
      pushedAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      archived: false,
      fork: false
    },
    baseProfile,
    1,
    undefined,
    [],
    [
      {
        id: "user-repo-doc",
        fullName: "me/fetchGithub",
        description: "GitHub 推荐系统",
        primaryLanguage: "TypeScript",
        topics: ["ai", "developer-tools"],
        visibility: "public",
        selectedForContext: true
      }
    ]
  );

  const markdown = buildRecommendationMarkdown(recommendation);
  assert.match(markdown, /## Opportunity/);
  assert.match(markdown, /### Monetization Paths/);
  assert.match(markdown, /## Reasons/);
  assert.match(markdown, /## Related User Repositories/);
  assert.match(markdown, /me\/fetchGithub/);
});

test("推荐项目会按主题生成轻量分组并计算组内位置", () => {
  const agentCluster = inferRecommendationCluster(
    {
      ...baseRepo,
      id: "agent-repo",
      fullName: "example/agent-workflow",
      description: "AI agent workflow automation platform",
      topics: ["agent", "workflow"]
    },
    "Agent 自动化机会"
  );
  assert.equal(agentCluster.key, "ai-agent-workflow");

  const first = buildRecommendation(
    {
      ...baseRepo,
      id: "cluster-1",
      fullName: "example/agent-one",
      description: "AI agent workflow tool",
      stars: 2000
    },
    baseProfile,
    1
  );
  const second = buildRecommendation(
    {
      ...baseRepo,
      id: "cluster-2",
      fullName: "example/agent-two",
      description: "AI agent automation toolkit",
      stars: 1000
    },
    baseProfile,
    2
  );
  const grouped = annotateRecommendationClusters([second, first]);

  assert.equal(grouped[0].cluster?.key, "ai-agent-workflow");
  assert.equal(grouped[0].cluster?.size, 2);
  assert.equal(grouped[0].cluster?.rankInCluster, 1);
  assert.equal(grouped[1].cluster?.rankInCluster, 2);
});
