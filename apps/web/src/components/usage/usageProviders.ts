import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, type Icon, OpenAI, OpenRouterIcon } from "../Icons";

/**
 * Series and table order. The chart layers every provider from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the others.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "openrouter", "claude"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  openrouter: "OpenRouter",
};

/**
 * Claude's brand orange against a neutral white for Codex, and OpenRouter's
 * violet. OpenRouter's own mark is monochrome, which would be indistinguishable
 * from Codex's neutral once it is a band rather than a logo.
 */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "#d97757",
  codex: "#e6e6e6",
  openrouter: "#8b7fe8",
};

/**
 * Brand marks, reused from the provider picker.
 *
 * Claude's and OpenAI's ship their own fills (`#d97757`, white on dark), which
 * are the same colours as the chart bands, so swapping a colour dot for a mark
 * keeps the series association intact rather than trading it away.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
  openrouter: OpenRouterIcon,
};
