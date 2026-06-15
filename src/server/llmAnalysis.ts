import { compactMarkdownForAnalysis } from "@/lib/text";
import type { DiscoveryProfile, OpportunityAnalysis, RepoSummary } from "@/lib/types";
import { callChatJson } from "./aiClient";
import { getAiProvider } from "./store";

export const REPO_ANALYSIS_PROMPT_VERSION = "opportunity-radar-v3";
export const REPO_DELTA_ANALYSIS_PROMPT_VERSION = "opportunity-radar-delta-v1";
const README_ANALYSIS_MAX_CHARS = 7000;
const README_DELTA_ANALYSIS_MAX_CHARS = 2600;

export interface RepoAnalysisInput {
  repo: RepoSummary;
  profile: DiscoveryProfile;
  readme: string;
  previousAnalysis?: RepoAnalysisResult;
  changeHint?: string;
}

export function buildRepoAnalysisPromptRepo(repo: RepoSummary) {
  return {
    fullName: repo.fullName,
    description: repo.description,
    primaryLanguage: repo.primaryLanguage,
    topics: repo.topics,
    stars: repo.stars,
    forks: repo.forks,
    openIssues: repo.openIssues,
    pushedAt: repo.pushedAt,
    updatedAt: repo.updatedAt,
    archived: repo.archived,
    fork: repo.fork,
    private: repo.private ?? false
  };
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

  const isDelta = Boolean(input.previousAnalysis);
  const readmeForPrompt = compactMarkdownForAnalysis(
    input.readme,
    isDelta ? README_DELTA_ANALYSIS_MAX_CHARS : README_ANALYSIS_MAX_CHARS
  );

  const result = await callChatJson({
    provider,
    messages: [
      {
        role: "system",
        content:
          "你是商业机会雷达。判断 GitHub 项目是否有变现机会。只返回合法 JSON。用户可见文本用简体中文，技术名词可保留英文。"
      },
      {
        role: "user",
        content: isDelta
          ? buildRepoDeltaAnalysisPrompt({
              repo: input.repo,
              profile: input.profile,
              readme: readmeForPrompt,
              compressed: readmeForPrompt.length < input.readme.length,
              previousAnalysis: input.previousAnalysis,
              changeHint: input.changeHint
            })
          : buildRepoAnalysisPrompt({
              repo: input.repo,
              profile: input.profile,
              readme: readmeForPrompt,
              compressed: readmeForPrompt.length < input.readme.length
            })
      }
    ]
  });

  return normalizeAnalysis(result);
}

export function buildRepoDeltaAnalysisPrompt(input: {
  repo: RepoSummary;
  profile: DiscoveryProfile;
  readme: string;
  compressed: boolean;
  previousAnalysis?: RepoAnalysisResult;
  changeHint?: string;
}) {
  return JSON.stringify({
    v: REPO_DELTA_ANALYSIS_PROMPT_VERSION,
    task: "基于已有分析和变化摘要，重新评估变现机会。重点更新变化影响，不复述无变化内容。",
    repo: buildRepoAnalysisPromptRepo(input.repo),
    pref: input.profile.config.preferences,
    opp: input.profile.config.opportunity,
    previous: compactPreviousAnalysis(input.previousAnalysis),
    changeHint: input.changeHint ?? "metadata_or_activity_changed",
    changedContext: input.readme,
    readmeCompressed: input.compressed,
    output:
      "返回完整 JSON，字段同 full prompt: summary,categories,target_users,core_features,maturity,is_match,match_score,confidence,matched_preferences,risks,recommendation_reason,opportunity{type,score,monetizationScore,growthSignal,executionFit,differentiationSpace,technicalQuality,targetCustomers,monetizationPaths,validationSteps,suggestedAction,evidence}. 用户可见文本用简体中文。"
  });
}

function compactPreviousAnalysis(previous?: RepoAnalysisResult) {
  if (!previous) {
    return undefined;
  }

  return {
    summary: previous.summary,
    is_match: previous.is_match,
    match_score: previous.match_score,
    matched_preferences: previous.matched_preferences.slice(0, 8),
    risks: previous.risks.slice(0, 6),
    recommendation_reason: previous.recommendation_reason,
    opportunity: previous.opportunity
      ? {
          type: previous.opportunity.type,
          score: previous.opportunity.score,
          monetizationScore: previous.opportunity.monetizationScore,
          suggestedAction: previous.opportunity.suggestedAction,
          monetizationPaths: previous.opportunity.monetizationPaths.slice(0, 5),
          validationSteps: previous.opportunity.validationSteps.slice(0, 5)
        }
      : undefined
  };
}

export function buildRepoAnalysisPrompt(input: {
  repo: RepoSummary;
  profile: DiscoveryProfile;
  readme: string;
  compressed: boolean;
}) {
  return JSON.stringify({
    v: REPO_ANALYSIS_PROMPT_VERSION,
    task: "评估变现机会，给可执行验证建议。summary 必须直接说明项目功能和用途，用简体中文，避免“是一个项目”“适合进一步评估”等套话，不要复述英文描述。",
    repo: buildRepoAnalysisPromptRepo(input.repo),
    pref: input.profile.config.preferences,
    opp: input.profile.config.opportunity,
    readme: input.readme,
    readmeCompressed: input.compressed,
    output:
      "JSON keys: summary,categories,target_users,core_features,maturity,is_match,match_score,confidence,matched_preferences,risks,recommendation_reason,opportunity{type,score,monetizationScore,growthSignal,executionFit,differentiationSpace,technicalQuality,targetCustomers,monetizationPaths,validationSteps,suggestedAction,evidence}. summary 只写一句中文功能简介，优先说明项目是做什么的、给谁用、能解决什么问题。Scores 0..1. suggestedAction=observe|track|validate|build|ignore."
  });
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
