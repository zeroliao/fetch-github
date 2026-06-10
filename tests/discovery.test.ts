import assert from "node:assert/strict";
import test from "node:test";
import { defaultDiscoverySources } from "../src/lib/discoverySources";
import type { DiscoveryProfile } from "../src/lib/types";
import { buildGitHubSearchQueryPlans } from "../src/server/githubSearch";
import {
  buildDiscoveryPreview,
  heuristicDiscoveryPreferences
} from "../src/server/naturalLanguageDiscovery";

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
