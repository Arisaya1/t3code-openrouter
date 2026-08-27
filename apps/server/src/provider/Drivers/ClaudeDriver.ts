/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * Both `ClaudeDriver` and `OpenRouterDriver` are produced by
 * `makeClaudeFamilyDriver` — they share the entire Claude Agent SDK runtime
 * machinery. The OpenRouter variant is a Claude Code instance pointed at
 * OpenRouter's Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`) with the
 * auth token derived from `OPENROUTER_API_KEY`; per-instance environment
 * variables configured in T3 Code settings always win over those defaults.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import {
  ClaudeSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import {
  applyOpenRouterCredentialCheck,
  checkOpenRouterCredentials,
} from "../Layers/OpenRouterAuth.ts";
import { fetchOpenRouterModels } from "../Layers/OpenRouterModels.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeClaudeCapabilitiesCacheKey, makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

/**
 * Longer than the capabilities probe: a gateway's model list changes on the
 * order of days, and the health check runs every few minutes by default.
 */
const MODEL_CATALOG_TTL = Duration.minutes(30);

/**
 * Shorter than the model catalogue: a key's credit can run out mid-session, and
 * that is precisely the state this check exists to surface.
 */
const CREDENTIAL_PROBE_TTL = Duration.minutes(5);

/**
 * OpenRouter's Anthropic-compatible endpoint base URL, as documented in
 * T3 Code's Claude provider guide. Note: `/api`, not `/api/v1`.
 */
const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

export type ClaudeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * The OpenRouter driver needs exactly the same infrastructure services as
 * the Claude driver — it is the same runtime pointed at a different endpoint.
 */
export type OpenRouterDriverEnv = ClaudeDriverEnv;

/**
 * Lay OpenRouter defaults over a copy of the process environment:
 *   - `ANTHROPIC_BASE_URL` → OpenRouter's Anthropic-compatible endpoint
 *   - `ANTHROPIC_API_KEY` → removed, so Claude Code cannot fall back to a
 *     cached Anthropic key instead of the OpenRouter token
 *   - `ANTHROPIC_AUTH_TOKEN` → derived from `OPENROUTER_API_KEY` when present
 *
 * These are assigned unconditionally rather than defaulted. The server
 * inherits whatever shell launched it, and an ambient `ANTHROPIC_BASE_URL`
 * (a machine-wide Anthropic, Moonshot, or proxy setup) would otherwise
 * silently redirect this driver — sending an `sk-or-` token to a host that
 * cannot authenticate it, with nothing in the UI explaining why. Pointing at
 * OpenRouter is the entire reason this driver is distinct from `ClaudeDriver`,
 * so it is not something the surrounding environment gets to override.
 *
 * Per-instance environment variables configured in T3 Code settings are merged
 * afterwards and still win — that remains the supported way to point an
 * instance at a custom gateway (see `create` below).
 */
const makeOpenRouterProcessEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = { ...base };
  next.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_BASE_URL;
  // `delete` rather than `= ""`: an empty string is still an own property, and
  // it would be spread into every spawned CLI environment as a set-but-blank
  // key, which Claude Code reports as a malformed credential rather than an
  // absent one.
  delete next.ANTHROPIC_API_KEY;
  const apiKey = base.OPENROUTER_API_KEY;
  if (apiKey) next.ANTHROPIC_AUTH_TOKEN = apiKey;
  return next;
};

const makeClaudeFamilyDriver = <TCredentials>(options: {
  readonly driverKind: string;
  readonly displayName: string;
  /**
   * Namespace for thread-continuation grouping, so a Claude instance and an
   * OpenRouter instance sharing a `CLAUDE_CONFIG_DIR` never continue each
   * other's threads.
   */
  readonly continuationNamespace: string;
  /**
   * Optional base-environment transform applied before per-instance env vars
   * are merged. Only the OpenRouter variant uses this to inject its endpoint
   * defaults; the Claude variant passes nothing and keeps `process.env` as-is.
   */
  readonly defaultProcessEnv?: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /**
   * Built-in model catalogue for this driver, replacing the Claude one. Only
   * the OpenRouter variant sets this — its endpoint accepts namespaced ids
   * (`anthropic/claude-sonnet-5`) and rejects every slug in the Claude
   * catalogue. Resolved through a per-instance TTL cache below, so a health
   * check every few minutes does not mean an HTTP request every few minutes.
   */
  readonly resolveBuiltInModels?: () => Effect.Effect<
    ReadonlyArray<ServerProviderModel>,
    never,
    HttpClient.HttpClient
  >;
  /**
   * Gateway-side credential check, folded into the status the local CLI probe
   * produced. Only the OpenRouter variant sets this.
   *
   * The CLI probe reports whether `claude` is installed and holds *a* token; for
   * a gateway instance it never asks the gateway whether that token is any good,
   * so a dead key reads as "Authenticated" until a session fails on it. `check`
   * is cached on a short TTL and must not fail — an unreachable gateway is not
   * evidence of a bad key, and the instance should not go offline over it.
   */
  readonly credentials?: {
    readonly check: (
      environment: NodeJS.ProcessEnv,
    ) => Effect.Effect<TCredentials, never, HttpClient.HttpClient>;
    readonly apply: (draft: ServerProviderDraft, credentials: TCredentials) => ServerProviderDraft;
  };
}): ProviderDriver<ClaudeSettings, ClaudeDriverEnv> => {
  const DRIVER_KIND = ProviderDriverKind.make(options.driverKind);

  const UPDATE = makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@anthropic-ai/claude-code",
    homebrewFormula: "claude-code",
    nativeUpdate: {
      executable: "claude",
      args: ["update"],
      lockKey: "claude-native",
      isCommandPath: isClaudeNativeCommandPath,
    },
  });

  const withInstanceIdentity =
    (input: {
      readonly instanceId: ProviderInstance["instanceId"];
      readonly displayName: string | undefined;
      readonly accentColor: string | undefined;
      readonly continuationGroupKey: string;
    }) =>
    (snapshot: ServerProviderDraft): ServerProvider => ({
      ...snapshot,
      instanceId: input.instanceId,
      driver: DRIVER_KIND,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: input.continuationGroupKey },
    });

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: options.displayName,
      supportsMultipleInstances: true,
    },
    configSchema: ClaudeSettings,
    defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { cwd } = yield* ServerConfig;
        const httpClient = yield* HttpClient.HttpClient;
        const serverSettings = yield* ServerSettingsService;
        const eventLoggers = yield* ProviderEventLoggers;
        const modelManifest = yield* ModelManifest.ModelManifest;
        const baseProcessEnv = options.defaultProcessEnv?.(process.env) ?? process.env;
        const merged = mergeProviderInstanceEnvironment(environment, baseProcessEnv);
        // When the user puts their OpenRouter key in this instance's
        // Environment variables section rather than the machine env, derive the
        // Claude auth token from it. This has to consult `environment` and not
        // just the merged result: an ambient ANTHROPIC_AUTH_TOKEN is very
        // common on a machine that already runs Claude Code, and testing the
        // merged value would let it outrank the key the user just typed into
        // this instance — the setting would appear to do nothing.
        // An explicit per-instance ANTHROPIC_AUTH_TOKEN still wins over both.
        const instanceKeyOf = (name: string) =>
          environment?.findLast((variable) => variable.name === name)?.value;
        const processEnv = ((): NodeJS.ProcessEnv => {
          if (!options.defaultProcessEnv) return merged;
          if (instanceKeyOf("ANTHROPIC_AUTH_TOKEN")) return merged;
          const instanceApiKey = instanceKeyOf("OPENROUTER_API_KEY");
          if (!instanceApiKey) return merged;
          // Copy rather than mutate: `mergeProviderInstanceEnvironment` returns
          // its base by reference when the instance declares no variables.
          return { ...merged, ANTHROPIC_AUTH_TOKEN: instanceApiKey };
        })();
        const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        });
        const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;
        const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          UPDATE,
          {
            binaryPath: effectiveConfig.binaryPath,
            env: processEnv,
          },
        );
        const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
          effectiveConfig,
          options.continuationNamespace,
        );
        const stampIdentity = withInstanceIdentity({
          instanceId,
          displayName,
          accentColor,
          continuationGroupKey,
        });

        // Per-instance capabilities cache: keyed on binary + resolved HOME so
        // account-specific probes never share auth metadata across instances.
        const capabilitiesProbeCache = yield* Cache.make({
          capacity: 1,
          timeToLive: CAPABILITIES_PROBE_TTL,
          lookup: () =>
            probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
              Effect.provideService(Path.Path, path),
            ),
        });
        const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(effectiveConfig, cwd);

        // Model catalogue cache. `resolveBuiltInModels` never fails — it falls
        // back to a static list internally — so a catalogue lookup can't take
        // the instance offline. Built before the adapter because the adapter
        // reads context windows out of it (see `resolveModelContextWindow`).
        const resolveBuiltInModels = options.resolveBuiltInModels;
        const modelCatalogCache = resolveBuiltInModels
          ? yield* Cache.make({
              capacity: 1,
              timeToLive: MODEL_CATALOG_TTL,
              lookup: () =>
                resolveBuiltInModels().pipe(
                  Effect.provideService(HttpClient.HttpClient, httpClient),
                ),
            })
          : undefined;

        // The catalogue's published window for whichever model a thread picks,
        // so the spawned CLI gets a real auto-compact threshold instead of its
        // 200k assumption. Shares the health check's cache, so a session start
        // costs a lookup rather than an HTTP round trip. Drivers without a
        // catalogue (plain Claude) pass nothing and keep the CLI's own numbers;
        // so does a slug the catalogue does not list, such as a custom model.
        const resolveModelContextWindow = modelCatalogCache
          ? (model: string): Effect.Effect<number | undefined> =>
              Cache.get(modelCatalogCache, "catalog").pipe(
                Effect.map(
                  (models) =>
                    models.find((candidate) => candidate.slug === model)?.capabilities
                      ?.contextLength,
                ),
              )
          : undefined;

        const adapterOptions = {
          instanceId,
          // Without this the adapter reports `claudeAgent` for every instance,
          // and `ProviderService.startSession` — which routes by instance and
          // passes the instance's driver kind — rejects every OpenRouter
          // session start as a provider mismatch.
          driverKind: DRIVER_KIND,
          environment: processEnv,
          ...(resolveModelContextWindow ? { resolveModelContextWindow } : {}),
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        };
        const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
        const textGeneration = yield* makeClaudeTextGeneration(effectiveConfig, processEnv);

        // Credential cache. Keyed trivially: `processEnv` is fixed for the life
        // of the instance, and the registry rebuilds the instance when its
        // settings change, so a key edited in the UI takes effect immediately
        // rather than waiting out this TTL.
        const credentials = options.credentials;
        const credentialCache = credentials
          ? yield* Cache.make({
              capacity: 1,
              timeToLive: CREDENTIAL_PROBE_TTL,
              lookup: () =>
                credentials
                  .check(processEnv)
                  .pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
            })
          : undefined;

        const checkProvider = Effect.gen(function* () {
          // Kick the TTL-gated manifest refresh in the background and classify
          // with the in-memory manifest, so a slow or hung fetch never delays
          // the provider check. A refresh landing mid-probe applies on the next.
          yield* modelManifest.refreshInBackground;
          const builtInModels = modelCatalogCache
            ? yield* Cache.get(modelCatalogCache, "catalog")
            : undefined;
          const probed = yield* checkClaudeProviderStatus(
            effectiveConfig,
            () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
            processEnv,
            cwd,
            builtInModels,
          );
          const draft =
            credentials && credentialCache
              ? credentials.apply(probed, yield* Cache.get(credentialCache, "credentials"))
              : probed;
          // Keyed by driver kind, so the Anthropic legacy list marks Claude's
          // catalogue and leaves OpenRouter's namespaced slugs untouched.
          return ModelManifest.applyModelManifest(draft, yield* modelManifest.current, DRIVER_KIND);
        }).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );

        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>(
          {
            maintenanceCapabilities,
            getSettings: snapshotSettings.getSettings,
            streamSettings: snapshotSettings.streamSettings,
            haveSettingsChanged: haveProviderSnapshotSettingsChanged,
            initialSnapshot: (settings) =>
              Effect.zipWith(
                makePendingClaudeProvider(settings.provider),
                modelManifest.current,
                (draft, manifest) =>
                  stampIdentity(ModelManifest.applyModelManifest(draft, manifest, DRIVER_KIND)),
              ),
            checkProvider,
            enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
              ),
          },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to build ${options.displayName} snapshot: ${
                  cause.message ?? String(cause)
                }`,
                cause,
              }),
          ),
        );

        return {
          instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity: {
            ...fallbackContinuationIdentity,
            continuationKey: continuationGroupKey,
          },
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }),
  };
};

export const ClaudeDriver = makeClaudeFamilyDriver({
  driverKind: "claudeAgent",
  displayName: "Claude",
  continuationNamespace: "claude",
});

export const OpenRouterDriver = makeClaudeFamilyDriver({
  driverKind: "openrouter",
  displayName: "OpenRouter",
  continuationNamespace: "openrouter",
  defaultProcessEnv: makeOpenRouterProcessEnv,
  resolveBuiltInModels: fetchOpenRouterModels,
  credentials: {
    check: checkOpenRouterCredentials,
    apply: applyOpenRouterCredentialCheck,
  },
});
