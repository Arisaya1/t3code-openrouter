import { describe, expect, it } from "@effect/vitest";

import {
  lookupRate,
  mergeRateTables,
  parseOpenRouterRateTable,
  parseRateTable,
  parseUsdAudRate,
  priceUsage,
  usdToAud,
} from "./usagePricing.ts";

const totals = {
  uncachedInputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 100_000,
  reasoningTokens: 0,
};

describe("parseOpenRouterRateTable", () => {
  it("reads USD-per-token catalogue prices, including Grok 4.6", () => {
    const table = parseOpenRouterRateTable({
      data: [
        {
          id: "x-ai/grok-4.6",
          pricing: {
            prompt: "0.000002",
            completion: "0.000006",
            input_cache_read: "0.0000005",
          },
        },
      ],
    });

    expect(lookupRate(table, "x-ai/grok-4.6")).toEqual({
      inputCostPerToken: 0.000002,
      outputCostPerToken: 0.000006,
      cacheReadCostPerToken: 0.0000005,
      cacheCreationCostPerToken: 0.000002,
    });
  });

  it("drops models that are missing a completion price", () => {
    const table = parseOpenRouterRateTable({
      data: [{ id: "vendor/half-priced", pricing: { prompt: 0.000001 } }],
    });

    expect(table.size).toBe(0);
  });
});

describe("lookupRate", () => {
  it("prefers the full OpenRouter slug over a bare LiteLLM name", () => {
    const table = mergeRateTables(
      parseRateTable({
        "grok-4.6": {
          input_cost_per_token: 0.000009,
          output_cost_per_token: 0.000009,
        },
      }),
      parseOpenRouterRateTable({
        data: [
          {
            id: "x-ai/grok-4.6",
            pricing: { prompt: 0.000002, completion: 0.000006 },
          },
        ],
      }),
    );

    expect(lookupRate(table, "x-ai/grok-4.6")?.inputCostPerToken).toBe(0.000002);
  });
});

describe("priceUsage", () => {
  it("prices Grok 4.6 from OpenRouter's published rates", () => {
    const table = parseOpenRouterRateTable({
      data: [
        {
          id: "x-ai/grok-4.6",
          pricing: { prompt: 0.000002, completion: 0.000006 },
        },
      ],
    });

    const priced = priceUsage(table, "x-ai/grok-4.6", totals, null);
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.costUsd).toBeCloseTo(2.6, 9);
  });
});

describe("usdToAud", () => {
  it("multiplies a USD cost by the mid-market rate", () => {
    expect(usdToAud(2.6, 1.412)).toBeCloseTo(3.6712, 9);
  });

  it("leaves the USD figure alone when FX is missing", () => {
    expect(usdToAud(2.6, 0)).toBe(2.6);
    expect(usdToAud(2.6, Number.NaN)).toBe(2.6);
  });
});

describe("parseUsdAudRate", () => {
  it("reads Frankfurter's latest USD→AUD body", () => {
    expect(
      parseUsdAudRate({ amount: 1, base: "USD", date: "2026-08-14", rates: { AUD: 1.412 } }),
    ).toBe(1.412);
  });

  it("rejects a non-positive rate", () => {
    expect(parseUsdAudRate({ rates: { AUD: 0 } })).toBeNull();
  });
});
