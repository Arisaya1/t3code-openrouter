import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import { fetchOpenRouterModels, openRouterFallbackModels } from "./OpenRouterModels.ts";

/**
 * Answers the catalogue request with `body`, or fails at the transport level
 * when `body` is undefined (host unreachable — the case the fallback exists for).
 */
const makeCatalogueLayer = (body: string | undefined) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      body === undefined
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("network down"),
              }),
            }),
          )
        : Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body, {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
    ),
  );

const contextLengthOf = (
  models: ReadonlyArray<{ readonly slug: string; readonly capabilities: unknown }>,
  slug: string,
): number | undefined => {
  const capabilities = models.find((model) => model.slug === slug)?.capabilities;
  return (capabilities as { readonly contextLength?: number } | null | undefined)?.contextLength;
};

describe("fetchOpenRouterModels", () => {
  it.effect("carries each model's published context_length onto its capabilities", () =>
    Effect.gen(function* () {
      const models = yield* fetchOpenRouterModels().pipe(
        Effect.provide(
          makeCatalogueLayer(
            `{"data":[{"id":"moonshotai/kimi-k3","name":"MoonshotAI: Kimi K3","context_length":262144}]}`,
          ),
        ),
      );

      expect(contextLengthOf(models, "moonshotai/kimi-k3")).toBe(262_144);
    }),
  );

  it.effect("omits the window for entries OpenRouter has no figure for", () =>
    Effect.gen(function* () {
      const models = yield* fetchOpenRouterModels().pipe(
        Effect.provide(
          makeCatalogueLayer(
            `{"data":[` +
              `{"id":"vendor/absent","name":"Vendor: Absent"},` +
              `{"id":"vendor/null","name":"Vendor: Null","context_length":null},` +
              `{"id":"vendor/zero","name":"Vendor: Zero","context_length":0}` +
              `]}`,
          ),
        ),
      );

      // Three distinct ways of saying "unknown" — none may become a number, as
      // the value ends up as the spawned CLI's auto-compact threshold.
      expect(contextLengthOf(models, "vendor/absent")).toBeUndefined();
      expect(contextLengthOf(models, "vendor/null")).toBeUndefined();
      expect(contextLengthOf(models, "vendor/zero")).toBeUndefined();
    }),
  );

  it.effect("keeps decoding the catalogue when one entry sends a null context_length", () =>
    Effect.gen(function* () {
      const models = yield* fetchOpenRouterModels().pipe(
        Effect.provide(
          makeCatalogueLayer(
            `{"data":[` +
              `{"id":"vendor/null","name":"Vendor: Null","context_length":null},` +
              `{"id":"vendor/sized","name":"Vendor: Sized","context_length":1000000}` +
              `]}`,
          ),
        ),
      );

      // A null must not fail the whole decode into the fallback list, which
      // would silently drop every window in the catalogue.
      expect(models).toHaveLength(2);
      expect(contextLengthOf(models, "vendor/sized")).toBe(1_000_000);
    }),
  );

  it.effect("claims no context window when it falls back to the static list", () =>
    Effect.gen(function* () {
      const models = yield* fetchOpenRouterModels().pipe(
        Effect.provide(makeCatalogueLayer(undefined)),
      );

      expect(models).toEqual(openRouterFallbackModels());
      expect(models.every((model) => model.capabilities?.contextLength === undefined)).toBe(true);
    }),
  );
});
