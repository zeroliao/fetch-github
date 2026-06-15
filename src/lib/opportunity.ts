import type { OpportunityAnalysis, OpportunityProfile, RepoSummary } from "./types";
import { clampScore } from "./scoring";

export const defaultOpportunityProfile: OpportunityProfile = {
  goals: ["SaaS", "私有化部署服务", "AI Agent 工具", "二次开发/集成服务", "内容/课程/咨询"],
  targetCustomers: ["开发者", "中小企业", "企业研发团队", "内容创作者", "AI 工具用户"],
  monetizationChannels: ["订阅制 SaaS", "托管版", "私有化部署", "插件/模板", "咨询与实施", "课程/内容"],
  preferredAdvantages: ["可中文化", "可托管", "可私有化", "可集成现有工作流", "低成本交付", "开发者愿意付费"],
  excludeSignals: ["纯学术实验", "加密货币/博彩", "版权风险高", "过度依赖闭源平台", "长期不维护"],
  minOpportunityScore: 0.55
};

const monetizationKeywords = [
  "agent",
  "agents",
  "automation",
  "workflow",
  "mcp",
  "api",
  "dashboard",
  "platform",
  "saas",
  "self-hosted",
  "enterprise",
  "rag",
  "llm",
  "cli",
  "sdk",
  "proxy",
  "integration",
  "deploy",
  "monitoring",
  "analytics",
  "knowledge",
  "search"
];

const difficultKeywords = ["research", "paper", "benchmark", "dataset", "demo"];

export function normalizeOpportunityProfile(
  value: Partial<OpportunityProfile> | undefined
): OpportunityProfile {
  return {
    goals: nonEmptyList(value?.goals, defaultOpportunityProfile.goals),
    targetCustomers: nonEmptyList(value?.targetCustomers, defaultOpportunityProfile.targetCustomers),
    monetizationChannels: nonEmptyList(value?.monetizationChannels, defaultOpportunityProfile.monetizationChannels),
    preferredAdvantages: nonEmptyList(value?.preferredAdvantages, defaultOpportunityProfile.preferredAdvantages),
    excludeSignals: nonEmptyList(value?.excludeSignals, defaultOpportunityProfile.excludeSignals),
    minOpportunityScore: clampScore(Number(value?.minOpportunityScore ?? defaultOpportunityProfile.minOpportunityScore))
  };
}

export function scoreOpportunitySignals(
  repo: RepoSummary,
  profile: OpportunityProfile,
  technicalScore: number
) {
  const text = `${repo.fullName} ${repo.description} ${repo.topics.join(" ")} ${repo.primaryLanguage}`.toLowerCase();
  const monetizationHits = monetizationKeywords.filter((keyword) => text.includes(keyword)).length;
  const preferredHits = profile.preferredAdvantages.filter((item) =>
    text.includes(toSearchToken(item))
  ).length;
  const difficultHits = difficultKeywords.filter((keyword) => text.includes(keyword)).length;
  const starScore = Math.min(1, Math.log10(repo.stars + 1) / 5);
  const forkScore = Math.min(1, Math.log10(repo.forks + 1) / 4);
  const freshnessScore = freshness(repo.pushedAt);

  const monetizationScore = clampScore(monetizationHits * 0.08 + preferredHits * 0.06 + starScore * 0.25);
  const growthSignal = clampScore(freshnessScore * 0.45 + starScore * 0.35 + forkScore * 0.2);
  const executionFit = clampScore(
    (repo.primaryLanguage === "TypeScript" ? 0.18 : 0) +
      (repo.primaryLanguage === "Python" ? 0.14 : 0) +
      (text.includes("self-hosted") ? 0.16 : 0) +
      (text.includes("api") || text.includes("sdk") || text.includes("cli") ? 0.14 : 0) +
      Math.max(0, 0.25 - difficultHits * 0.08)
  );
  const differentiationSpace = clampScore(
    (text.includes("open source") || text.includes("open-source") ? 0.18 : 0) +
      (text.includes("self-hosted") ? 0.12 : 0) +
      (text.includes("workflow") || text.includes("automation") ? 0.12 : 0) +
      (text.includes("chinese") || /中文|国内|小红书|抖音|微信/.test(repo.description) ? 0.16 : 0) +
      0.18
  );
  const technicalQuality = clampScore(technicalScore * 0.65 + starScore * 0.25 + freshnessScore * 0.1);
  const opportunityScore = clampScore(
    monetizationScore * 0.28 +
      growthSignal * 0.18 +
      executionFit * 0.2 +
      differentiationSpace * 0.19 +
      technicalQuality * 0.15
  );

  return {
    opportunityScore,
    monetizationScore,
    growthSignal,
    executionFit,
    differentiationSpace,
    technicalQuality
  };
}

export function buildHeuristicOpportunityAnalysis(
  repo: RepoSummary,
  profile: OpportunityProfile,
  scores: ReturnType<typeof scoreOpportunitySignals>
): OpportunityAnalysis {
  const type = inferOpportunityType(repo);
  const targetCustomers = profile.targetCustomers.slice(0, 3);
  const monetizationPaths = inferMonetizationPaths(repo, profile);

  return {
    type,
    score: scores.opportunityScore,
    monetizationScore: scores.monetizationScore,
    growthSignal: scores.growthSignal,
    executionFit: scores.executionFit,
    differentiationSpace: scores.differentiationSpace,
    technicalQuality: scores.technicalQuality,
    targetCustomers,
    monetizationPaths,
    validationSteps: [
      "确认目标用户是否已经在 issue、讨论区或同类产品中表达强需求。",
      "用 1 个垂直场景包装最小可售卖方案，验证是否有人愿意付费。",
      "评估中文化、托管版、私有化部署或集成服务的差异化空间。"
    ],
    suggestedAction: suggestAction(scores.opportunityScore),
    evidence: [
      `${repo.primaryLanguage} 技术栈，当前约 ${repo.stars.toLocaleString("zh-CN")} 个 stars。`,
      repo.pushedAt ? `最近推送：${new Date(repo.pushedAt).toLocaleDateString("zh-CN")}。` : "",
      `${type} 方向可结合 ${monetizationPaths.slice(0, 2).join("、")} 做商业验证。`
    ].filter(Boolean)
  };
}

export function opportunityActionText(action: OpportunityAnalysis["suggestedAction"]) {
  switch (action) {
    case "build":
      return "立项验证";
    case "validate":
      return "验证需求";
    case "track":
      return "重点跟踪";
    case "observe":
      return "观察";
    case "ignore":
      return "忽略";
  }
}

function inferOpportunityType(repo: RepoSummary) {
  const text = `${repo.fullName} ${repo.description} ${repo.topics.join(" ")}`.toLowerCase();
  if (text.includes("mcp") || text.includes("plugin") || text.includes("extension")) return "插件/扩展机会";
  if (text.includes("self-hosted") || text.includes("deploy")) return "私有化部署机会";
  if (text.includes("api") || text.includes("sdk") || text.includes("integration")) return "集成/API 机会";
  if (text.includes("agent") || text.includes("workflow") || text.includes("automation")) return "Agent 自动化机会";
  if (text.includes("course") || text.includes("tutorial") || text.includes("awesome")) return "内容/课程机会";
  return "SaaS/工具机会";
}

function inferMonetizationPaths(repo: RepoSummary, profile: OpportunityProfile) {
  const text = `${repo.fullName} ${repo.description} ${repo.topics.join(" ")}`.toLowerCase();
  const paths = [];
  if (text.includes("self-hosted") || text.includes("deploy")) paths.push("私有化部署");
  if (text.includes("api") || text.includes("sdk") || text.includes("mcp")) paths.push("插件/API 集成");
  if (text.includes("workflow") || text.includes("automation") || text.includes("agent")) paths.push("自动化方案服务");
  if (text.includes("dashboard") || text.includes("platform")) paths.push("托管版 SaaS");
  paths.push(...profile.monetizationChannels.slice(0, 3));
  return [...new Set(paths)].slice(0, 5);
}

function suggestAction(score: number): OpportunityAnalysis["suggestedAction"] {
  if (score >= 0.82) return "build";
  if (score >= 0.68) return "validate";
  if (score >= 0.55) return "track";
  if (score >= 0.38) return "observe";
  return "ignore";
}

function freshness(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 0.2;
  const days = (Date.now() - time) / 86_400_000;
  if (days <= 7) return 1;
  if (days <= 30) return 0.8;
  if (days <= 90) return 0.55;
  return 0.25;
}

function nonEmptyList(value: string[] | undefined, fallback: string[]) {
  const normalized = (value ?? []).map((item) => item.trim()).filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function toSearchToken(value: string) {
  return value.toLowerCase().replace(/\s+/g, "-");
}
