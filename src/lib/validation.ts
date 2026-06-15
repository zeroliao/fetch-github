import { z } from "zod";

const discoverySourceIdSchema = z.enum([
  "github_search_preferences",
  "github_topics",
  "github_search_stars",
  "github_search_recent_growth",
  "github_trending",
  "github_explore",
  "ossinsight_trending",
  "gharchive_velocity",
  "openssf_scorecard",
  "ecosystems_usage"
]);

export const providerSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["chat", "embedding"]),
  type: z.enum(["openai_compatible", "custom"]).default("openai_compatible"),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  model: z.string().min(1),
  apiKeyValue: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  timeoutSeconds: z.number().int().positive().optional(),
  rateLimit: z
    .object({
      requestsPerMinute: z.number().int().positive().optional(),
      tokensPerMinute: z.number().int().positive().optional()
    })
    .optional()
});

export const profileSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.object({
    schedule: z.object({
      type: z.enum(["cron", "interval"]),
      cron: z.string().optional(),
      intervalHours: z.number().int().positive().optional(),
      timezone: z.string().min(1),
      startAt: z.string().optional(),
      maxRuntimeMinutes: z.number().int().positive(),
      missedRunPolicy: z.enum(["skip", "run_once", "resume"])
    }),
    limits: z.object({
      sourceLimitPerQuery: z.number().int().positive(),
      maxCandidates: z.number().int().positive(),
      ruleFilterTopK: z.number().int().positive(),
      detailFetchTopK: z.number().int().positive(),
      embeddingTopK: z.number().int().positive(),
      llmAnalyzeTopK: z.number().int().positive(),
      finalReportTopK: z.number().int().positive()
    }),
    preferences: z.object({
      keywords: z.array(z.string()),
      topics: z.array(z.string()),
      languages: z.record(z.string(), z.number()),
      excludeKeywords: z.array(z.string()),
      minStars: z.number().int().nonnegative(),
      pushedWithinDays: z.number().int().positive(),
      excludeArchived: z.boolean(),
      excludeForks: z.boolean()
    }),
    opportunity: z
      .object({
        goals: z.array(z.string()),
        targetCustomers: z.array(z.string()),
        monetizationChannels: z.array(z.string()),
        preferredAdvantages: z.array(z.string()),
        excludeSignals: z.array(z.string()),
        minOpportunityScore: z.number().min(0).max(1)
      })
      .optional(),
    sources: z
      .array(
        z.object({
          id: discoverySourceIdSchema,
          enabled: z.boolean(),
          weight: z.number().positive()
        })
      )
      .optional(),
    resourcePolicy: z.object({
      mode: z.enum(["complete_low_memory", "balanced", "fast"]),
      memory: z.object({
        targetAvailableMb: z.number().int().positive(),
        minAvailableMb: z.number().int().positive(),
        criticalAvailableMb: z.number().int().positive()
      }),
      execution: z.object({
        batchSize: z.number().int().positive(),
        maxConcurrency: z.number().int().positive(),
        checkpointEveryItems: z.number().int().positive(),
        pauseOnPressure: z.boolean()
      })
    }),
    ai: z.object({
      chatProviderId: z.string().min(1),
      embeddingProviderId: z.string().min(1)
    })
  })
});

export const feedbackSchema = z.object({
  profileId: z.string().min(1),
  action: z.enum(["save", "hide", "like", "dislike", "track"]),
  note: z.string().optional()
});
