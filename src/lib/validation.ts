import { z } from "zod";
import { normalizeOpportunityProfile } from "./opportunity";
import { MAX_AI_PROVIDER_MODELS } from "./types";

const proxyAddressSchema = z
  .string()
  .trim()
  .url()
  .refine(
    (value) =>
      ["http:", "https:", "socks5:", "socks5h:"].includes(
        new URL(value).protocol,
      ),
    { message: "代理地址仅支持 http、https、socks5 或 socks5h。" },
  );

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
  "ecosystems_usage",
]);

export const providerSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["chat", "embedding"]),
  type: z.enum(["openai_compatible", "custom"]).default("openai_compatible"),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1).optional(),
  model: z.string().min(1),
  apiKeyValue: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
  priority: z.number().int().min(1).max(10000).default(100),
  reasoningEffort: z
    .enum(["none", "default", "minimal", "low", "medium", "high", "xhigh"])
    .optional(),
  enabled: z.boolean().default(true),
  timeoutSeconds: z.number().int().positive().optional(),
  cooldownSeconds: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60)
    .default(300),
  cooldownOn: z
    .array(
      z.enum([
        "output_parse",
        "output_schema",
        "auth",
        "permission",
        "rate_limit",
        "timeout",
        "server",
        "network",
        "invalid_config",
        "unknown",
      ]),
    )
    .max(10)
    .default(["rate_limit", "timeout", "server", "network"]),
  rateLimit: z
    .object({
      requestsPerMinute: z.number().int().positive().optional(),
      tokensPerMinute: z.number().int().positive().optional(),
    })
    .optional(),
});

export const providerModelSchema = z
  .object({
    id: z.string().uuid().optional(),
    kind: z.enum(["chat", "embedding"]),
    model: z.string().trim().min(1).max(200),
    dimensions: z.number().int().positive().optional(),
    priority: z.number().int().min(1).max(10000).default(100),
    reasoningEffort: z
      .enum(["none", "default", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
    enabled: z.boolean().default(true),
    timeoutSeconds: z.number().int().positive().optional(),
    cooldownSeconds: z.number().int().positive().max(86400).default(300),
    cooldownOn: providerSchema.shape.cooldownOn,
  })
  .superRefine((value, context) => {
    if (value.kind === "embedding" && !value.dimensions) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dimensions"],
        message: "Embedding model dimensions are required.",
      });
    }
  });

export const providerConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(["openai_compatible", "custom"]).default("openai_compatible"),
  baseUrl: z.string().url(),
  apiKeyValue: z.string().optional(),
  proxyAddresses: z.array(proxyAddressSchema).max(32).optional().default([]),
  enabled: z.boolean().default(true),
});

export const providerGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(["openai_compatible", "custom"]).default("openai_compatible"),
    baseUrl: z.string().url(),
    apiKeyValue: z.string().optional(),
    proxyAddresses: z.array(proxyAddressSchema).max(32).optional().default([]),
    enabled: z.boolean().default(true),
    models: z.array(providerModelSchema).max(MAX_AI_PROVIDER_MODELS),
  })
  .superRefine((value, context) => {
    value.models.forEach((model, index) => {
      if (model.kind === "embedding" && !model.dimensions) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["models", index, "dimensions"],
          message: "Embedding 模型必须填写向量维度。",
        });
      }
    });
  });

export const profileSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.object({
    schedule: z
      .object({
        type: z.enum(["cron", "interval"]).optional(),
        cron: z.string().optional(),
        intervalHours: z.number().int().positive().optional(),
        timezone: z.string().min(1).optional(),
        startAt: z.string().optional(),
        maxRuntimeMinutes: z.number().int().positive().optional(),
        missedRunPolicy: z.enum(["skip", "run_once", "resume"]).default("skip"),
      })
      .default({ missedRunPolicy: "skip" }),
    limits: z
      .object({
        sourceLimitPerQuery: z.number().int().positive().optional(),
        maxCandidates: z.number().int().positive().optional(),
        ruleFilterTopK: z.number().int().positive().optional(),
        detailFetchTopK: z.number().int().positive().optional(),
        embeddingTopK: z.number().int().positive().optional(),
        llmAnalyzeTopK: z.number().int().positive().optional(),
        semanticFitThreshold: z.number().min(0).max(1).optional(),
        finalReportTopK: z.number().int().positive().optional(),
      })
      .default({}),
    preferences: z
      .object({
        keywords: z.array(z.string()).default([]),
        topics: z.array(z.string()).default([]),
        languages: z.record(z.string(), z.number()).default({}),
        excludeKeywords: z.array(z.string()).default([]),
        minStars: z.number().int().nonnegative().default(0),
        pushedWithinDays: z.number().int().positive().default(365),
        excludeArchived: z.boolean().default(true),
        excludeForks: z.boolean().default(true),
      })
      .default({
        keywords: [],
        topics: [],
        languages: {},
        excludeKeywords: [],
        minStars: 0,
        pushedWithinDays: 365,
        excludeArchived: true,
        excludeForks: true,
      }),
    opportunity: z
      .object({
        brief: z.string().max(2000).optional(),
        goals: z.array(z.string()).optional(),
        targetCustomers: z.array(z.string()).optional(),
        monetizationChannels: z.array(z.string()).optional(),
        preferredAdvantages: z.array(z.string()).optional(),
        excludeSignals: z.array(z.string()).optional(),
        minOpportunityScore: z.number().min(0).max(1).optional(),
      })
      .transform((value) => normalizeOpportunityProfile(value))
      .optional(),
    sources: z
      .array(
        z.object({
          id: discoverySourceIdSchema,
          enabled: z.boolean(),
          weight: z.number().positive(),
        }),
      )
      .optional(),
    resourcePolicy: z
      .object({
        minAvailableMemoryMb: z.number().int().positive().optional(),
        mode: z.enum(["complete_low_memory", "balanced", "fast"]).optional(),
        memory: z
          .object({
            targetAvailableMb: z.number().int().positive().optional(),
            minAvailableMb: z.number().int().positive().optional(),
            criticalAvailableMb: z.number().int().positive().optional(),
          })
          .optional(),
        execution: z
          .object({
            batchSize: z.number().int().positive().optional(),
            maxConcurrency: z.number().int().positive().optional(),
            checkpointEveryItems: z.number().int().positive().optional(),
            pauseOnPressure: z.boolean().optional(),
          })
          .optional(),
      })
      .default({}),
    ai: z
      .object({
        chatProviderId: z.string().min(1).optional(),
        embeddingProviderId: z.string().min(1).optional(),
      })
      .default({}),
  }),
});

export const feedbackSchema = z.object({
  profileId: z.string().min(1),
  action: z.enum([
    "save",
    "unsave",
    "hide",
    "restore",
    "like",
    "dislike",
    "set_pending",
    "set_liked",
    "set_disliked",
    "track",
    "untrack",
    "to_validate",
    "validating",
    "mark_validated",
    "mark_qualified",
    "mark_not_qualified",
    "reset_qualification",
    "monetization_ready",
    "abandon",
    "reopen",
  ]),
  note: z.string().optional(),
});
