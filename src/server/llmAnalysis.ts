import { chunkText } from "@/lib/text";
import type { DiscoveryProfile, OpportunityAnalysis, RepoSummary } from "@/lib/types";
import { callChatJson } from "./aiClient";
import { getAiProvider } from "./store";

export const REPO_ANALYSIS_PROMPT_VERSION = "opportunity-radar-v1";

export interface RepoAnalysisInput {
  repo: RepoSummary;
  profile: DiscoveryProfile;
  readme: string;
}

export interface RepoAnalysisResult {
  summary: string;
  categories: string[];
  target_users: string[];
  core_features: string[];
  maturity: string;
  is_match: boolean;
  match_score: number;
  confidence: number;
  matched_preferences: string[];
  risks: string[];
  recommendation_reason: string;
  opportunity?: OpportunityAnalysis;
}

export async function analyzeRepoWithLlm(
  input: RepoAnalysisInput
): Promise<RepoAnalysisResult> {
  const provider = await getAiProvider(input.profile.config.ai.chatProviderId);
  if (!provider) {
    throw new Error("Chat 模型配置不存在。");
  }

  const chunks = chunkText(input.readme, 8000);
  const readmeForPrompt =
    chunks.length <= 1
      ? input.readme
      : chunks.map((chunk) => `Chunk ${chunk.index + 1}:\n${chunk.text}`).join("\n\n");

  const result = await callChatJson({
    provider,
    messages: [
      {
        role: "system",
        content:
          "你是商业机会雷达分析助手。你的目标不是普通技术推荐，而是判断 GitHub 项目是否暴露可变现机会。必须只返回合法 JSON，所有用户可见字段使用简体中文；技术名词、仓库名、模型名可以保留英文。"
      },
      {
        role: "user",
        content: JSON.stringify({
          prompt_version: REPO_ANALYSIS_PROMPT_VERSION,
          task: "分析候选 GitHub 仓库是否具备变现机会，并给出可执行的商业验证建议。",
          repo: input.repo,
          profile_preferences: input.profile.config.preferences,
          opportunity_profile: input.profile.config.opportunity,
          readme: readmeForPrompt,
          language_requirement: "不要原样复制 GitHub 英文描述，需要用中文概括商业含义、目标客户、变现路径和验证动作。",
          output_schema: {
            summary: "简体中文 string，说明这个项目暴露了什么变现机会",
            categories: ["简体中文 string"],
            target_users: ["简体中文 string"],
            core_features: ["简体中文 string"],
            maturity: "简体中文 string",
            is_match: "boolean",
            match_score: "number 0..1",
            confidence: "number 0..1",
            matched_preferences: ["简体中文 string"],
            risks: ["简体中文 string"],
            recommendation_reason: "简体中文 string",
            opportunity: {
              type: "简体中文 string，例如 SaaS/工具机会、Agent 自动化机会、私有化部署机会、插件/扩展机会、内容/课程机会",
              score: "number 0..1，综合机会分",
              monetizationScore: "number 0..1，变现潜力",
              growthSignal: "number 0..1，增长/市场信号",
              executionFit: "number 0..1，落地执行匹配度",
              differentiationSpace: "number 0..1，差异化空间",
              technicalQuality: "number 0..1，技术质量",
              targetCustomers: ["简体中文 string，谁可能付费"],
              monetizationPaths: ["简体中文 string，可变现方式"],
              validationSteps: ["简体中文 string，最小验证步骤"],
              suggestedAction: "observe | track | validate | build | ignore",
              evidence: ["简体中文 string，判断依据"]
            }
          }
        })
      }
    ]
  });

  return normalizeAnalysis(result);
}

function normalizeAnalysis(value: unknown): RepoAnalysisResult {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  return {
    summary: String(object.summary ?? ""),
    categories: stringArray(object.categories),
    target_users: stringArray(object.target_users),
    core_features: stringArray(object.core_features),
    maturity: String(object.maturity ?? "unknown"),
    is_match: Boolean(object.is_match),
    match_score: number01(object.match_score),
    confidence: number01(object.confidence),
    matched_preferences: stringArray(object.matched_preferences),
    risks: stringArray(object.risks),
    recommendation_reason: String(object.recommendation_reason ?? ""),
    opportunity: normalizeOpportunityAnalysis(object.opportunity)
  };
}

function normalizeOpportunityAnalysis(value: unknown): OpportunityAnalysis | undefined {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!object) {
    return undefined;
  }

  return {
    type: String(object.type ?? "SaaS/工具机会"),
    score: number01(object.score),
    monetizationScore: number01(object.monetizationScore),
    growthSignal: number01(object.growthSignal),
    executionFit: number01(object.executionFit),
    differentiationSpace: number01(object.differentiationSpace),
    technicalQuality: number01(object.technicalQuality),
    targetCustomers: stringArray(object.targetCustomers),
    monetizationPaths: stringArray(object.monetizationPaths),
    validationSteps: stringArray(object.validationSteps),
    suggestedAction: normalizeAction(object.suggestedAction),
    evidence: stringArray(object.evidence)
  };
}

function normalizeAction(value: unknown): OpportunityAnalysis["suggestedAction"] {
  return value === "build" ||
    value === "validate" ||
    value === "track" ||
    value === "observe" ||
    value === "ignore"
    ? value
    : "observe";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function number01(value: unknown): number {
  const number = Number(value);
  if (Number.isNaN(number)) {
    return 0;
  }

  return Math.max(0, Math.min(1, number));
}
