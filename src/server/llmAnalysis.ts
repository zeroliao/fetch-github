import { chunkText } from "@/lib/text";
import type { DiscoveryProfile, RepoSummary } from "@/lib/types";
import { callChatJson } from "./aiClient";
import { getAiProvider } from "./store";

export const REPO_ANALYSIS_PROMPT_VERSION = "repo-analysis-v2-cn-display";

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
          "你是 GitHub 项目推荐分析助手。必须只返回合法 JSON，且 summary、categories、target_users、core_features、maturity、matched_preferences、risks、recommendation_reason 等用户可见字段必须使用简体中文。"
      },
      {
        role: "user",
        content: JSON.stringify({
          prompt_version: REPO_ANALYSIS_PROMPT_VERSION,
          task: "分析候选 GitHub 仓库是否匹配发现配置，并用简体中文解释推荐价值。",
          repo: input.repo,
          profile_preferences: input.profile.config.preferences,
          readme: readmeForPrompt,
          language_requirement: "所有用户可见文本字段必须使用简体中文；仓库名、技术名词、topic 和模型名可以保留英文。不要原样复制 GitHub 英文描述，需要用中文概括其含义和推荐价值。",
          output_schema: {
            summary: "简体中文 string，说明这个项目是什么以及为什么值得看",
            categories: ["简体中文 string"],
            target_users: ["简体中文 string"],
            core_features: ["简体中文 string"],
            maturity: "简体中文 string",
            is_match: "boolean",
            match_score: "number 0..1",
            confidence: "number 0..1",
            matched_preferences: ["简体中文 string"],
            risks: ["简体中文 string"],
            recommendation_reason: "简体中文 string"
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
    recommendation_reason: String(object.recommendation_reason ?? "")
  };
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
