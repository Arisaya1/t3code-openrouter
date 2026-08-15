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

So the only thing you must provide is your OpenRouter API key. Expand the instance and paste
it into the **OpenRouter API key** field — it sits under Accent color, is masked as you type,
and links out to <https://openrouter.ai/keys>. That is the whole setup.

The field is a front door to the `OPENROUTER_API_KEY` environment variable, not a separate
store, so these are all equivalent and any one of them works:

- the **OpenRouter API key** field (recommended),
- an `OPENROUTER_API_KEY` row added by hand in **Environment variables**,
- a machine/user environment variable named `OPENROUTER_API_KEY`.

A key set on the instance beats an ambient one. Saved keys are write-only: the field shows
`Stored secret - enter a new value to replace` rather than the value, because secrets are
stored apart from settings and never returned to the app. To clear one, delete its row in
**Environment variables** — blanking the field does not delete a stored secret, so a stray
click cannot wipe a working key.

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

The provider card in Settings checks the key itself, so the common failures name themselves:

| Card shows                                   | Meaning                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Authenticated**, with a key label          | OpenRouter accepted the key. Credit remaining is shown when the key has a limit.      |
| **No OpenRouter API key** (warning)          | Nothing reached the instance — set `OPENROUTER_API_KEY`.                              |
| **OpenRouter rejected this API key** (error) | Mistyped, revoked, or out of credit. Check <https://openrouter.ai/keys>.              |
| **Could not reach OpenRouter**               | The verification request failed. Says nothing about the key; sessions may still work. |

That status comes from `GET /api/v1/key`, re-checked every 5 minutes and immediately when you
edit the instance. Note the distinction: the _installed / version_ part of the card still
describes the local `claude` binary, so a green card means both the binary and the key are
good.

To check a key outside the app:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/key
```

`200` means the key is good. If this returns 401 while the unauthenticated `/v1/models` call
above succeeds, the problem is the key — not the endpoint and not T3 Code.

Then open a session on the OpenRouter provider and run `/status` — the Anthropic base URL
should read `https://openrouter.ai/api`. The OpenRouter activity dashboard also shows
requests from your API key.

## Context Windows On Non-Anthropic Models

Claude Code only knows the context window of models it ships knowledge of, and a namespaced
gateway slug is not one of them. Left alone it says so on the first turn and assumes 200k:

```text
"moonshotai/kimi-k3" is not a model this version of Claude Code recognizes, so
auto-compact will keep this session within 200k tokens (the context window it assumes).
```

**T3 Code sets the real window for you, so you should not see this.** OpenRouter publishes a
`context_length` per model, T3 Code already fetches that catalogue for the model picker, and
when a thread starts it passes the selected model's figure to the spawned CLI as
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`. Auto-compact then triggers at the model's actual limit, and
the context meter in the composer reads against the same number.

You can see what a model reports:

```bash
curl -s https://openrouter.ai/api/v1/models | jq -r '.data[] | "\(.id)\t\(.context_length)"'
```

Three cases still fall back to Claude Code's 200k assumption, and the warning above is the
signal that you are in one of them:

- **The catalogue has no figure for that model** — a custom model you added by hand that
  OpenRouter does not list, or an entry OpenRouter publishes without a `context_length`.
- **The catalogue could not be fetched** when the instance last checked (offline, OpenRouter
  down). The built-in fallback model list carries no windows, deliberately: a remembered
  number that has since changed would compact your sessions at the wrong point, which is
  worse than a conservative assumption.
- **You set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` yourself.** An explicit value always wins — it
  is how you cap context below what the model allows, to control cost or latency.

Setting it by hand is otherwise no longer necessary:

```text
CLAUDE_CODE_MAX_CONTEXT_TOKENS  262144
```

One limit remains, and it comes from the CLI rather than from T3 Code: the variable is read
once, when the session's process starts. Switching a thread's model mid-conversation
re-points the runtime at the new model but leaves the compact threshold where it was. Start
a new thread when you switch to a model with a materially different window. Anthropic's own
bare slugs (on a Claude provider rather than this one) need none of this — the CLI
recognizes them, and their `Context window` setting is offered in the model picker instead.

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
