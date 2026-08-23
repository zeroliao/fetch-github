import { z } from "zod";
import { compactMarkdownForAnalysis } from "@/lib/text";
import type { AiProvider, DiscoveryProfile, RepoSummary } from "@/lib/types";
import { AiProviderOutputSchemaError, callChatJsonWithUsage } from "./aiClient";

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
    private: repo.private ?? false,
  };
}

const scoreSchema = z.number().finite().min(0).max(1);
const textSchema = z.string().trim().min(1);
const textListSchema = z.array(textSchema).max(30);

export const repoAnalysisResultSchema = z
  .object({
    summary: textSchema.max(4_000),
    categories: textListSchema,
    target_users: textListSchema,
    core_features: textListSchema,
    maturity: textSchema.max(200),
    is_match: z.boolean(),
    match_score: scoreSchema,
    confidence: scoreSchema,
    matched_preferences: textListSchema,
    risks: textListSchema,
    recommendation_reason: textSchema.max(4_000),
    opportunity: z
      .object({
        type: textSchema.max(300),
        score: scoreSchema,
        monetizationScore: scoreSchema,
        growthSignal: scoreSchema,
        executionFit: scoreSchema,
        differentiationSpace: scoreSchema,
        technicalQuality: scoreSchema,
        targetCustomers: textListSchema,
        monetizationPaths: textListSchema,
        validationSteps: textListSchema,
        suggestedAction: z.enum([
          "observe",
          "track",
          "validate",
          "build",
          "ignore",
        ]),
        evidence: textListSchema,
      })
      .strict(),
  })
  .strict();

type ParsedRepoAnalysisResult = z.infer<typeof repoAnalysisResultSchema>;
export type RepoAnalysisResult = Omit<
  ParsedRepoAnalysisResult,
  "opportunity"
> & {
  opportunity?: ParsedRepoAnalysisResult["opportunity"];
};

export async function analyzeRepoWithLlm(
  input: RepoAnalysisInput,
  provider: AiProvider,
): Promise<RepoAnalysisResult> {
  return (await analyzeRepoWithLlmWithUsage(input, provider)).analysis;
}

export async function analyzeRepoWithLlmWithUsage(
  input: RepoAnalysisInput,
  provider: AiProvider,
): Promise<{
  analysis: RepoAnalysisResult;
  tokenUsage: Record<string, unknown>;
}> {
  const isDelta = Boolean(input.previousAnalysis);
  const readmeForPrompt = compactMarkdownForAnalysis(
    input.readme,
    isDelta ? README_DELTA_ANALYSIS_MAX_CHARS : README_ANALYSIS_MAX_CHARS,
  );

  const result = await callChatJsonWithUsage({
    provider,
    messages: [
      {
        role: "system",
        content:
          "你是商业机会雷达。判断 GitHub 项目是否有变现机会。只返回合法 JSON。用户可见文本用简体中文，技术名词可保留英文。",
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
              changeHint: input.changeHint,
            })
          : buildRepoAnalysisPrompt({
              repo: input.repo,
              profile: input.profile,
              readme: readmeForPrompt,
              compressed: readmeForPrompt.length < input.readme.length,
            }),
      },
    ],
  });

  return {
    analysis: parseRepoAnalysisResult(result.data),
    tokenUsage: result.usage,
  };
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
      "返回完整 JSON，字段同 full prompt: summary,categories,target_users,core_features,maturity,is_match,match_score,confidence,matched_preferences,risks,recommendation_reason,opportunity{type,score,monetizationScore,growthSignal,executionFit,differentiationSpace,technicalQuality,targetCustomers,monetizationPaths,validationSteps,suggestedAction,evidence}. 用户可见文本用简体中文。",
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
          validationSteps: previous.opportunity.validationSteps.slice(0, 5),
        }
      : undefined,
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
      "JSON keys: summary,categories,target_users,core_features,maturity,is_match,match_score,confidence,matched_preferences,risks,recommendation_reason,opportunity{type,score,monetizationScore,growthSignal,executionFit,differentiationSpace,technicalQuality,targetCustomers,monetizationPaths,validationSteps,suggestedAction,evidence}. summary 只写一句中文功能简介，优先说明项目是做什么的、给谁用、能解决什么问题。Scores 0..1. suggestedAction=observe|track|validate|build|ignore.",
  });
}

export function parseRepoAnalysisResult(value: unknown): RepoAnalysisResult {
  const parsed = repoAnalysisResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const normalized = normalizeRepoAnalysisResult(value);
  const normalizedParsed = repoAnalysisResultSchema.safeParse(normalized);
  if (normalizedParsed.success) return normalizedParsed.data;

  const issueSummary = normalizedParsed.error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`)
    .join(", ");
  throw new AiProviderOutputSchemaError(issueSummary);
}

const OPPORTUNITY_ACTIONS = new Set([
  "observe",
  "track",
  "validate",
  "build",
  "ignore",
] as const);

function normalizeRepoAnalysisResult(value: unknown) {
  const source = asRecord(value);
  const opportunity = asRecord(source.opportunity);
  const sourceWithoutAliases = { ...source };
  for (const alias of [
    "targetUsers",
    "coreFeatures",
    "isMatch",
    "matchScore",
    "matchedPreferences",
    "recommendationReason",
  ]) {
    delete sourceWithoutAliases[alias];
  }
  return {
    ...sourceWithoutAliases,
    summary:
      source.summary === undefined
        ? undefined
        : normalizeText(source.summary, "未提供项目摘要"),
    categories: normalizeList(source.categories),
    target_users: normalizeList(source.target_users ?? source.targetUsers),
    core_features: normalizeList(source.core_features ?? source.coreFeatures),
    maturity:
      source.maturity === undefined
        ? undefined
        : normalizeText(source.maturity, "unknown"),
    is_match: normalizeBoolean(source.is_match ?? source.isMatch),
    match_score: normalizeScore(source.match_score ?? source.matchScore),
    confidence: normalizeScore(source.confidence),
    matched_preferences: normalizeList(
      source.matched_preferences ?? source.matchedPreferences,
    ),
    risks: normalizeList(source.risks),
    recommendation_reason:
      source.recommendation_reason === undefined &&
      source.recommendationReason === undefined
        ? undefined
        : normalizeText(
            source.recommendation_reason ?? source.recommendationReason,
            "暂无推荐理由",
          ),
    opportunity: {
      ...opportunity,
      type: normalizeText(opportunity.type, "general"),
      score: normalizeScore(opportunity.score),
      monetizationScore: normalizeScore(opportunity.monetizationScore),
      growthSignal: normalizeScore(opportunity.growthSignal),
      executionFit: normalizeScore(opportunity.executionFit),
      differentiationSpace: normalizeScore(opportunity.differentiationSpace),
      technicalQuality: normalizeScore(opportunity.technicalQuality),
      targetCustomers: normalizeList(opportunity.targetCustomers),
      monetizationPaths: normalizeList(opportunity.monetizationPaths),
      validationSteps: normalizeList(opportunity.validationSteps),
      suggestedAction: normalizeAction(opportunity.suggestedAction),
      evidence: normalizeList(opportunity.evidence),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(value: unknown, fallback = ""): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item, ""))
      .filter(Boolean)
      .slice(0, 30);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/[,，;；\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 30);
  }
  return [];
}

function normalizeBoolean(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "是", "匹配", "符合"].includes(normalized)) {
      return true;
    }
    if (
      ["false", "0", "no", "n", "否", "不匹配", "不符合"].includes(normalized)
    ) {
      return false;
    }
  }
  return value;
}

function normalizeScore(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return 0.5;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : value;
  }
  return value;
}

function normalizeAction(
  value: unknown,
): "observe" | "track" | "validate" | "build" | "ignore" | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (OPPORTUNITY_ACTIONS.has(normalized as never)) {
      return normalized as
        "observe" | "track" | "validate" | "build" | "ignore";
    }
    if (/build|构建|开发|实现/.test(normalized)) return "build";
    if (/track|跟踪|关注/.test(normalized)) return "track";
    if (/valid|验证|测试|试验/.test(normalized)) return "validate";
    if (/ignore|忽略|跳过|不推荐/.test(normalized)) return "ignore";
  }
  return "observe";
}
