# posthog

PostHog Desktop's coding plan (PostHog Code) as a magpie / OpenCode provider
plugin: sign in to a PostHog account, and chat with the plan's models through
PostHog's LLM gateway.

```
magpie plugin add github:Alexiss02/magpie-plugins
magpie plugin login posthog
```

## What it serves

| | |
|---|---|
| Provider id | `posthog` |
| Gateway | `https://gateway.{us,eu}.posthog.com/posthog_code/v1` (OpenAI-compatible chat completions) |
| Bearer | the account's `pha_` OAuth access token, which is what the gateway takes |
| Models | `GET {gateway}/posthog_code/v1/models` — the plan's own list, 30 today |
| Allowance | `GET {gateway}/v1/usage/posthog_code` — burst, sustained and AI-credit windows |

The `posthog_code` product accepts OAuth tokens from PostHog Desktop's three OAuth applications
only, and those apps' scope ceilings are `@default` plus the privileged `llm_gateway:read` the
gateway requires. So the plugin signs in as the Desktop app (its public client id, PKCE S256, no
secret) and asks for `openid profile email llm_gateway:read`; the server clamps that to the
ceiling and grants it. It does not need the Desktop app installed.

## Signing in

**PostHog account (browser).** The plugin binds a loopback port, opens
`{region}/oauth/authorize/` with PKCE S256 and `required_access_level=project`, and takes the code
the browser brings back to `http://localhost:{port}/callback` — the portless redirect the Desktop
app registered, so any port is accepted. It then exchanges the code at `{region}/oauth/token` and
keeps the access and refresh tokens.

**PostHog OAuth access token.** Paste a `pha_…` token minted elsewhere (the Desktop app's own
sign-in, or a script's). Pick the region it belongs to. Nothing is refreshed until you sign in in
the browser, since a bare access token has no refresh token beside it.

The Desktop app's own session lives in `%APPDATA%\PostHog\posthog-code.db`, an AES-256-GCM blob
keyed to this machine's id; the plugin does not read it. Use the browser sign-in instead.

## Notes

- **Projects.** The gateway authorizes a request against the project its token names. When the
  consent picks exactly one project, the plugin sends it as `X-PostHog-Project-Id`; with several,
  the gateway falls back to the account's current one. `posthog_code` additionally needs Desktop
  access enabled for that project, which PostHog grants to paid plans.
- **Names.** The gateway's `display_name` is the raw model id (`@cf/zai-org/glm-5.2`), so the
  plugin uses the label PostHog's own model catalog gives each model (`GLM-5.2`).
- **Reasoning levels.** The gateway's model list carries none — `supported_reasoning_levels` is
  empty for all 30 — so the plugin takes the depths from PostHog's model catalog, the same data
  its Desktop picker draws its effort dropdown from: Claude Opus/Sonnet 5 the extended ladder
  (low→ultracode), Opus 4.5 the standard three, GPT-5.5 up to xhigh, the GLM family two depths
  (high, max), and Kimi K3 and DeepSeek V4 Flash none at all. The gateway's own answer wins if it
  ever carries one.
- **Free tier.** PostHog's free tier serves four models — `@cf/zai-org/glm-5.2`,
  `deepseek-ai/deepseek-v4-flash-0731`, `moonshotai/kimi-k3`, `zai-org/glm-5.3-flash` — which the
  plugin marks `free`, so magpie badges them and its free-only filter picks them. Anything else
  needs a paid plan and comes back as a refusal the card explains, naming what the free tier does
  serve.
- **Refusals keep the sign-in.** A gateway 403 (credits spent, no paid plan, Desktop access off,
  the wrong OAuth app) is reported with what to do about it and never marks the account lapsed;
  only a 401 from the usage read does.

## Self-check

```
node test-posthog.mjs           # the pure parts and the hooks, offline
node test-posthog.mjs --live    # also asks the gateway for its model list
```
