import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { applyOpenRouterCredentialCheck, checkOpenRouterCredentials } from "./OpenRouterAuth.ts";

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
}

/**
 * Answers every request with `response`, recording what was asked. `response`
 * returning `undefined` simulates a transport-level failure — the typed error a
 * real `HttpClient` raises when the host cannot be reached, not a defect.
 */
const makeKeyEndpointLayer = (
  requests: Array<RecordedRequest>,
  response: () => { readonly status: number; readonly body: string } | undefined,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        requests.push({
          url: request.url,
          authorization: request.headers["authorization"],
        });
        const answer = response();
        if (!answer) {
          return yield* Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("network down"),
              }),
            }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(answer.body, {
            status: answer.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const draft = (overrides: Partial<ServerProviderDraft> = {}): ServerProviderDraft => ({
  displayName: "OpenRouter",
  enabled: true,
  installed: true,
  version: "2.0.1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-14T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("checkOpenRouterCredentials", () => {
  it.effect("reports a missing key without making a request", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = [];
      const check = yield* checkOpenRouterCredentials({}).pipe(
        Effect.provide(makeKeyEndpointLayer(requests, () => ({ status: 200, body: "{}" }))),
      );

      expect(check).toEqual({ _tag: "missing" });
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect("treats a whitespace-only token as missing", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = [];
      const check = yield* checkOpenRouterCredentials({ ANTHROPIC_AUTH_TOKEN: "   " }).pipe(
        Effect.provide(makeKeyEndpointLayer(requests, () => ({ status: 200, body: "{}" }))),
      );

      expect(check).toEqual({ _tag: "missing" });
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect("sends the token as a bearer and reports the key's label and remaining credit", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = [];
      const check = yield* checkOpenRouterCredentials({
        ANTHROPIC_AUTH_TOKEN: "sk-or-v1-test",
      }).pipe(
        Effect.provide(
          makeKeyEndpointLayer(requests, () => ({
            status: 200,
            body: JSON.stringify({
              data: { label: "t3code", limit: 10, usage: 2.5, is_free_tier: false },
            }),
          })),
        ),
      );

      expect(requests).toEqual([
        {
          url: "https://openrouter.ai/api/v1/key",
          authorization: "Bearer sk-or-v1-test",
        },
      ]);
      expect(check).toEqual({ _tag: "valid", label: "t3code", remainingCredit: 7.5 });
    }),
  );

  it.effect("reports an unlimited key as valid with no credit figure", () =>
    Effect.gen(function* () {
      const check = yield* checkOpenRouterCredentials({ ANTHROPIC_AUTH_TOKEN: "sk-or-v1" }).pipe(
        Effect.provide(
          makeKeyEndpointLayer([], () => ({
            status: 200,
            body: JSON.stringify({ data: { label: "unlimited", limit: null, usage: 12 } }),
          })),
        ),
      );

      expect(check).toEqual({ _tag: "valid", label: "unlimited", remainingCredit: undefined });
    }),
  );

  it.effect("still reports a 2xx as valid when the body does not decode", () =>
    Effect.gen(function* () {
      const check = yield* checkOpenRouterCredentials({ ANTHROPIC_AUTH_TOKEN: "sk-or-v1" }).pipe(
        Effect.provide(
          makeKeyEndpointLayer([], () => ({ status: 200, body: JSON.stringify({ nope: true }) })),
        ),
      );

      expect(check).toEqual({ _tag: "valid", label: undefined, remainingCredit: undefined });
    }),
  );

  it.effect("reports a refused key with the status OpenRouter answered", () =>
    Effect.gen(function* () {
      const check = yield* checkOpenRouterCredentials({
        ANTHROPIC_AUTH_TOKEN: "sk-or-v1-dead",
      }).pipe(
        Effect.provide(
          makeKeyEndpointLayer([], () => ({
            status: 401,
            body: JSON.stringify({ error: { message: "User not found." } }),
          })),
        ),
      );

      expect(check).toEqual({ _tag: "rejected", httpStatus: 401 });
    }),
  );

  it.effect("reports an unreachable gateway rather than failing", () =>
    Effect.gen(function* () {
      const check = yield* checkOpenRouterCredentials({ ANTHROPIC_AUTH_TOKEN: "sk-or-v1" }).pipe(
        Effect.provide(makeKeyEndpointLayer([], () => undefined)),
      );

      expect(check).toEqual({ _tag: "unreachable" });
    }),
  );
});

describe("applyOpenRouterCredentialCheck", () => {
  it("leaves a draft that already failed the CLI probe untouched", () => {
    // The binary is the more fundamental problem; a key message here would bury it.
    const notInstalled = draft({
      status: "error",
      installed: false,
      version: null,
      auth: { status: "unknown" },
      message: "Claude Agent CLI (`claude`) is not installed or not on PATH.",
    });

    expect(applyOpenRouterCredentialCheck(notInstalled, { _tag: "missing" })).toBe(notInstalled);
    expect(
      applyOpenRouterCredentialCheck(notInstalled, { _tag: "rejected", httpStatus: 401 }),
    ).toBe(notInstalled);
  });

  it("downgrades a missing key to a warning that names the setting", () => {
    const result = applyOpenRouterCredentialCheck(draft(), { _tag: "missing" });

    expect(result.status).toBe("warning");
    expect(result.auth).toEqual({ status: "unauthenticated" });
    expect(result.message).toContain("OPENROUTER_API_KEY");
  });

  it("turns a refused key into an error rather than a green Authenticated card", () => {
    const result = applyOpenRouterCredentialCheck(draft(), { _tag: "rejected", httpStatus: 401 });

    expect(result.status).toBe("error");
    expect(result.auth).toEqual({ status: "unauthenticated" });
    expect(result.message).toContain("401");
    expect(result.message).toContain("openrouter.ai/keys");
  });

  it("names the specific problem when the account is out of credit", () => {
    const result = applyOpenRouterCredentialCheck(draft(), { _tag: "rejected", httpStatus: 402 });

    expect(result.status).toBe("error");
    expect(result.message).toContain("out of credit");
  });

  it("describes a valid key without changing the ready status", () => {
    const result = applyOpenRouterCredentialCheck(draft(), {
      _tag: "valid",
      label: "t3code",
      remainingCredit: 7.5,
    });

    expect(result.status).toBe("ready");
    expect(result.auth).toEqual({
      status: "authenticated",
      type: "OpenRouter API key",
      label: "t3code · $7.50 left",
    });
  });

  it("falls back to a generic label when the key describes itself as nothing", () => {
    const result = applyOpenRouterCredentialCheck(draft(), {
      _tag: "valid",
      label: undefined,
      remainingCredit: undefined,
    });

    expect(result.auth.label).toBe("OpenRouter API key");
  });

  it("marks auth unknown when unreachable, keeping a message the probe already set", () => {
    const withAdvisory = draft({ message: "Update available: claude 2.1.0." });
    const result = applyOpenRouterCredentialCheck(withAdvisory, { _tag: "unreachable" });

    expect(result.status).toBe("ready");
    expect(result.auth).toEqual({ status: "unknown" });
    expect(result.message).toBe("Update available: claude 2.1.0.");
  });

  it("explains an unreachable gateway when the probe left no message", () => {
    const result = applyOpenRouterCredentialCheck(draft(), { _tag: "unreachable" });

    expect(result.message).toContain("Could not reach OpenRouter");
  });
});
