# OpenRouter

OpenRouter is supported as a first-class provider driver: an OpenRouter instance runs the
Claude Code CLI pointed at OpenRouter's Anthropic-compatible endpoint, so you get any model
OpenRouter carries (Claude, DeepSeek, Gemini, Qwen, ...) inside T3 Code with one API key.

## Add An OpenRouter Provider

In T3 Code Settings → Providers, click **Add provider** and pick **OpenRouter**. The
instance inherits the Claude Code runtime, so it uses the `claude` binary (or your custom
`Binary path`).

The driver wires up the Claude environment for you:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api     (forced)
ANTHROPIC_API_KEY    removed from the environment  (so a cached Anthropic key can't be used)
ANTHROPIC_AUTH_TOKEN your OpenRouter key           (derived from OPENROUTER_API_KEY)
```

`ANTHROPIC_BASE_URL` is set unconditionally rather than defaulted. The server inherits
whatever shell started it, so on a machine that already exports `ANTHROPIC_BASE_URL` for a
regular Anthropic login, a proxy, or another gateway, a "default" would lose — the instance
would ship your `sk-or-` token to a host that can't authenticate it and fail with a bare 401. Pointing at OpenRouter is the entire reason this driver is separate from Claude, so the
surrounding environment doesn't get a vote.

So the only thing you must provide is your OpenRouter API key, either:

- in the instance's **Environment variables** section as `OPENROUTER_API_KEY` (recommended,
  mark it **Sensitive**), or
- as a machine/user environment variable named `OPENROUTER_API_KEY`.

Per-instance environment variables are merged last and still win, so you can point the same
instance at another Anthropic-compatible router by setting `ANTHROPIC_BASE_URL` on it. That
is the supported way to override the endpoint — an ambient shell variable is not.

## Pick Models

**Every model ID must be vendor-namespaced.** OpenRouter identifies models as
`vendor/model`, and Anthropic's own bare IDs are not valid there:

| Anthropic API ID   | OpenRouter slug              |
| ------------------ | ---------------------------- |
| `claude-sonnet-5`  | `anthropic/claude-sonnet-5`  |
| `claude-haiku-4-5` | `anthropic/claude-haiku-4.5` |

Note the punctuation as well as the prefix — OpenRouter uses dots in version numbers where
the Anthropic API uses dashes. A bare or dash-versioned ID is rejected as an unknown model.

Claude Code's model roles map to OpenRouter slugs via the instance's Environment variables
section, e.g.:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-5
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-5
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-5
```

The instance starts on an Anthropic model (see `DEFAULT_MODEL_BY_PROVIDER` in
`@t3tools/contracts`), because the runtime is the Claude Code CLI and its system prompt and
tool-calling are tuned for that family. Anything OpenRouter carries is selectable, though —
`deepseek/deepseek-chat-v3.1`, `qwen/qwen3-coder`, `moonshotai/kimi-k3`, and so on. Whatever
you set for a role is what Claude Code uses.

The full catalogue of valid slugs is available without an API key:

```bash
curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id' | sort
```

## Verify

Check the key first — this is the failure people actually hit, and it looks identical to a
misconfigured driver:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/key
```

`200` means the key is good. `401` means the key is invalid, revoked, or out of credit — the
provider will show as **Authenticated** in Settings regardless, because that status comes
from probing the local `claude` binary and never contacts OpenRouter. If this returns 401
while the unauthenticated `/v1/models` call above succeeds, the problem is the key, not the
endpoint and not T3 Code.

Then open a session on the OpenRouter provider and run `/status` — the Anthropic base URL
should read `https://openrouter.ai/api`. The OpenRouter activity dashboard also shows
requests from your API key.

## Notes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
  (The `/v1` form is correct for OpenRouter's own REST API, as in the `curl` calls above —
  just not for the Anthropic-compatible endpoint the CLI talks to.)
- Isolation from a normal Anthropic login is **opt-in**. Set the instance's **Home path**
  (e.g. `~/.claude_openrouter_home`) — that is what populates `CLAUDE_CONFIG_DIR` for the
  spawned CLI. Leave it blank and the instance shares your default Claude config directory.
  After setting it, run `/logout` in that home once if it was previously used with real
  Anthropic credentials.
- OpenRouter's upstream guide: <https://openrouter.ai/docs/guides/guides/claude-code-integration>.
