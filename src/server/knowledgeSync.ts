import crypto from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Recommendation } from "@/lib/types";
import {
  listKnowledgeSyncs,
  listRecommendations,
  upsertKnowledgeSync,
  upgradeRepoDataLevel
} from "./store";

const DEFAULT_TARGET = "local-derived-index";
const DEFAULT_DATASET_ID = "default";

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

    await upgradeRepoDataLevel([recommendation.repo], "L4");
    const externalDocId = await writeOptionalAiKnowledgeBaseDoc(
      recommendation,
      markdown,
      contentHash
    );
    syncedCount += 1;
    syncs.push(
      await upsertKnowledgeSync({
        repoId: recommendation.repo.id,
        repoFullName: recommendation.repo.fullName,
        target,
        datasetId,
        externalDocId:
          externalDocId ?? `fetchgithub:${recommendation.repo.id}:${contentHash.slice(0, 12)}`,
        contentHash,
        status: "synced",
        syncedAt: new Date().toISOString()
      })
    );
  }

  return {
    target,
    datasetId,
    candidateCount: recommendations.length,
    syncedCount,
    skippedCount,
    syncs
  };
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
    recommendation.summary,
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

async function writeOptionalAiKnowledgeBaseDoc(
  recommendation: Recommendation,
  markdown: string,
  contentHash: string
) {
  const baseDir = path.resolve(process.cwd(), "../ai-knowledge-base");
  try {
    const info = await stat(baseDir);
    if (!info.isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const outputDir = path.join(baseDir, "derived", "fetchGithub");
  await mkdir(outputDir, { recursive: true });
  const safeName = recommendation.repo.fullName.replace(/[\\/]/g, "__");
  const fileName = `${safeName}-${contentHash.slice(0, 12)}.md`;
  const filePath = path.join(outputDir, fileName);
  await writeFile(filePath, markdown, "utf8");
  return `ai-knowledge-base:${path.relative(baseDir, filePath).replace(/\\/g, "/")}`;
}
