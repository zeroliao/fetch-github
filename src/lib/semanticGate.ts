import { clampScore } from "./scoring";
import type { DiscoveryProfileConfig } from "./types";

export const DEFAULT_SEMANTIC_FIT_THRESHOLD = 0.42;
const HIGH_PRIORITY_LLM_BYPASS = 0.72;

export function normalizeSemanticFitThreshold(value: unknown) {
  const number = Number(value ?? DEFAULT_SEMANTIC_FIT_THRESHOLD);
  if (!Number.isFinite(number)) {
    return DEFAULT_SEMANTIC_FIT_THRESHOLD;
  }

  return clampScore(number);
}

export function normalizeDiscoveryLimits(
  limits: DiscoveryProfileConfig["limits"]
): DiscoveryProfileConfig["limits"] {
  return {
    ...limits,
    semanticFitThreshold: normalizeSemanticFitThreshold(limits.semanticFitThreshold)
  };
}

export function shouldDeferLlmBySemanticFit(input: {
  semanticFit?: number;
  threshold?: number;
  priorityScore: number;
  opportunityScore?: number;
  minOpportunityScore?: number;
}) {
  if (input.semanticFit === undefined || !Number.isFinite(input.semanticFit)) {
    return false;
  }

  const threshold = normalizeSemanticFitThreshold(input.threshold);
  if (input.semanticFit >= threshold) {
    return false;
  }

  if (input.priorityScore >= HIGH_PRIORITY_LLM_BYPASS) {
    return false;
  }

  if (
    input.opportunityScore !== undefined &&
    input.opportunityScore >= (input.minOpportunityScore ?? 0.55)
  ) {
    return false;
  }

  return true;
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) {
    return undefined;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return undefined;
    }
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (!leftNorm || !rightNorm) {
    return undefined;
  }

  return clampScore(dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}
