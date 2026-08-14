/**
 * OpenRouterModels — the model catalogue an OpenRouter provider instance
 * advertises.
 *
 * The Claude driver ships a hardcoded catalogue of bare Anthropic slugs
 * (`claude-sonnet-5`, `claude-haiku-4-5`, ...). None of those are valid
 * OpenRouter model ids: OpenRouter namespaces every model as `vendor/model`
 * and writes versions with dots where the Anthropic API uses dashes
 * (`anthropic/claude-haiku-4.5`). An OpenRouter instance that reused the Claude
 * catalogue therefore advertised nine models that all 404 upstream, and — since
 * the client resolves a thread's model from the instance's reported list before
 * falling back to `DEFAULT_MODEL_BY_PROVIDER` — handed every new thread one of
 * them.
 *
 * OpenRouter publishes its catalogue unauthenticated, so the live list is
 * readable before the user has configured a key at all. The fetch is therefore
 * safe to run during a provider health check; when it fails we fall back to a
 * small curated set rather than leaving the picker empty.
 *
 * @module provider/Layers/OpenRouterModels
 */
import { type ModelCapabilities, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/**
 * Empty option set, matching what custom models get. The Claude catalogue's
 * `effort` / `contextWindow` descriptors are Anthropic-CLI concepts and mean
 * nothing to a Qwen or DeepSeek model served through the same gateway, so no
 * OpenRouter entry claims to support them.
 *
 * `contextLength` is layered on per model in {@link toProviderModel} when
 * OpenRouter publishes one — it is a fact about the model, not an option the
 * user picks.
 */
const OPENROUTER_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * Public, unauthenticated. Note this is the `/v1` REST API — distinct from the
 * `/api` Anthropic-compatible endpoint the spawned CLI talks to.
 */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/**
 * Model a fresh OpenRouter thread starts on. The runtime is the Claude Code
 * CLI, whose system prompt and tool-calling are tuned for Anthropic models, so
 * the default stays in that family even though any listed model is selectable.
 */
export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/**
 * Used when the catalogue request fails (offline, DNS, OpenRouter down). Small
 * and deliberately opinionated — enough to start a session, not a mirror of the
 * live list. Anything missing can still be added as a custom model.
 *
 * Deliberately carries no context lengths. A window from this list would be a
 * remembered number rather than a reported one, and it is used as the spawned
 * CLI's auto-compact threshold — a stale figure there truncates sessions early
 * or overflows the model. With none, the CLI keeps its own 200k assumption,
 * which is the behaviour these entries already had.
 */
const OPENROUTER_FALLBACK_MODEL_IDS: ReadonlyArray<readonly [string, string]> = [
  ["anthropic/claude-sonnet-5", "Anthropic: Claude Sonnet 5"],
  ["anthropic/claude-opus-5", "Anthropic: Claude Opus 5"],
  ["anthropic/claude-haiku-4.5", "Anthropic: Claude Haiku 4.5"],
  ["deepseek/deepseek-v4-pro", "DeepSeek: DeepSeek V4 Pro"],
  ["deepseek/deepseek-v4-flash-0731", "DeepSeek: DeepSeek V4 Flash 0731"],
  ["moonshotai/kimi-k3", "MoonshotAI: Kimi K3"],
  ["minimax/minimax-m3", "MiniMax: MiniMax M3"],
  ["x-ai/grok-4.5", "SpaceXAI: Grok 4.5"],
];

const OpenRouterModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      // Nullable as well as optional: OpenRouter sends `null` for entries whose
      // window it has not recorded. Decoding the whole catalogue is all-or-
      // nothing — a stricter schema here would drop every model over one null.
      context_length: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
});

/**
 * `:batch` ids are the asynchronous batch-pricing variants and cannot serve an
 * interactive turn; `~`-prefixed ids are floating aliases (`~x-ai/grok-latest`)
 * whose target changes underneath a saved thread. Neither belongs in a picker.
 */
function isSelectableModelId(id: string): boolean {
  return !id.startsWith("~") && !id.includes(":batch");
}

/**
 * OpenRouter formats `name` as `"Vendor: Model Name"`. Splitting it gives a
 * vendor for grouping and a name that doesn't repeat the vendor in the picker.
 * Anything not matching that shape is passed through whole.
 */
function splitModelName(
  id: string,
  name: string | undefined,
): {
  readonly name: string;
  readonly subProvider: string | undefined;
} {
  const raw = name?.trim();
  if (!raw) return { name: id, subProvider: id.split("/")[0] };
  const separator = raw.indexOf(": ");
  if (separator <= 0) return { name: raw, subProvider: id.split("/")[0] };
  return {
    name: raw.slice(separator + 2).trim() || raw,
    subProvider: raw.slice(0, separator).trim() || undefined,
  };
}

/**
 * A window only counts when it arrives as a positive integer. Anything else —
 * absent, null, zero, fractional, negative — yields undefined rather than a
 * coerced number: this figure becomes the spawned CLI's auto-compact threshold,
 * and no window at all (the CLI's own 200k assumption) beats a wrong one.
 */
function toContextLength(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

function toProviderModel(
  id: string,
  name: string | undefined,
  contextLength?: number | null | undefined,
): ServerProviderModel {
  const split = splitModelName(id, name);
  const window = toContextLength(contextLength);
  return {
    slug: id,
    name: split.name,
    ...(split.subProvider ? { subProvider: split.subProvider } : {}),
    isCustom: false,
    ...(id === OPENROUTER_DEFAULT_MODEL ? { isDefault: true } : {}),
    capabilities:
      window === undefined
        ? OPENROUTER_MODEL_CAPABILITIES
        : { ...OPENROUTER_MODEL_CAPABILITIES, contextLength: window },
  };
}

/** Vendor first, then model name, so the picker groups by who made the model. */
function compareModels(left: ServerProviderModel, right: ServerProviderModel): number {
  const vendor = (left.subProvider ?? "").localeCompare(right.subProvider ?? "");
  return vendor !== 0 ? vendor : left.name.localeCompare(right.name);
}

export function openRouterFallbackModels(): ReadonlyArray<ServerProviderModel> {
  return OPENROUTER_FALLBACK_MODEL_IDS.map(([id, name]) => toProviderModel(id, name)).toSorted(
    compareModels,
  );
}

/**
 * Read the live catalogue. Never fails: any error (network, non-2xx, malformed
 * body) is logged and answered with {@link openRouterFallbackModels}, because a
 * provider health check that hard-fails on this would take the whole instance
 * offline over a model list.
 */
export const fetchOpenRouterModels = Effect.fn("fetchOpenRouterModels")(
  function* (): Effect.fn.Return<ReadonlyArray<ServerProviderModel>, never, HttpClient.HttpClient> {
    const httpClient = yield* HttpClient.HttpClient;
    const result = yield* httpClient
      .execute(HttpClientRequest.get(OPENROUTER_MODELS_URL))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenRouterModelsResponse)),
        Effect.result,
      );

    if (Result.isFailure(result)) {
      yield* Effect.logWarning("OpenRouter model catalogue request failed; using fallback list.", {
        url: OPENROUTER_MODELS_URL,
      });
      return openRouterFallbackModels();
    }

    const models = result.success.data
      .filter((model) => isSelectableModelId(model.id))
      .map((model) => toProviderModel(model.id, model.name, model.context_length))
      .toSorted(compareModels);

    // An empty or fully-filtered response is a broken catalogue, not a valid
    // "no models" answer — treat it the same as a failed request.
    return models.length > 0 ? models : openRouterFallbackModels();
  },
);
