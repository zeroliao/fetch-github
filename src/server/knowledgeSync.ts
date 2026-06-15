import crypto from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRecommendationSummaryZh } from "@/lib/recommendationText";
import type { Recommendation } from "@/lib/types";
import {
  listKnowledgeSyncs,
  listRecommendations,
  upsertKnowledgeSync,
  upgradeRepoDataLevel
} from "./store";

const DEFAULT_TARGET = "local-derived-index";
const DEFAULT_DATASET_ID = "default";
const AI_KNOWLEDGE_BASE_TARGET = "ai-knowledge-base";

export async function runKnowledgeSync(options: {
  target?: string;
  datasetId?: string;
  minScore?: number;
} = {}) {
  const target = options.target ?? DEFAULT_TARGET;
  const datasetId = options.datasetId ?? DEFAULT_DATASET_ID;
  const minScore = options.minScore ?? 0.8;
  const recommendations = (await listRecommendations()).filter((item) =>
    isL4Candidate(item, minScore)
  );
  const existing = await listKnowledgeSyncs();
  const existingHashes = new Set(
    existing
      .filter((item) => item.target === target && (item.datasetId ?? DEFAULT_DATASET_ID) === datasetId)
      .map((item) => `${item.repoId}:${item.contentHash}`)
  );

  let syncedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const syncs = [];

  for (const recommendation of recommendations) {
    const markdown = buildRecommendationMarkdown(recommendation);
    const contentHash = hashText(markdown);
    const key = `${recommendation.repo.id}:${contentHash}`;

    if (existingHashes.has(key)) {
      skippedCount += 1;
      syncs.push(
        await upsertKnowledgeSync({
          repoId: recommendation.repo.id,
          repoFullName: recommendation.repo.fullName,
          target,
          datasetId,
          contentHash,
          status: "skipped",
          syncedAt: new Date().toISOString()
        })
      );
      continue;
    }

    try {
      await upgradeRepoDataLevel([recommendation.repo], "L4");
      const externalDocId = await syncRecommendationToTarget({
        recommendation,
        markdown,
        contentHash,
        target
      });
      syncedCount += 1;
      syncs.push(
        await upsertKnowledgeSync({
          repoId: recommendation.repo.id,
          repoFullName: recommendation.repo.fullName,
          target,
          datasetId,
          externalDocId,
          contentHash,
          status: "synced",
          syncedAt: new Date().toISOString()
        })
      );
    } catch (error) {
      failedCount += 1;
      syncs.push(
        await upsertKnowledgeSync({
          repoId: recommendation.repo.id,
          repoFullName: recommendation.repo.fullName,
          target,
          datasetId,
          contentHash,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  return {
    target,
    datasetId,
    candidateCount: recommendations.length,
    syncedCount,
    skippedCount,
    failedCount,
    syncs
  };
}

async function syncRecommendationToTarget(input: {
  recommendation: Recommendation;
  markdown: string;
  contentHash: string;
  target: string;
}) {
  if (input.target === AI_KNOWLEDGE_BASE_TARGET) {
    return writeAiKnowledgeBaseDoc(
      input.recommendation,
      input.markdown,
      input.contentHash
    );
  }

  return `fetchgithub:${input.recommendation.repo.id}:${input.contentHash.slice(0, 12)}`;
}

export function buildRecommendationMarkdown(recommendation: Recommendation) {
  return [
    `# ${recommendation.repo.fullName}`,
    "",
    `GitHub: ${recommendation.repo.htmlUrl}`,
    `Score: ${Math.round(recommendation.scores.final * 100)}`,
    `Status: ${recommendation.status}`,
    `Language: ${recommendation.repo.primaryLanguage}`,
    `Topics: ${recommendation.repo.topics.join(", ") || "None"}`,
    "",
    "## Summary",
    getRecommendationSummaryZh(recommendation),
    "",
    "## Reasons",
    ...recommendation.reasons.map((reason) => `- ${reason}`),
    "",
    "## Risks",
    ...(recommendation.risks.length
      ? recommendation.risks.map((risk) => `- ${risk}`)
      : ["- None"]),
    "",
    "## Related User Repositories",
    ...(recommendation.relatedUserRepos.length
      ? recommendation.relatedUserRepos.map(
          (repo) => `- ${repo.fullName}: ${repo.reason} (${Math.round(repo.score * 100)})`
        )
      : ["- None"])
  ].join("\n");
}

function isL4Candidate(recommendation: Recommendation, minScore: number) {
  return (
    recommendation.status === "saved" ||
    recommendation.status === "tracked" ||
    recommendation.scores.final >= minScore
  );
}

function hashText(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function writeAiKnowledgeBaseDoc(
  recommendation: Recommendation,
  markdown: string,
  contentHash: string
) {
  if (!process.env.AI_KNOWLEDGE_BASE_DIR) {
    throw new Error("未配置 AI_KNOWLEDGE_BASE_DIR，无法写入 ai-knowledge-base。");
  }

  const baseDir = path.resolve(process.env.AI_KNOWLEDGE_BASE_DIR);
  try {
    const info = await stat(baseDir);
    if (!info.isDirectory()) {
      throw new Error("AI_KNOWLEDGE_BASE_DIR 不是有效目录。");
    }
  } catch {
    throw new Error(`未找到 ai-knowledge-base 目录：${baseDir}`);
  }

  const outputDir = path.join(baseDir, "derived", "fetchGithub");
  await mkdir(outputDir, { recursive: true });
  const safeName = recommendation.repo.fullName.replace(/[\\/]/g, "__");
  const fileName = `${safeName}-${contentHash.slice(0, 12)}.md`;
  const filePath = path.join(outputDir, fileName);
  await writeFile(filePath, markdown, "utf8");
  return `ai-knowledge-base:${path.relative(baseDir, filePath).replace(/\\/g, "/")}`;
}
