import { chunkText } from "@/lib/text";
import type { DiscoveryProfile, RepoSummary } from "@/lib/types";
import { callChatJson } from "./aiClient";
import { getAiProvider } from "./store";

export const REPO_ANALYSIS_PROMPT_VERSION = "repo-analysis-v1";

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
    throw new Error("Chat provider not found.");
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
          "You analyze GitHub repositories for a personalized recommendation system. Return valid JSON only."
      },
      {
        role: "user",
        content: JSON.stringify({
          prompt_version: REPO_ANALYSIS_PROMPT_VERSION,
          task: "Analyze whether the candidate repository matches the discovery profile.",
          repo: input.repo,
          profile_preferences: input.profile.config.preferences,
          readme: readmeForPrompt,
          output_schema: {
            summary: "string",
            categories: ["string"],
            target_users: ["string"],
            core_features: ["string"],
            maturity: "string",
            is_match: "boolean",
            match_score: "number 0..1",
            confidence: "number 0..1",
            matched_preferences: ["string"],
            risks: ["string"],
            recommendation_reason: "string"
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
