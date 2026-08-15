/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against. Everything here is pure: fetching and caching
 * the table lives in `UsageService`.
 *
 * @module usagePricing
 */
import type { UsageCostSource, UsageTokenTotals } from "@t3tools/contracts";

/**
 * The subset of a LiteLLM entry we price against. All values are USD per token.
 *
 * LiteLLM also publishes tiered variants (`*_above_272k_tokens`, `*_flex`,
 * `*_priority`, `*_batches`). We deliberately price at the base tier: the
 * transcripts don't record which tier served a request, so anything else would
 * be a guess dressed up as precision.
 */
export interface ModelRate {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/** Raw shape of one LiteLLM entry, narrowed to the fields we read. */
interface LiteLlmEntry {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    table.set(normalizeModelName(name), {
      inputCostPerToken: input,
      outputCostPerToken: output,
      // Anthropic bills cache reads at a discount and cache writes at a
      // premium. When a model omits them, cached input is priced as plain
      // input rather than as free.
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    });
  }
  return table;
}

/**
 * Canonicalises a model name for lookup.
 *
 * Strips a `provider/` prefix (LiteLLM publishes both `claude-opus-5` and
 * `anthropic/claude-opus-5`) and lowercases, since transcripts are inconsistent
 * about casing.
 */
export function normalizeModelName(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Models we never price, regardless of the table.
 *
 * `<synthetic>` marks locally generated messages that were never billed. Bare
 * family names ("opus", "sonnet") are genuinely ambiguous across generations,
 * so we report them as unpriced instead of guessing a generation.
 */
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const trimmed = model.trim().toLowerCase();
  if (trimmed.length === 0 || UNPRICEABLE_MODELS.has(normalizeModelName(trimmed))) return null;
  // Prefer the full slug so OpenRouter's `x-ai/grok-4.6` is not collapsed onto
  // a different vendor's `grok-4.6`. Fall back to the bare name for LiteLLM
  // entries, which are published both with and without a provider prefix.
  return table.get(trimmed) ?? table.get(normalizeModelName(trimmed)) ?? null;
}

function finitePositive(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Projects OpenRouter's public catalogue into a rate table.
 *
 * OpenRouter quotes USD per token on `pricing.prompt` / `pricing.completion`.
 * Cache fields are optional; when a model omits them, cached input is priced
 * as plain input rather than as free.
 */
export function parseOpenRouterRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  const data = (document as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) return table;

  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { readonly id?: unknown; readonly pricing?: unknown };
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) continue;
    if (typeof entry.pricing !== "object" || entry.pricing === null) continue;

    const pricing = entry.pricing as Record<string, unknown>;
    const input = finitePositive(pricing["prompt"]);
    const output = finitePositive(pricing["completion"]);
    if (input === null || output === null) continue;

    const id = entry.id.trim().toLowerCase();
    table.set(id, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: finitePositive(pricing["input_cache_read"]) ?? input,
      cacheCreationCostPerToken: finitePositive(pricing["input_cache_write"]) ?? input,
    });
  }
  return table;
}

/**
 * Overlay OpenRouter's published rates on top of the LiteLLM table.
 *
 * OpenRouter ids are namespaced (`x-ai/grok-4.6`) and are the ones transcripts
 * actually record. They win on collision so a Grok turn is priced at what
 * OpenRouter publishes, not at a same-named LiteLLM row from another vendor.
 */
export function mergeRateTables(base: RateTable, overlay: RateTable): RateTable {
  if (overlay.size === 0) return base;
  const merged = new Map(base);
  for (const [model, rate] of overlay) merged.set(model, rate);
  return merged;
}

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
}

/**
 * Prices a bucket's tokens.
 *
 * `reasoningTokens` is intentionally not charged separately: it is already
 * counted inside `outputTokens`.
 */
export function priceUsage(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  reportedCostUsd: number | null,
): PricedUsage {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" };
  }

  const rate = lookupRate(table, model);
  if (rate === null) return { costUsd: 0, costSource: "unpriced" };

  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * rate.cacheReadCostPerToken +
    totals.cacheCreationTokens * rate.cacheCreationCostPerToken +
    totals.outputTokens * rate.outputCostPerToken;

  return { costUsd, costSource: "modelPriced" };
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(table: RateTable, model: string, totals: UsageTokenTotals): number {
  const rate = lookupRate(table, model);
  if (rate === null) return 0;
  return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken);
}

/**
 * Mid-market USD → AUD multiplier. Anything non-finite or non-positive is
 * treated as "no conversion" so a bad FX fetch cannot zero the page.
 */
export function usdToAud(usd: number, audPerUsd: number): number {
  if (!Number.isFinite(usd)) return 0;
  if (!Number.isFinite(audPerUsd) || audPerUsd <= 0) return usd;
  return usd * audPerUsd;
}

/** Frankfurter's `/v1/latest?from=USD&to=AUD` body. */
export function parseUsdAudRate(document: unknown): number | null {
  if (typeof document !== "object" || document === null) return null;
  const rates = (document as { readonly rates?: unknown }).rates;
  if (typeof rates !== "object" || rates === null) return null;
  const aud = (rates as { readonly AUD?: unknown }).AUD;
  return typeof aud === "number" && Number.isFinite(aud) && aud > 0 ? aud : null;
}
