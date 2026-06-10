import assert from "node:assert/strict";
import test from "node:test";
import { defaultDiscoverySources } from "../src/lib/discoverySources";
import type { DiscoveryProfile } from "../src/lib/types";
import { buildGitHubSearchQueryPlans } from "../src/server/githubSearch";
import { buildRecommendationMarkdown } from "../src/server/knowledgeSync";
import {
  buildDiscoveryPreview,
  heuristicDiscoveryPreferences
} from "../src/server/naturalLanguageDiscovery";
import { buildRecommendation } from "../src/server/ranking";
import { buildSchedulePlan } from "../src/server/scheduler";

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

test("GitHub Search 查询会拆分多个 keyword，而不是塞进同一条 query", () => {
  const plans = buildGitHubSearchQueryPlans(baseProfile);
  assert.ok(plans.some((plan) => plan.query.startsWith("agent ")));
  assert.ok(plans.some((plan) => plan.query.startsWith("workflow ")));
  assert.ok(!plans.some((plan) => plan.query.startsWith("agent workflow ")));
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
  assert.match(markdown, /## Reasons/);
  assert.match(markdown, /## Related User Repositories/);
  assert.match(markdown, /me\/fetchGithub/);
});
