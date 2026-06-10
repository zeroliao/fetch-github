import { z } from "zod";
import type { DiscoveryProfile } from "@/lib/types";
import { buildGitHubSearchQueryPlans } from "./githubSearch";
import { callChatJson } from "./aiClient";
import { getAiProvider } from "./store";

const MAX_KEYWORDS = 10;
const MAX_TOPICS = 10;
const MAX_LANGUAGES = 6;
const MAX_EXCLUDES = 10;

export const generatedPreferencesSchema = z.object({
  keywords: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  languages: z.record(z.string(), z.number()).default({}),
  excludeKeywords: z.array(z.string()).default([]),
  minStars: z.number().int().nonnegative().default(100),
  pushedWithinDays: z.number().int().positive().default(180),
  excludeArchived: z.boolean().default(true),
  excludeForks: z.boolean().default(true),
  notes: z.array(z.string()).default([])
});

export type GeneratedDiscoveryPreferences = z.infer<typeof generatedPreferencesSchema>;

export async function generateDiscoveryPreferences(input: {
  prompt: string;
  profile: DiscoveryProfile;
}): Promise<GeneratedDiscoveryPreferences> {
  const provider = await getAiProvider(input.profile.config.ai.chatProviderId);
  if (!provider?.enabled) {
    return heuristicDiscoveryPreferences(input.prompt, ["Chat 模型未启用，已使用本地规则生成。"]);
  }

  try {
    const result = await callChatJson({
      provider,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "你负责把中文自然语言需求解析为 GitHub 仓库发现条件。只返回 JSON。关键词、topic、语言名应优先使用 GitHub 常见英文表达；说明 notes 使用简体中文。"
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "从用户需求中提取适合 GitHub Search 粗召回的结构化发现条件。",
            user_prompt: input.prompt,
            current_preferences: input.profile.config.preferences,
            limits: {
              max_keywords: MAX_KEYWORDS,
              max_topics: MAX_TOPICS,
              max_languages: MAX_LANGUAGES,
              max_exclude_keywords: MAX_EXCLUDES
            },
            output_schema: {
              keywords: ["英文 keyword，用于 GitHub Search 普通关键词"],
              topics: ["英文 topic，不包含 topic: 前缀"],
              languages: {
                TypeScript: "number weight, usually 1.0 to 1.4"
              },
              excludeKeywords: ["英文或中文排除关键词"],
              minStars: "integer",
              pushedWithinDays: "integer days",
              excludeArchived: "boolean",
              excludeForks: "boolean",
              notes: ["简体中文说明"]
            }
          })
        }
      ]
    });

    const parsed = generatedPreferencesSchema.safeParse(result);
    if (!parsed.success) {
      return heuristicDiscoveryPreferences(input.prompt, ["模型返回格式不可用，已使用本地规则生成。"]);
    }

    return normalizeGeneratedPreferences(parsed.data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return heuristicDiscoveryPreferences(input.prompt, [`模型解析失败，已使用本地规则生成：${reason}`]);
  }
}

export function buildDiscoveryPreview(input: {
  profile: DiscoveryProfile;
  generated: GeneratedDiscoveryPreferences;
  mode: "merge" | "replace";
}) {
  const preferences =
    input.mode === "replace"
      ? toProfilePreferences(input.generated)
      : mergePreferences(input.profile.config.preferences, input.generated);
  const previewProfile: DiscoveryProfile = {
    ...input.profile,
    config: {
      ...input.profile.config,
      preferences
    }
  };

  return {
    preferences,
    queryPlans: buildGitHubSearchQueryPlans(previewProfile).slice(0, 40)
  };
}

export function mergePreferences(
  current: DiscoveryProfile["config"]["preferences"],
  generated: GeneratedDiscoveryPreferences
): DiscoveryProfile["config"]["preferences"] {
  return {
    keywords: uniqueLimited([...current.keywords, ...generated.keywords], MAX_KEYWORDS),
    topics: uniqueLimited([...current.topics, ...generated.topics], MAX_TOPICS),
    languages: limitLanguageWeights({
      ...current.languages,
      ...generated.languages
    }),
    excludeKeywords: uniqueLimited(
      [...current.excludeKeywords, ...generated.excludeKeywords],
      MAX_EXCLUDES
    ),
    minStars: generated.minStars || current.minStars,
    pushedWithinDays: generated.pushedWithinDays || current.pushedWithinDays,
    excludeArchived: generated.excludeArchived,
    excludeForks: generated.excludeForks
  };
}

function toProfilePreferences(
  generated: GeneratedDiscoveryPreferences
): DiscoveryProfile["config"]["preferences"] {
  return {
    keywords: uniqueLimited(generated.keywords, MAX_KEYWORDS),
    topics: uniqueLimited(generated.topics, MAX_TOPICS),
    languages: limitLanguageWeights(generated.languages),
    excludeKeywords: uniqueLimited(generated.excludeKeywords, MAX_EXCLUDES),
    minStars: generated.minStars,
    pushedWithinDays: generated.pushedWithinDays,
    excludeArchived: generated.excludeArchived,
    excludeForks: generated.excludeForks
  };
}

export function heuristicDiscoveryPreferences(
  prompt: string,
  notes: string[] = []
): GeneratedDiscoveryPreferences {
  const lower = prompt.toLowerCase();
  const keywords = new Set<string>();
  const topics = new Set<string>();
  const languages: Record<string, number> = {};
  const excludeKeywords = new Set<string>();

  const pairs: Array<[RegExp, string[], string[]]> = [
    [/agent|智能体|代理/i, ["agent", "agents", "multi-agent"], ["ai", "agents"]],
    [/workflow|工作流|编排/i, ["workflow", "orchestration", "automation"], ["workflow", "automation"]],
    [/rag|检索增强/i, ["rag", "retrieval", "embedding"], ["rag", "llm"]],
    [/llm|大模型|语言模型/i, ["llm", "chatbot", "generative-ai"], ["llm", "ai"]],
    [/ui|前端|界面/i, ["ui", "frontend", "components"], ["frontend", "developer-tools"]],
    [/devtool|developer|开发工具|工具/i, ["developer-tools", "sdk", "cli"], ["developer-tools"]]
  ];
  for (const [pattern, nextKeywords, nextTopics] of pairs) {
    if (pattern.test(prompt)) {
      nextKeywords.forEach((item) => keywords.add(item));
      nextTopics.forEach((item) => topics.add(item));
    }
  }

  const languageMap: Array<[RegExp, string]> = [
    [/typescript|ts\b|前端/i, "TypeScript"],
    [/javascript|js\b/i, "JavaScript"],
    [/python|py\b/i, "Python"],
    [/go\b|golang/i, "Go"],
    [/rust/i, "Rust"],
    [/java\b/i, "Java"]
  ];
  for (const [pattern, language] of languageMap) {
    if (pattern.test(prompt)) {
      languages[language] = 1.2;
    }
  }

  if (/crypto|区块链|加密货币|加密|web3/i.test(prompt)) {
    excludeKeywords.add("crypto");
    excludeKeywords.add("blockchain");
    excludeKeywords.add("web3");
  }
  if (/不要|排除|不包含/i.test(prompt)) {
    for (const word of ["gambling", "adult", "trading"]) {
      if (lower.includes(word)) excludeKeywords.add(word);
    }
  }

  const stars =
    prompt.match(/stars?\s*(?:超过|大于|>=|>)?\s*(\d+)/i) ??
    prompt.match(/stars?[^\d]{0,16}(\d+)/i) ??
    prompt.match(/(?:stars?|星标|星)\s*(?:超过|大于|>=|>)?\s*(\d+)/i) ??
    prompt.match(/(\d+)\s*(?:星|star)/i);
  const days = /半年|6\s*个月/i.test(prompt)
    ? 180
    : /一年|12\s*个月/i.test(prompt)
      ? 365
      : /三个月|3\s*个月/i.test(prompt)
        ? 90
        : 180;

  return normalizeGeneratedPreferences({
    keywords: [...keywords],
    topics: [...topics],
    languages,
    excludeKeywords: [...excludeKeywords],
    minStars: stars ? Number(stars[1]) : 100,
    pushedWithinDays: days,
    excludeArchived: true,
    excludeForks: true,
    notes
  });
}

function normalizeGeneratedPreferences(
  input: GeneratedDiscoveryPreferences
): GeneratedDiscoveryPreferences {
  return {
    keywords: uniqueLimited(input.keywords, MAX_KEYWORDS),
    topics: uniqueLimited(input.topics, MAX_TOPICS).map((topic) => topic.replace(/^topic:/i, "")),
    languages: limitLanguageWeights(input.languages),
    excludeKeywords: uniqueLimited(input.excludeKeywords, MAX_EXCLUDES),
    minStars: clampInteger(input.minStars, 0, 100000, 100),
    pushedWithinDays: clampInteger(input.pushedWithinDays, 1, 3650, 180),
    excludeArchived: input.excludeArchived,
    excludeForks: input.excludeForks,
    notes: uniqueLimited(input.notes, 6)
  };
}

function uniqueLimited(values: string[], limit: number) {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function limitLanguageWeights(values: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([language, weight]) => language.trim() && Number.isFinite(weight))
      .slice(0, MAX_LANGUAGES)
      .map(([language, weight]) => [language.trim(), Math.max(0.1, Math.min(2, Number(weight)))])
  );
}

function clampInteger(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}
