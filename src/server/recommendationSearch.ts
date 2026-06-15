import crypto from "node:crypto";
import { cosineSimilarity } from "@/lib/semanticGate";
import type { Recommendation } from "@/lib/types";
import { callEmbedding } from "@/server/aiClient";
import {
  getAiProvider,
  getCachedEmbedding,
  getRepoEmbeddingVector,
  listProfiles,
  listRecommendations,
  upsertCachedEmbedding
} from "@/server/store";

export interface RecommendationSearchResult {
  id: string;
  score: number;
  semanticScore?: number;
  lexicalScore: number;
  mode: "semantic" | "hybrid" | "lexical";
}

export interface RecommendationSearchResponse {
  query: string;
  mode: "semantic" | "hybrid" | "lexical";
  providerReady: boolean;
  results: RecommendationSearchResult[];
  warning?: string;
}

export async function searchRecommendations(input: {
  query: string;
  profileId?: string;
  limit?: number;
}): Promise<RecommendationSearchResponse> {
  const query = input.query.trim();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const recommendations = (await listRecommendations()).filter(
    (item) => !input.profileId || item.profileId === input.profileId
  );

  if (!query) {
    return {
      query,
      mode: "lexical",
      providerReady: false,
      results: recommendations.slice(0, limit).map((item) => ({
        id: item.id,
        score: item.scores.final,
        lexicalScore: 1,
        mode: "lexical"
      }))
    };
  }

  const semantic: {
    vector?: number[];
    providerId?: string;
    model?: string;
    warning?: string;
  } = await getQueryEmbedding(query, input.profileId).catch((error) => ({
    vector: undefined,
    warning: error instanceof Error ? error.message : String(error)
  }));

  const results = await Promise.all(
    recommendations.map(async (recommendation) => {
      const lexicalScore = lexicalRecommendationSearchScore(recommendation, query);
      const semanticScore = semantic.vector && semantic.providerId && semantic.model
        ? await getRecommendationSemanticScore(recommendation, semantic.providerId, semantic.model, semantic.vector)
        : undefined;
      const score =
        semanticScore === undefined
          ? lexicalScore
          : Math.max(semanticScore, lexicalScore * 0.85);
      const mode = semanticScore === undefined ? "lexical" : lexicalScore > 0 ? "hybrid" : "semantic";

      return {
        id: recommendation.id,
        score,
        semanticScore,
        lexicalScore,
        mode
      } satisfies RecommendationSearchResult;
    })
  );

  const filtered = results
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const hasSemantic = filtered.some((item) => item.semanticScore !== undefined);
  return {
    query,
    mode: hasSemantic ? (filtered.some((item) => item.lexicalScore > 0) ? "hybrid" : "semantic") : "lexical",
    providerReady: Boolean(semantic.vector),
    results: filtered,
    warning: semantic.warning
  };
}

export function lexicalRecommendationSearchScore(recommendation: Recommendation, query: string) {
  const normalizedQuery = normalizeText(query);
  const terms = normalizedQuery.split(/\s+/).filter((term) => term.length >= 2);
  if (!terms.length) {
    return 0;
  }

  const text = normalizeText(buildRecommendationSearchText(recommendation));
  let hits = 0;
  let weightedHits = 0;
  for (const term of terms) {
    if (!text.includes(term)) {
      continue;
    }
    hits += 1;
    weightedHits += recommendation.repo.fullName.toLowerCase().includes(term) ? 1.35 : 1;
  }

  if (!hits) {
    return 0;
  }

  return Math.min(1, weightedHits / Math.max(terms.length, 1));
}

function buildRecommendationSearchText(recommendation: Recommendation) {
  return [
    recommendation.repo.fullName,
    recommendation.repo.description,
    recommendation.repo.primaryLanguage,
    recommendation.repo.topics.join(" "),
    recommendation.summaryZh,
    recommendation.summary,
    recommendation.opportunity?.type,
    recommendation.opportunity?.targetCustomers.join(" "),
    recommendation.opportunity?.monetizationPaths.join(" "),
    recommendation.opportunity?.validationSteps.join(" "),
    recommendation.cluster?.label,
    recommendation.cluster?.representativeTerms.join(" "),
    recommendation.reasons.join(" "),
    recommendation.matchedPreferences.join(" ")
  ]
    .filter(Boolean)
    .join("\n");
}

async function getQueryEmbedding(query: string, profileId?: string) {
  const profiles = await listProfiles();
  const profile =
    profiles.find((item) => item.id === profileId) ??
    profiles.find((item) => item.enabled) ??
    profiles[0];
  if (!profile) {
    throw new Error("没有可用的发现配置，已改用文本匹配。");
  }

  const provider = await getAiProvider(profile.config.ai.embeddingProviderId);
  if (!provider || provider.kind !== "embedding") {
    throw new Error("当前发现配置没有可用的 Embedding 模型，已改用文本匹配。");
  }

  const contentHash = hashText(normalizeText(query));
  const cacheKey = `recommendation-search:${profile.id}:${contentHash.slice(0, 16)}`;
  const cached = await getCachedEmbedding({
    cacheKey,
    providerId: provider.id,
    model: provider.model,
    contentHash
  });
  if (cached?.vector?.length) {
    return { vector: cached.vector, providerId: provider.id, model: provider.model };
  }

  const [vector] = await callEmbedding(provider, query);
  if (!vector?.length) {
    throw new Error("Embedding 模型没有返回可用向量，已改用文本匹配。");
  }

  await upsertCachedEmbedding({
    cacheKey,
    providerId: provider.id,
    model: provider.model,
    dimensions: provider.dimensions ?? vector.length,
    contentHash,
    vector
  });

  return { vector, providerId: provider.id, model: provider.model };
}

async function getRecommendationSemanticScore(
  recommendation: Recommendation,
  providerId: string,
  model: string,
  queryVector: number[]
) {
  const embedding = await getRepoEmbeddingVector({
    repoId: recommendation.repo.id,
    providerId,
    model
  });
  if (!embedding?.vector?.length) {
    return undefined;
  }

  return cosineSimilarity(queryVector, embedding.vector);
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hashText(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
