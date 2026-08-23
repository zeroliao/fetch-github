import type { AiProvider, ProviderKind } from "@/lib/types";
import {
  classifyAiProviderFailure,
  orderEligibleProviders,
} from "./aiProviderPolicy";
import { probeAiProvider } from "./aiProviderProbe";

type UpdateAvailability = (
  id: string,
  input: {
    status: AiProvider["availabilityStatus"];
    code?: string;
    reason?: string;
    recoverySuggestion?: string;
    cooldownUntil?: string;
    recovered?: boolean;
  },
) => Promise<AiProvider | undefined>;

/**
 * Expired cooldowns are re-probed before selection. A provider only becomes
 * available after the real probe succeeds; failed probes preserve the
 * configured cooldown/manual-recovery policy.
 */
export async function resolveReadyAiProvider(
  providers: readonly AiProvider[],
  kind: ProviderKind,
  updateAvailability: UpdateAvailability,
  excludedIds: Iterable<string> = [],
): Promise<AiProvider | undefined> {
  const excluded = new Set(excludedIds);
  let working = [...providers];
  const now = Date.now();
  const expired = working
    .filter(
      (provider) =>
        provider.kind === kind &&
        provider.enabled &&
        !provider.archivedAt &&
        !excluded.has(provider.id) &&
        provider.availabilityStatus === "cooldown" &&
        Boolean(provider.cooldownUntil) &&
        Date.parse(provider.cooldownUntil as string) <= now,
    )
    .sort((left, right) => left.priority - right.priority);

  for (const provider of expired) {
    try {
      await probeAiProvider(provider);
      const recovered = await updateAvailability(provider.id, {
        status: "available",
        recovered: true,
      });
      if (recovered)
        working = working.map((item) =>
          item.id === recovered.id ? recovered : item,
        );
    } catch (error) {
      const failure = classifyAiProviderFailure(error, provider);
      const failed = await updateAvailability(provider.id, {
        status: failure.targetAvailabilityStatus ?? "error",
        code: failure.code,
        reason: failure.reason,
        recoverySuggestion: failure.recoverySuggestion,
        cooldownUntil: failure.cooldownSeconds
          ? new Date(Date.now() + failure.cooldownSeconds * 1000).toISOString()
          : undefined,
      });
      if (failed)
        working = working.map((item) =>
          item.id === failed.id ? failed : item,
        );
    }
  }

  return orderEligibleProviders(working, kind, excluded)[0];
}
