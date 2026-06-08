export const SCORE_VERSION = "mvp-v1";

export interface ScoreInput {
  ruleScore: number;
  githubContextFit: number;
  llmMatchScore: number;
  feedbackScore: number;
}

export function calculateFinalScore(input: ScoreInput): number {
  const score =
    input.ruleScore * 0.3 +
    input.githubContextFit * 0.25 +
    input.llmMatchScore * 0.3 +
    input.feedbackScore * 0.15;

  return Number(score.toFixed(4));
}

export function clampScore(score: number): number {
  if (Number.isNaN(score)) {
    return 0;
  }

  return Math.max(0, Math.min(1, score));
}
