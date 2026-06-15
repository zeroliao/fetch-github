export const SCORE_VERSION = "opportunity-radar-v1";

export interface ScoreInput {
  ruleScore: number;
  githubContextFit: number;
  llmMatchScore: number;
  feedbackScore: number;
  opportunityScore?: number;
  monetizationScore?: number;
  growthSignal?: number;
  executionFit?: number;
  differentiationSpace?: number;
  technicalQuality?: number;
}

export function calculateFinalScore(input: ScoreInput): number {
  const opportunityScore = input.opportunityScore ?? input.llmMatchScore;
  const monetizationScore = input.monetizationScore ?? input.llmMatchScore;
  const growthSignal = input.growthSignal ?? input.ruleScore;
  const executionFit = input.executionFit ?? input.githubContextFit;
  const differentiationSpace = input.differentiationSpace ?? input.llmMatchScore;
  const technicalQuality = input.technicalQuality ?? input.ruleScore;
  const score =
    opportunityScore * 0.25 +
    monetizationScore * 0.25 +
    growthSignal * 0.15 +
    executionFit * 0.15 +
    differentiationSpace * 0.1 +
    technicalQuality * 0.05 +
    input.feedbackScore * 0.05;

  return Number(score.toFixed(4));
}

export function clampScore(score: number): number {
  if (Number.isNaN(score)) {
    return 0;
  }

  return Math.max(0, Math.min(1, score));
}
