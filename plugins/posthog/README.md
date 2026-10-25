# posthog

PostHog Desktop's coding plan (PostHog Code) as a magpie / OpenCode provider
plugin: sign in to a PostHog account, and chat with the plan's models through
PostHog's AI gateway.

```
magpie plugin add github:Alexiss02/magpie-posthog
magpie plugin login posthog
```

## What it serves

| | |
|---|---|
| Provider id | `posthog` |
| Gateway | `https://ai-gateway.{us,eu}.posthog.com/v1` — OpenAI chat completions, OpenAI responses, Anthropic messages |
| Credential | a `phe_` gateway token minted per project at `POST {cloud}/api/projects/{project}/desktop/gateway_token/` |
| Models | the gateway's `/v1/models`, narrowed to the desktop product's pin and marked by the minted credential's own pin |
| Allowance | `GET {cloud}/api/projects/{project}/desktop/usage/` — the plan's credits, on the billing period |
| Own ceiling | plugin option `maxCredits`, e.g. `magpie plugin options github:Alexiss02/magpie-posthog '{"maxCredits": 1900}'` |

The `posthog_code` product on the older `gateway.{us,eu}.posthog.com` gateway is retired: it
answers every caller with `product_retired`. PostHog Desktop now mints a short-lived `phe_` token
from Django and calls the AI gateway with it, and so does this plugin.

## Signing in

**PostHog account (browser).** The plugin binds a loopback port, opens
`{cloud}/oauth/authorize/` with PKCE S256 and `required_access_level=project`, and takes the code
the browser brings back to `http://localhost:{8237,8239}/callback` — the ports the Desktop app
registered, so the redirect is accepted. It exchanges the code at `{cloud}/oauth/token` and keeps
the access and refresh tokens. The OAuth client is PostHog Desktop's own, which is the only thing
the token mint accepts.

**PostHog OAuth access token.** Paste a `pha_…` token minted elsewhere. Pick the region it belongs
to. It is used to mint gateway tokens; nothing is refreshed until you sign in in the browser, since
a bare access token has no refresh token beside it.

The Desktop app's own session lives in `%APPDATA%\PostHog\posthog-code.db`, an AES-256-GCM blob
keyed to this machine's id; the plugin does not read it. Use the browser sign-in instead.

## The gateway token

The AI gateway takes neither the account's `pha_` token nor a personal API key: it takes a `phe_`
token, minted for one project. So every request path starts with a mint:

```
POST https://us.posthog.com/api/projects/608221/desktop/gateway_token/
Authorization: Bearer pha_…
```

Its 201 carries `token`, `expires_at` (300 s by default), `gateway_url`, `plan`
(`free` / `paid`), `allowed_models` (what this credential may call) and `product_models`
(the desktop product's whole list). Any other status is a refusal whose `reason` says which —
`credit_bucket_exhausted`, `desktop_access_blocked`, `email_unverified`, `unauthorized`,
`throttled`, `unconfigured`, `mint_failed` — and each is reported with what to do about it.

The plugin holds the minted token per project until a tenth of its lifetime is left, mints once
even when several requests arrive together, and mints again on a 401 from the gateway. It never
mints twice inside five seconds: the mint is throttled to 120 an hour for the whole account, so a
second refusal that fast is reported as an error to retry rather than turned into a mint loop.

## Models

The gateway's `/v1/models` is unfiltered — every model it serves for any product, including Gemini
models and PostHog's own. The plugin narrows it three ways, as Desktop's own session does:

1. the desktop product's pin (`product_models` from the mint), so nothing outside the plan is
   offered;
2. PostHog's own blocklist of older ids (`gpt-5-mini`, `gpt-5.2`, `gpt-5.3-codex`,
   `claude-opus-4-5/4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`);
3. the shape it is served on — `gemini-generate-content` and `systemone` are dropped, since magpie
   can speak neither.

Each model's `api_shapes` decides which API magpie uses: Claude models are served on Anthropic's
Messages API only, so they are listed as `@ai-sdk/anthropic`; the open-weight and OpenAI models
answer chat completions, so they are `@ai-sdk/openai-compatible`. A model served on both takes chat
completions.

**Free tier.** A free-plan credential may call exactly four models —
`zai-org/glm-5.2`, `deepseek-ai/deepseek-v4-flash-0731`, `moonshotai/kimi-k3`,
`zai-org/glm-5.3-flash` — and those are marked `free`, so magpie badges them and its free-only
filter picks them. Every other model stays listed with `free` off: asking for one on a free plan
answers 403 `model_not_allowed`, which the card explains, naming what the free tier does serve.

**Reasoning levels.** The gateway takes `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and
`none` — anything else is a 400. The plugin publishes the ladder each model actually takes, read
off the gateway rather than copied from Desktop's catalog:

| Model | Ladder |
|---|---|
| Opus 4.6 and up, Fable 5 / 5.1, Sonnet 5 / 5.5 | `low` `medium` `high` `xhigh` `max` |
| Sonnet 4.6 | `low` `medium` `high` `max` (no `xhigh`) |
| Opus 4.5 | `low` `medium` `high` |
| GPT-5, GPT-5 mini | `minimal` `low` `medium` `high` |
| GPT-5.4, GPT-5.5, GPT-6 Astra, GPT-6.1 Sol | `low` `medium` `high` `xhigh` |
| GPT-5.6 Sol / Terra / Luna, GPT-6 Sol, GPT-6 Luna | `none` `low` `medium` `high` `xhigh` |
| GLM family | `high` `max` |
| Kimi K3, DeepSeek V4 Flash, DeepSeek V4.1 Flash Fast | none — no effort control |

Desktop's catalog offers `max` to every GPT model; the gateway answers `Unsupported value:
'reasoning_effort' does not support 'max'` for all of them, so it is on no GPT ladder here.
`ultracode` is Desktop's own top rung and not a gateway value — `/v1/messages` answers
`output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'` — so it is on
none either. `none` is on the three families that take it and turns thinking off; the older GPTs
answer `does not support 'none' with this model`.

A level reaches the model under the key its API reads it from: the Messages API takes an effort as
`output_config.effort`, which its AI SDK package sets from `effort`, while the OpenAI-shaped APIs
take `reasoning_effort`, set from `reasoningEffort`. A level filed under the other key is dropped
and the model thinks at its default, so the two are kept apart per model.

**Parameters the GPT models refuse.** The gateway serves the GPT models on OpenAI's terms: they
reject `max_tokens` (`Use 'max_completion_tokens' instead`), a `temperature` other than their one
default, and `top_p`, `presence_penalty`, `frequency_penalty`, `stop`, `logprobs` and
`parallel_tool_calls` outright. A client that speaks chat completions sends `max_tokens` and often a
temperature, so the plugin mends the body when the gateway names the parameter — `max_tokens`
becomes `max_completion_tokens` at the same value, a temperature takes the one value the message
names, and the rest come out — and asks again, at most four times. A refusal that names no
mendable parameter is shown as it came; a `reasoning_effort` refusal is never mended into another
depth behind the caller's back.

**Reply limits.** The context window is what a prompt and its reply share. Kimi's backend rejects
a sum over its window, so its reply is capped at half of it (524288); every other model takes its
window, which is what a client asks for when it is told the window alone.

## Allowance

`/desktop/usage/` reports the plan's dollar bucket (`ai_credits`, from the organization's billing).
The card reads it in the plan's own unit, **credits** — a credit is a cent, the endpoint's
`_USD_PER_CREDIT = 0.01`, so a plan whose `limit_usd` is `21` holds 2100 of them and the card says
`18 / 2100 credits`.

The valves are not drawn, because the backend can't move them: `desktop_access.py` builds both
`burst` and `sustained` with `_exempt_window`, so `used_percent` is `0.0` and `exceeded` false by
construction — its own comment calls them *"the legacy gateway's usage windows for posthog_code,
which its cost throttles exempt"* — and the gateway's `_UserCostThrottleBase._is_exempt` returns
true for `posthog_code` whatever the user. A meter that can only ever read 0% is a meter that lies.
The plugin still renders a valve the moment one reports movement (`used_percent > 0` or
`exceeded`), so a server that starts charging there is followed rather than assumed away.

Every model bills the same way, `deepseek-ai/deepseek-v4.1-flash-1017-fast` included: `posthog_code`
declares `credit_bucket=CreditBucket.POSTHOG_CODE_CREDITS` at the product level, and the model is
pinned to that product (`gateway_model_pin.py`), so there is no per-model choice. Billing is a pure
pass-through of the provider's list price — `POSTHOG_CODE_COST_MARKUP_PERCENT = 0.0`.

A 401 or 403 from the usage read marks the account lapsed; every other failure keeps the sign-in.

## A ceiling of your own

`maxCredits` caps what the plan may spend, under its own limit:

```
magpie plugin options github:Alexiss02/magpie-posthog '{"maxCredits": 1900}'
```

Past it the plugin refuses every request with a `credit cap is reached` error naming the option, and
the card reads against 1900 rather than the plan's 2100.

The plan's own reading cannot hold a ceiling by itself: `posthog/tasks/scheduled.py` sends the usage
report at 03:45 UTC and `ee/billing/quota_limiting.py` reads what it wrote, so `used_usd` lags by up
to a day and a day's spend would cross the cap before the number moved. So the plugin meters the
calls it makes itself: each reply's `usage` is priced at the gateway's own per-token figures
(`/v1/models`' `pricing`, cached tokens at `cache_read`) and added to the plan's last reading. The
reading is asked for at most once every five minutes, and a reading that catches up with the local
spend is not counted twice.

The three shapes the gateway serves disagree about where the cache sits, and the pricing reads each
on its own terms:

| shape | prompt count | cached | where the cache sits |
|---|---|---|---|
| chat completions | `prompt_tokens` | `prompt_tokens_details.cached_tokens` | **inside** the count |
| Responses | `input_tokens` | `input_tokens_details.cached_tokens` | **inside** the count |
| Messages | `input_tokens` | `cache_read_input_tokens` | **beside** the count |

An inside figure is taken back out before the fresh tokens are priced. Counting it twice is not a
rounding error: `gpt-5` at 6313 input of which 6272 cached is $0.00116, and the double count would
bill $0.00900.

Nothing is buffered for this: an unstreamed reply is read beside the caller, and a streamed one is
scanned as it goes by, its cost taken from the last chunk that carries `usage`.

## Refusals

A gateway refusal never marks the account lapsed, except a 401 from the gateway itself (the
credential, not the plan, was refused) — the plugin mints once more and retries before saying so.
The refusals it explains: credits used up, Desktop access not enabled for the project, a model that
needs a paid plan (naming the free tier), a credential that isn't Desktop's, and the retired
product.

## Self-check

```
node test-posthog.mjs           # the pure parts and the hooks, offline
node test-posthog.mjs --live    # also signs in and talks to PostHog
```

`--live` uses the sign-in magpie keeps (`~/.config/magpie/plugin-auth.json`) or a
`POSTHOG_ACCESS` token, lists the plan's models, reads the allowance, and sends one chat to a free
model through the plugin's own fetch.
