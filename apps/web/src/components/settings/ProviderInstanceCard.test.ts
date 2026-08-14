import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceEnvironmentVariable, ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  partitionProviderCredential,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("partitionProviderCredential", () => {
  const key: ProviderInstanceEnvironmentVariable = {
    name: "OPENROUTER_API_KEY",
    value: "sk-or-v1-example",
    sensitive: true,
  };
  const other: ProviderInstanceEnvironmentVariable = {
    name: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    value: "anthropic/claude-sonnet-5",
    sensitive: false,
  };

  it("splits the credential out so each editor owns one half", () => {
    expect(partitionProviderCredential([other, key], "OPENROUTER_API_KEY")).toEqual({
      credential: key,
      rest: [other],
    });
  });

  it("reports no credential when the instance has not set one", () => {
    expect(partitionProviderCredential([other], "OPENROUTER_API_KEY")).toEqual({
      credential: undefined,
      rest: [other],
    });
  });

  it("keeps the whole list for a driver that declares no credential", () => {
    expect(partitionProviderCredential([other, key], undefined)).toEqual({
      credential: undefined,
      rest: [other, key],
    });
  });

  it("treats a missing environment as empty", () => {
    expect(partitionProviderCredential(undefined, "OPENROUTER_API_KEY")).toEqual({
      credential: undefined,
      rest: [],
    });
  });

  it("resolves a duplicated variable to the last one, matching the server", () => {
    const shadowed: ProviderInstanceEnvironmentVariable = { ...key, value: "sk-or-v1-stale" };

    const result = partitionProviderCredential([shadowed, other, key], "OPENROUTER_API_KEY");

    expect(result.credential).toEqual(key);
    // Both copies leave the table's half, so re-merging cannot resurrect the stale one.
    expect(result.rest).toEqual([other]);
  });

  it("round-trips: rest plus credential reconstructs the full environment", () => {
    const environment = [other, key];
    const { credential, rest } = partitionProviderCredential(environment, "OPENROUTER_API_KEY");

    expect([...rest, ...(credential ? [credential] : [])]).toEqual(environment);
  });
});
