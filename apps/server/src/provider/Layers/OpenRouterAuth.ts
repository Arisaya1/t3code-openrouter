/**
 * OpenRouterAuth — verifies that an OpenRouter instance's API key actually works.
 *
 * The Claude-family health check probes the local `claude` binary and reports
 * whatever that binary says about its own credentials. For an OpenRouter
 * instance that answer carries no information: the CLI is handed an
 * `ANTHROPIC_AUTH_TOKEN` and told which endpoint to use, and it does not contact
 * openrouter.ai while probing. So a key that is missing, mistyped, revoked, or
 * out of credit still rendered the provider as a green "Authenticated" card, and
 * the failure only surfaced later as a bare 401 inside a session — pointing at
 * nothing the user could act on.
 *
 * OpenRouter exposes `GET /api/v1/key`, which authenticates the caller's own key
 * and describes it. Calling it during the health check moves that failure
 * forward to the provider card, where there is room to say what to fix.
 *
 * The check never fails the instance on a network error: not being able to reach
 * OpenRouter is not evidence that the key is bad, and taking the provider
 * offline over it would be worse than the ambiguity.
 *
 * @module provider/Layers/OpenRouterAuth
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { ServerProviderDraft } from "../providerSnapshot.ts";

/**
 * Public REST API — the `/v1` form, distinct from the `/api` Anthropic-compatible
 * endpoint the spawned CLI talks to.
 */
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

/**
 * The driver derives this from `OPENROUTER_API_KEY` before the instance is
 * built, so reading it here checks the token the CLI will actually send —
 * including the case where the user set `ANTHROPIC_AUTH_TOKEN` directly.
 */
const AUTH_TOKEN_VAR = "ANTHROPIC_AUTH_TOKEN";

const OpenRouterKeyResponse = Schema.Struct({
  data: Schema.Struct({
    label: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.NullOr(Schema.Number)),
    usage: Schema.optional(Schema.Number),
    is_free_tier: Schema.optional(Schema.Boolean),
  }),
});

export type OpenRouterCredentialCheck =
  /** No token reached the instance at all. */
  | { readonly _tag: "missing" }
  /** OpenRouter authenticated the key. */
  | {
      readonly _tag: "valid";
      readonly label: string | undefined;
      readonly remainingCredit: number | undefined;
    }
  /** OpenRouter answered, and refused the key. */
  | { readonly _tag: "rejected"; readonly httpStatus: number }
  /** Could not ask. Says nothing about the key. */
  | { readonly _tag: "unreachable" };

/**
 * `limit` is the key's credit ceiling and is null for unlimited keys; `usage` is
 * what it has spent. Remaining credit is only meaningful when both are present.
 */
function resolveRemainingCredit(
  limit: number | null | undefined,
  usage: number | undefined,
): number | undefined {
  if (typeof limit !== "number") return undefined;
  return Math.max(0, limit - (usage ?? 0));
}

export const checkOpenRouterCredentials = Effect.fn("checkOpenRouterCredentials")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<OpenRouterCredentialCheck, never, HttpClient.HttpClient> {
  const token = environment[AUTH_TOKEN_VAR]?.trim();
  if (!token) return { _tag: "missing" } as const;

  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient
    .execute(HttpClientRequest.get(OPENROUTER_KEY_URL).pipe(HttpClientRequest.bearerToken(token)))
    .pipe(Effect.result);

  if (Result.isFailure(response)) {
    yield* Effect.logWarning("OpenRouter key verification could not reach OpenRouter.", {
      url: OPENROUTER_KEY_URL,
    });
    return { _tag: "unreachable" } as const;
  }

  const { status } = response.success;
  if (status < 200 || status >= 300) {
    return { _tag: "rejected", httpStatus: status } as const;
  }

  const body = yield* HttpClientResponse.schemaBodyJson(OpenRouterKeyResponse)(
    response.success,
  ).pipe(Effect.result);

  // A 2xx means the key authenticated. If the body then fails to decode, that
  // is OpenRouter changing its response shape, not a credential problem — so
  // report the key as valid and simply describe it less well.
  if (Result.isFailure(body)) {
    return { _tag: "valid", label: undefined, remainingCredit: undefined } as const;
  }

  const { label, limit, usage } = body.success.data;
  return {
    _tag: "valid",
    label: label?.trim() || undefined,
    remainingCredit: resolveRemainingCredit(limit, usage),
  } as const;
});

const formatCredit = (remaining: number): string =>
  `$${remaining.toFixed(remaining < 1 ? 3 : 2)} left`;

/**
 * Human-readable summary of the key, shown next to the auth status. Includes the
 * credit figure when the key has a ceiling, because that is the value that
 * changes underneath a working setup and explains a sudden failure.
 */
function describeKey(check: Extract<OpenRouterCredentialCheck, { _tag: "valid" }>): string {
  const credit =
    check.remainingCredit === undefined ? undefined : formatCredit(check.remainingCredit);
  const parts = [check.label, credit].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : "OpenRouter API key";
}

/**
 * Fold a credential check into the draft the CLI probe produced.
 *
 * Only a `ready` draft is refined. A draft that is already `warning` or `error`
 * failed on something more fundamental — the binary is missing, or it would not
 * run — and overwriting that with a key message would hide the actual blocker.
 */
export function applyOpenRouterCredentialCheck(
  draft: ServerProviderDraft,
  check: OpenRouterCredentialCheck,
): ServerProviderDraft {
  if (draft.status !== "ready") return draft;

  switch (check._tag) {
    case "missing":
      return {
        ...draft,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "No OpenRouter API key. Add OPENROUTER_API_KEY to this provider's Environment variables in Settings.",
      };
    case "rejected":
      return {
        ...draft,
        status: "error",
        auth: { status: "unauthenticated" },
        message:
          check.httpStatus === 402
            ? "OpenRouter refused this API key: the account is out of credit. Top up at openrouter.ai/credits."
            : `OpenRouter rejected this API key (HTTP ${check.httpStatus}). Check it at openrouter.ai/keys — it may be mistyped, revoked, or out of credit.`,
      };
    case "unreachable":
      // Least severe of the three problems, and the only one we are not sure
      // about — so it does not displace a message the probe already set (a
      // version-upgrade advisory, typically).
      return {
        ...draft,
        auth: { status: "unknown" },
        ...(draft.message
          ? {}
          : {
              message: "Could not reach OpenRouter to verify the API key. Sessions may still work.",
            }),
      };
    case "valid":
      return {
        ...draft,
        auth: {
          status: "authenticated",
          type: "OpenRouter API key",
          label: describeKey(check),
        },
      };
  }
}
