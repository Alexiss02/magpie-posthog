// PostHog Desktop's coding plan as a magpie / OpenCode provider plugin.
//
// A PostHog account signs in in the browser (PostHog's own /oauth/authorize,
// PKCE S256, a loopback callback), or is taken as an OAuth access token pasted
// in. Chats then go to PostHog's AI gateway, https://ai-gateway.{us|eu}.posthog.com,
// which is what PostHog Desktop itself calls since the legacy
// gateway.{us|eu}.posthog.com/posthog_code product was retired: that product
// answers every caller with `product_retired` now.
//
// The gateway takes neither the account's `pha_` OAuth token (401 auth_failed)
// nor a personal API key. It takes a `phe_` gateway token, minted per project at
// POST {cloud}/api/projects/{project}/desktop/gateway_token/ with the account's
// `pha_` token. The mint answers the token's lifetime (300 s by default), the
// gateway URL, the plan, the models the credential may call, and the product's
// own model list. So this plugin holds the account's OAuth sign-in, mints a
// gateway token when it needs one, and speaks OpenAI chat completions or
// Anthropic messages to the gateway per model — whichever shapes the gateway
// lists for that model.
//
// The client id is PostHog Desktop's own (PostHog Code), which is what the mint
// checks: its OAuth application allowlist names the three Desktop apps, and that
// app's scope ceiling is `@default` plus the privileged `llm_gateway:read` the
// mint requires.
//
// The Desktop app's own sign-in lives in an AES-256-GCM blob keyed to the
// machine id, which this plugin does not read: sign in here instead, or paste
// the token the app mints.

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

const NPM_CHAT = "@ai-sdk/openai-compatible"
const NPM_MESSAGES = "@ai-sdk/anthropic"
// llm_gateway:read is the raw scope the mint checks; identity scopes come with
// it. billing:read is not needed: /desktop/usage/ carries the plan's dollars.
const SCOPES = "openid profile email llm_gateway:read"
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const EARLY_MS = 60 * 1000 // a token this close to its end is refreshed before a request
const LEAD_MS = 5 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
const KEEP_RENEWED_MS = 60 * 1000 // how long a refresh's result answers for the old refresh token
// The minted gateway token's own renewal: a tenth of its lifetime before the
// end, clamped as Desktop's GatewayTokenService clamps it.
const MINT_MIN_SKEW_MS = 30 * 1000
const MINT_MAX_SKEW_MS = 2 * 60 * 1000
const MINT_MIN_INTERVAL_MS = 5 * 1000 // no second mint inside this, whatever the reason
const ICON = "https://github.com/PostHog.png?size=96"

// PostHog Cloud's two regions, each with the Desktop app's client id (a public
// client: PKCE, no secret) and the AI gateway that serves its coding plan.
const REGIONS = {
  us: {
    id: "us",
    name: "US",
    cloud: "https://us.posthog.com",
    gateway: "https://ai-gateway.us.posthog.com",
    clientId: "HCWoE0aRFMYxIxFNTTwkOORn5LBjOt2GVDzwSw5W",
  },
  eu: {
    id: "eu",
    name: "EU",
    cloud: "https://eu.posthog.com",
    gateway: "https://ai-gateway.eu.posthog.com",
    clientId: "AIvijgMS0dxKEmr5z6odvRd8Pkh5vts3nPTzgzU9",
  },
}

const REGION_PROMPT = {
  type: "select",
  key: "region",
  message: "Which PostHog region is the account on?",
  options: [
    { label: "US (us.posthog.com)", value: "us" },
    { label: "EU (eu.posthog.com)", value: "eu" },
  ],
  validate: (v) => (REGIONS[v] ? "" : "pick us or eu"),
}

// The callback ports the posthog_code app has actually registered for the
// loopback redirect — http://localhost:{8237,8239}/callback
// (products/tasks/backend/management/commands/setup_tasks_oauth.py and the
// pi-posthog-llm-gateway's REDIRECT_PORTS both name those two). PostHog only
// port-relaxes a redirect to the portless http://localhost/callback when the
// app registers that portless form; this app registers specific ports, so a
// random ephemeral port is stripped to http://localhost/callback, which
// matches neither registered URI, and the /authorize consent answers
// "Mismatching redirect URI". The callback must sit on one of the registered
// ports for the redirect to be accepted.
const CALLBACK_PORTS = [8237, 8239]
const redirectFor = (port) => `http://localhost:${port}/callback`

const regionOf = (a) => REGIONS[a?.region] ?? REGIONS[a?.metadata?.region] ?? REGIONS.us
const api = (r) => `${r.gateway}/v1`
const modelsUrl = (r) => `${r.gateway}/v1/models`
// the project the account is scoped to, else the account's current one
const projectOf = (a) => a?.project ?? "@current"
const mintUrl = (r, project) => `${r.cloud}/api/projects/${project}/desktop/gateway_token/`
const usageUrl = (r, project) => `${r.cloud}/api/projects/${project}/desktop/usage/`

// ---- the plan's models -------------------------------------------------------

// What the desktop product lists, as products/tasks/backend/logic/services/
// gateway_model_pin.py pins it: the account's own sign-in adds the SDK's
// implicit models and the legacy ids older app builds call. A list the mint
// doesn't give (a signed-out account) falls back to this.
const PRODUCT_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "@cf/zai-org/glm-5.2",
  "zai-org/glm-5.2",
  "zai-org/glm-5.3",
  "zai-org/glm-5.3-flash",
  "moonshotai/kimi-k3",
  "deepseek-ai/deepseek-v4-flash-0731",
  "deepseek-ai/deepseek-v4.1-flash-1017-fast",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "gpt-5",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5-mini",
]

// What the plan serves without a paid subscription (the gateway's
// posthog_code_free_tier_models): the free marks a signed-out list carries, and
// the models a free-plan credential may call. The gateway serves GLM 5.2 twice,
// under `@cf/` and bare, and the Go gateway answers the bare id.
const FREE_TIER = new Set([
  "@cf/zai-org/glm-5.2",
  "zai-org/glm-5.2",
  "deepseek-ai/deepseek-v4-flash-0731",
  "moonshotai/kimi-k3",
  "zai-org/glm-5.3-flash",
])
const FREE_TIER_LIST = [...new Set([...FREE_TIER].map((id) => id.replace(/^@cf\//, "")))].join(", ")

// The models PostHog's own app never lists, whatever the gateway still serves
// (Desktop's BLOCKED_GATEWAY_MODEL_IDS): older models it keeps out of its
// picker, with and without their vendor prefixes. The product pin leaves most
// of them out already; this keeps a gateway that lists them from offering them.
const BLOCKED = new Set([
  "gpt-5-mini",
  "openai/gpt-5-mini",
  "gpt-5.2",
  "openai/gpt-5.2",
  "gpt-5.3",
  "openai/gpt-5.3",
  "gpt-5.3-codex",
  "openai/gpt-5.3-codex",
  "claude-opus-4-5",
  "anthropic/claude-opus-4-5",
  "claude-opus-4-6",
  "anthropic/claude-opus-4-6",
  "claude-sonnet-4-5",
  "anthropic/claude-sonnet-4-5",
  "claude-haiku-4-5",
  "anthropic/claude-haiku-4-5",
])

// The gateway's own catalogue, as a fallback for a signed-out account or a list
// the gateway won't give: [id, context, prompt, completion, cache read, cache
// write], prices per token, as https://ai-gateway.{us,eu}.posthog.com/v1/models
// quotes them.
const FALLBACK = [
  ["claude-fable-5", 1000000, "0.00001", "0.00005", "0.000001", "0.0000125"],
  ["claude-fable-5-1", 1000000, "0.00001", "0.00005", "0.00000025", "0.0000125"],
  ["claude-opus-4-7", 1000000, "0.000005", "0.000025", "0.0000005", "0.00000625"],
  ["claude-opus-4-8", 1000000, "0.000005", "0.000025", "0.0000005", "0.00000625"],
  ["claude-opus-5", 1000000, "0.000005", "0.000025", "0.0000005", "0.00000625"],
  ["claude-opus-5-5", 1000000, "0.000004", "0.00002", "0.0000002", "0.000005"],
  ["claude-sonnet-4-6", 1000000, "0.000003", "0.000015", "0.0000003", "0.00000375"],
  ["claude-sonnet-5", 1000000, "0.000002", "0.00001", "0.0000002", "0.0000025"],
  ["claude-sonnet-5-5", 1000000, "0.000002", "0.00001", "0.0000001", "0.0000025"],
  ["gpt-5", 400000, "0.00000125", "0.00001", "0.000000125", null],
  ["gpt-5.4", 1050000, "0.0000025", "0.000015", "0.00000025", null],
  ["gpt-5.5", 1050000, "0.000005", "0.00003", "0.0000005", null],
  ["gpt-5.6-luna", 1050000, "0.0000002", "0.0000012", "0.00000002", "0.00000025"],
  ["gpt-5.6-sol", 1050000, "0.000004", "0.00002", "0.0000004", "0.000005"],
  ["gpt-5.6-terra", 1050000, "0.000002", "0.000012", "0.0000002", "0.0000025"],
  ["gpt-6-astra", 1050000, "0.00001", "0.00005", "0.000001", "0.0000125"],
  ["gpt-6-luna", 1050000, "0.0000001", "0.0000005", "0.00000001", "0.000000125"],
  ["gpt-6-sol", 1050000, "0.000002", "0.00001", "0.0000002", "0.0000025"],
  ["gpt-6.1-sol", 1050000, "0.000002", "0.00001", "0.0000001", "0.0000025"],
  ["zai-org/glm-5.2", 262144, "0.0000014", "0.0000044", "0.00000026", null],
  ["zai-org/glm-5.3", 1000000, "0.0000014", "0.0000044", "0.00000014", null],
  ["zai-org/glm-5.3-flash", 1000000, "0.00000015", "0.0000005", "0.00000003", null],
  ["moonshotai/kimi-k3", 1048576, "0.000003", "0.000015", "0.0000003", null],
  ["deepseek-ai/deepseek-v4-flash-0731", 1048000, "0.00000013", "0.00000026", "0.000000028", null],
  ["deepseek-ai/deepseek-v4.1-flash-1017-fast", 1048000, "0.0000006", "0.0000024", "0.000000014", null],
]

// What PostHog's own picker calls each model (its model catalog's labels); the
// gateway names most of them itself, and the open-weight ones it leaves bare.
const NAMES = {
  "@cf/zai-org/glm-5.2": "GLM-5.2",
  "zai-org/glm-5.2": "GLM-5.2",
  "zai-org/glm-5.3": "GLM-5.3",
  "zai-org/glm-5.3-flash": "GLM-5.3 Flash",
  "moonshotai/kimi-k3": "Kimi K3",
  "deepseek-ai/deepseek-v4-flash-0731": "DeepSeek V4 Flash",
  "deepseek-ai/deepseek-v4.1-flash-1017-fast": "DeepSeek V4.1 Flash Fast",
  "gpt-5": "GPT-5",
}

// nameOf is the plan's own name for a model, the gateway's when it has one, the
// id otherwise.
const nameOf = (id, given) => NAMES[id] ?? (given && given !== id ? given : id)

// ---- reasoning levels --------------------------------------------------------

// The gateway takes these (anything else is a 400: "Input should be 'minimal',
// 'low', 'medium', 'high', 'xhigh', 'max' or 'none'"), and Desktop's catalog
// gives each model its ladder. `ultracode` is Desktop's own top rung and is not
// a gateway value, so it is left off every ladder here.
//
// The ladders below were read off the gateway itself, not copied from
// Desktop's catalog: it offers `max` to every GPT model and no GPT model takes
// it ("Unsupported value: 'reasoning_effort' does not support 'max'"), so a
// pick there was a 400.
const STANDARD = ["low", "medium", "high"]
const THROUGH_MAX = [...STANDARD, "xhigh", "max"]
const THROUGH_XHIGH = [...STANDARD, "xhigh"]
const GLM = ["high", "max"]

const EFFORTS = {
  "claude-opus-4-5": STANDARD,
  "claude-opus-4-6": THROUGH_MAX,
  "claude-opus-4-7": THROUGH_MAX,
  "claude-opus-4-8": THROUGH_MAX,
  "claude-opus-5": THROUGH_MAX,
  "claude-opus-5-5": THROUGH_MAX,
  "claude-fable-5": THROUGH_MAX,
  "claude-fable-5-1": THROUGH_MAX,
  "claude-sonnet-4-6": [...STANDARD, "max"], // no xhigh
  "claude-sonnet-5": THROUGH_MAX,
  "claude-sonnet-5-5": THROUGH_MAX,
  "gpt-5": ["minimal", ...STANDARD],
  "gpt-5-mini": ["minimal", ...STANDARD],
  "gpt-5.2": THROUGH_XHIGH,
  "gpt-5.4": THROUGH_XHIGH,
  "gpt-5.5": THROUGH_XHIGH,
  "gpt-5.6-sol": THROUGH_XHIGH,
  "gpt-5.6-terra": THROUGH_XHIGH,
  "gpt-5.6-luna": THROUGH_XHIGH,
  "gpt-6-astra": THROUGH_XHIGH,
  "gpt-6-sol": THROUGH_XHIGH,
  "gpt-6-luna": THROUGH_XHIGH,
  "gpt-6.1-sol": THROUGH_XHIGH,
  "zai-org/glm-5.2": GLM,
  "@cf/zai-org/glm-5.2": GLM,
  "zai-org/glm-5.3": GLM,
  "zai-org/glm-5.3-flash": GLM,
  "moonshotai/kimi-k3": [],
  "deepseek-ai/deepseek-v4-flash-0731": [],
  "deepseek-ai/deepseek-v4.1-flash-1017-fast": [],
}

// A whole family's depths, for a variant the gateway lists and the catalog
// doesn't (gpt-5.3-codex): the longest matching prefix wins.
const FAMILY_EFFORTS = [
  ["gpt-6-astra", THROUGH_XHIGH],
  ["gpt-6-sol", THROUGH_XHIGH],
  ["gpt-6.1-sol", THROUGH_XHIGH],
  ["gpt-6-luna", THROUGH_XHIGH],
  ["gpt-5.6", THROUGH_XHIGH],
  ["gpt-5.5", THROUGH_XHIGH],
  ["gpt-5.4", THROUGH_XHIGH],
  ["gpt-5.2", THROUGH_XHIGH],
]

// levelsOf is the depths a model takes: its own, its family's, the ones every
// Codex model has for a gpt-* id neither claims, none otherwise. Claude is
// absent on purpose — an unnamed Claude model yields no depths, which is what
// keeps an effort off a model PostHog never gave one.
function levelsOf(id) {
  if (Array.isArray(EFFORTS[id])) return EFFORTS[id]
  let best = null
  for (const [prefix, levels] of FAMILY_EFFORTS) {
    if (id.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, levels]
  }
  if (best) return best[1]
  return id.startsWith("gpt-") ? STANDARD : []
}

// ---- which shape a model is spoken to with -----------------------------------

// The gateway lists each model's api_shapes. Claude models are served on
// Anthropic's Messages API only, so magpie must speak that to them; the
// open-weight and OpenAI models answer chat completions. A model the listing
// gives no shapes for is spoken to with what its family is served on: the
// Messages API for Claude, chat completions for the rest.
const shapesOf = (m) => (Array.isArray(m?.api_shapes) ? m.api_shapes : [])
const defaultShapes = (id) => (/^claude/.test(id) ? ["anthropic-messages"] : ["openai-chat-completions"])

function npmOf(id, shapes) {
  const s = shapes.length ? shapes : defaultShapes(id)
  if (s.includes("openai-chat-completions")) return NPM_CHAT
  if (s.includes("anthropic-messages")) return NPM_MESSAGES
  return null // a shape magpie can't speak (gemini, systemone)
}

// visionOf: the models that take images. The gateway's listing carries no
// vision flag, so it comes from the family.
const visionOf = (id) => /^(claude|gpt|gemini)/.test(id)

// ---- reply limits ------------------------------------------------------------

// The most a reply may hold. The gateway's window is the room a prompt and its
// reply share, and Kimi's backend rejects a sum over it, so a reply sized to the
// whole window 400s once a prompt is in it; half the window is what Kimi takes.
// Every other model takes its window, which is what a client asks for when it is
// told the window alone.
const OUTPUTS = { "moonshotai/kimi-k3": 524288 }

// outputOf is a model's reply limit as a client is told it: the cap above, its
// window otherwise, never more than the window.
const outputOf = (id, context) => {
  const cap = OUTPUTS[id] ?? context ?? 0
  return context > 0 && cap > context ? context : cap
}

const price = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function variants(levels) {
  return Object.fromEntries((levels ?? []).map((e) => [e, { reasoningEffort: e }]))
}

function modelOf(provider, region, m) {
  const levels = m.levels ?? []
  const npm = m.npm ?? NPM_CHAT
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: api(region), npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: m.input, output: m.output, cache: { read: m.read, write: m.write } },
    limit: { context: m.context, output: outputOf(m.id, m.context) },
    capabilities: {
      temperature: true,
      reasoning: !!levels.length,
      attachment: !!m.vision,
      toolcall: true,
      input: { text: true, image: !!m.vision, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: variants(levels),
    // magpie's own: served at no cost to the plan's allowance — the free tier's
    // models, which need no paid plan; the account's own mark when the mint gave
    // one (models(), below)
    free: m.free ?? FREE_TIER.has(m.id),
    rate: 0,
  }
}

const fallbackModels = (provider, region) =>
  Object.fromEntries(
    FALLBACK.filter(([id]) => !BLOCKED.has(id)).map(([id, context, prompt, completion, read, write]) => [
      id,
      modelOf(provider, region, {
        id,
        name: nameOf(id),
        context,
        vision: visionOf(id),
        levels: levelsOf(id),
        npm: npmOf(id, []),
        input: price(prompt),
        output: price(completion),
        read: price(read),
        write: price(write),
      }),
    ]),
  )

// own is the list the provider was given, else the one above: the host passes
// the provider the config hook built, and a caller that passes a bare one still
// gets the plan's models.
const own = (provider, region) =>
  provider?.models && Object.keys(provider.models).length ? provider.models : fallbackModels(provider, region)

// A gateway model object as the plugin's own shape. Its prices are strings of
// dollars per token; its api_shapes say which API it is served on.
function fromGateway(id, m) {
  const shapes = shapesOf(m)
  return {
    id,
    name: nameOf(id, m.name || m.display_name || m.slug),
    context: Number(m.context_window) || 0,
    vision: visionOf(id),
    levels: levelsOf(id),
    npm: npmOf(id, shapes),
    shapes,
    input: price(m.pricing?.prompt),
    output: price(m.pricing?.completion),
    read: price(m.pricing?.cache_read ?? m.pricing?.input_cache_read),
    write: price(m.pricing?.cache_write ?? m.pricing?.input_cache_write),
  }
}

// ---- the sign-in -------------------------------------------------------------

// listen binds one of the registered callback ports for the sign-in, whose
// redirect the authorization server then accepts (CALLBACK_PORTS above). No host
// is given, so the server takes both the ::1 and the 127.0.0.1 a browser may
// resolve localhost to.
async function listen() {
  let lastErr
  for (const port of CALLBACK_PORTS) {
    const server = createServer()
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, resolve)
      })
      return { server, port }
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `no PostHog callback port is free (need one of ${CALLBACK_PORTS.join(", ")}): ${lastErr?.message ?? ""}`,
  )
}

const PAGE = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:32rem;text-align:center">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`

// The token endpoint, as the Desktop app calls it: JSON, a public client, no
// secret. Its answer is the OAuth token response (oAuthTokenResponse).
async function token(region, body) {
  const res = await fetch(`${region.cloud}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, client_id: region.clientId }),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text) ?? {}
  } catch {}
  if (!res.ok) {
    const why = env.error_description || env.detail || env.error || text.slice(0, 200) || res.statusText
    throw new Error(`PostHog's token endpoint: ${why} (HTTP ${res.status})`)
  }
  if (!env.access_token) throw new Error("PostHog sent back no access token")
  return env
}

// saved is a token response as the account keeps it.
function saved(region, env, extra = {}) {
  const teams = Array.isArray(env.scoped_teams) ? env.scoped_teams.filter((t) => Number.isInteger(t)) : []
  return {
    type: "success",
    refresh: env.refresh_token ?? "",
    access: env.access_token,
    expires: Date.now() + (Number(env.expires_in) || 0) * 1000,
    region: region.id,
    // a token scoped to one project names it, so the mint and the usage read
    // ask for that project rather than the account's current one
    ...(teams.length === 1 ? { project: teams[0] } : {}),
    accountId: who(env, region),
    ...extra,
  }
}

// who is the account's own name for itself, when the token says: PostHog's
// OAuth tokens name scoped organizations and teams, not people, so the region is
// what the row shows until the user names it.
const who = (env, region) => {
  const orgs = Array.isArray(env.scoped_organizations) ? env.scoped_organizations.length : 0
  const teams = Array.isArray(env.scoped_teams) ? env.scoped_teams.length : 0
  if (!orgs && !teams) return `PostHog ${region.name}`
  return `PostHog ${region.name} · ${orgs} org${orgs === 1 ? "" : "s"}, ${teams} project${teams === 1 ? "" : "s"}`
}

async function browserSignIn(inputs) {
  const region = REGIONS[inputs?.region] ?? REGIONS.us
  const { server, port } = await listen()
  const redirect = redirectFor(port)
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const state = randomBytes(16).toString("hex")

  let settle
  const code = new Promise((resolve) => (settle = resolve))
  let done = false
  const finish = (v) => {
    if (done) return
    done = true
    settle(v)
  }
  const timer = setTimeout(() => finish({ error: "timed out" }), CALLBACK_TIMEOUT_MS)

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`)
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("not found")
      return
    }
    const q = url.searchParams
    const ok = !!q.get("code") && q.get("state") === state
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(
      ok
        ? PAGE("Signed in to PostHog", "You can close this tab and go back to magpie.")
        : PAGE("PostHog sign-in failed", (q.get("error_description") || q.get("error") || "no code came back") + "."),
    )
    finish(ok ? { code: q.get("code") } : { error: q.get("error_description") || q.get("error") || "no code came back" })
  })

  const url = new URL(`${region.cloud}/oauth/authorize/`)
  url.searchParams.set("client_id", region.clientId)
  url.searchParams.set("redirect_uri", redirect)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("scope", SCOPES)
  url.searchParams.set("state", state)
  // as the Desktop app asks: the consent picks a project, and the mint
  // authorizes against the project its token names
  url.searchParams.set("required_access_level", "project")

  return {
    url: url.toString(),
    instructions: `Sign in to PostHog (${region.name}) in the browser; this finishes by itself.`,
    method: "auto",
    async callback() {
      try {
        const got = await code
        if (got.error) return { type: "failed", error: `PostHog sign-in: ${got.error}` }
        const env = await token(region, {
          grant_type: "authorization_code",
          code: got.code,
          redirect_uri: redirect,
          code_verifier: verifier,
        })
        return saved(region, env)
      } catch (e) {
        return { type: "failed", error: e?.message ?? String(e) }
      } finally {
        clearTimeout(timer)
        server.close()
      }
    },
  }
}

// ---- renewing the account's own token ----------------------------------------

// renewing is each refresh under way, by region and the refresh token it spends;
// renewed is what each gave, kept a minute so one that read the old refresh token
// after it was spent takes that rather than spending it again.
const renewing = new Map()
const renewed = new Map()

const refreshable = (a) => !!a.refresh
const stale = (a) => !!a.expires && Date.now() >= a.expires - EARLY_MS

function renew(a, save) {
  const region = regionOf(a)
  const key = region.id + "\n" + a.refresh
  const was = renewed.get(key)
  if (was && Date.now() - was.at < KEEP_RENEWED_MS) return Promise.resolve(merged(a, was.next))
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const env = await token(region, { grant_type: "refresh_token", refresh_token: a.refresh })
      const next = saved(region, env)
      renewed.set(key, { next, at: Date.now() })
      await save?.(next)
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  return r.then((next) => merged(a, next))
}

const TOKEN_FIELDS = ["access", "refresh", "expires", "region", "project", "accountId"]

function merged(a, next) {
  const out = { ...a }
  for (const k of TOKEN_FIELDS) if (next[k] !== undefined && next[k] !== "") out[k] = next[k]
  return out
}

// fresh is the sign-in with an access token that isn't about to end: refreshed
// (and saved) when it is. A refresh that fails leaves the access token there is,
// for the vendor's answer to tell.
async function fresh(client, a) {
  if (!stale(a)) return a
  if (!refreshable(a)) return a
  try {
    return await renew(a, async (next) => {
      try {
        await client?.auth?.set?.({ path: { id: "posthog" }, body: next })
      } catch {}
    })
  } catch (e) {
    if (a.access) return a
    throw e
  }
}

// refreshed is what magpie's auth.refresh gives: the fields a refresh changed,
// nothing when there is nothing to renew. magpie saves them itself.
async function refreshed(auth) {
  if (auth?.type !== "oauth" || !auth.refresh) return undefined
  const next = await renew(auth)
  const out = {}
  for (const k of TOKEN_FIELDS) if (next[k] !== undefined && next[k] !== auth[k]) out[k] = next[k]
  return Object.keys(out).length ? out : undefined
}

// bearerOf is the account's own token: the stored one, or a pasted `pha_` access
// token (an "api" sign-in). It is what the mint is called with, never what the
// gateway takes.
const bearerOf = (a) => (a?.type === "api" ? a.key ?? "" : a?.access ?? "")

// signedIn is what every read starts from: the account with a bearer that isn't
// about to end (refreshed when it was), or null when nothing is signed in.
// getAuth may be the stored account or the host's reader of it.
async function signedIn(client, getAuth) {
  const auth = typeof getAuth === "function" ? await getAuth() : getAuth
  if (!auth || (!auth.access && !auth.key)) return null
  const a = await fresh(client, auth)
  const bearer = bearerOf(a)
  return bearer ? { auth: a, region: regionOf(a), bearer } : null
}

// ---- the gateway token -------------------------------------------------------

// The mint's answer, as this plugin holds it.
function gatewayToken(region, env) {
  const expiresAt = Date.parse(env?.expires_at ?? "")
  return {
    token: env?.token ?? "",
    gateway: String(env?.gateway_url ?? region.gateway).replace(/\/+$/, "").replace(/\/v1$/, ""),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 300_000,
    plan: env?.plan === "paid" ? "paid" : "free",
    allowed: Array.isArray(env?.allowed_models) ? env.allowed_models : null,
    product: Array.isArray(env?.product_models) && env.product_models.length ? env.product_models : PRODUCT_MODELS,
    capUsd: env?.cap_usd ?? null,
  }
}

// minted is each project's gateway token, and the mint under way for it: the
// mint is throttled per user (120 an hour), so one is never started while
// another is, and a token still good is kept.
const minted = new Map()

// mint asks Django for a gateway token for the account's project, as Desktop's
// GatewayTokenService does. Any non-201 is a refusal, and its `reason` says
// which — the same reasons Desktop's card explains.
async function mint(region, project, bearer) {
  const res = await fetch(mintUrl(region, project), {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text) ?? {}
  } catch {}
  if (res.status !== 201 || !env.token) {
    const reason = env.reason || env.code || `http_${res.status}`
    const why = env.detail || env.error || text.trim().slice(0, 200) || res.statusText
    throw refusal(reason, why, res.status, env.access)
  }
  return gatewayToken(region, env)
}

// refusal is a mint that said no, carrying what the card can say about it.
function refusal(reason, why, status, access) {
  const err = new Error(why || reason)
  err.reason = reason
  err.status = status
  if (access) err.access = access
  // a refusal the user can't clear by signing in again keeps the sign-in
  err.signIn = reason === "oauth_required" || reason === "unauthorized" ? "expired" : "kept"
  return err
}

const MINT_HINTS = {
  email_unverified: "verify your email on PostHog, then try again",
  unauthorized: "this sign-in is no longer authorized for the project; sign in again",
  oauth_required: "sign in again with PostHog Desktop's own app (the plugin does this for you)",
  blocked: "this account can't use PostHog's AI gateway",
  desktop_access_blocked: "PostHog Desktop access isn't enabled for this project (it needs a paid plan or an approved org)",
  credit_bucket_exhausted: "the plan's credits are used up; add credits or wait for the period to reset",
  org_deactivated: "this organization is deactivated",
  desktop_access_unavailable: "PostHog couldn't verify Desktop access just now; try again shortly",
  throttled: "too many gateway-token requests; wait a few minutes",
  unconfigured: "PostHog hasn't enabled the AI gateway for this cloud",
  mint_failed: "PostHog couldn't mint a gateway token; try again shortly",
}

const explainedMint = (e) => (MINT_HINTS[e?.reason] ? `${e.message} — ${MINT_HINTS[e.reason]}` : e?.message ?? String(e))

// gatewayFor is the gateway token for an account's project: the one held while it
// is good, a mint when it is not, and the same promise to every caller that
// arrives during a mint. `stale` forces a new one (a 401 from the gateway).
async function gatewayFor(s, stale = false) {
  const project = projectOf(s.auth)
  const key = `${s.region.id}\n${project}\n${s.bearer.slice(-12)}`
  const was = minted.get(key)
  if (was?.inFlight) return was.inFlight
  const now = Date.now()
  if (was?.value && !stale && now < was.refreshAt) return was.value
  // the mint is throttled per user: a second one inside this window is not
  // started, and the token still held answers instead
  if (was?.value && now - was.mintedAt < MINT_MIN_INTERVAL_MS) {
    if (!stale) return was.value
    throw Object.assign(new Error("PostHog's gateway refused this token and a new one was minted moments ago; retry in a few seconds"), { signIn: "kept" })
  }
  const entry = was ?? { value: null, mintedAt: 0, refreshAt: 0, inFlight: null }
  entry.mintedAt = now
  entry.inFlight = (async () => {
    const value = await mint(s.region, project, s.bearer)
    const lifetime = value.expiresAt - Date.now()
    const skew = Math.min(MINT_MAX_SKEW_MS, Math.max(MINT_MIN_SKEW_MS, lifetime / 10))
    entry.value = value
    entry.refreshAt = value.expiresAt - skew
    return value
  })().finally(() => {
    entry.inFlight = null
  })
  minted.set(key, entry)
  return entry.inFlight
}

// ---- the allowance -----------------------------------------------------------

const ISO = (v) => {
  if (v === undefined || v === null || v === "") return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

// usageOf is the plan's allowance as /api/projects/{id}/desktop/usage/ reports
// it: the plan's dollar bucket when the account's billing reports one, then the
// burst (daily) and sustained (30-day) valves.
//
// A plan with no dollars (code usage not subscribed, and no bucket reported)
// shows only its sustained valve, as Desktop's own codeUsageMeter does: burst is
// meaningless there. An absent code_usage_subscribed is unknown, not free, and
// keeps both valves.
function usageOf(body) {
  const u = body ?? {}
  const out = {
    plan: u?.is_pro ? "Pro" : u?.code_usage_subscribed ? "Desktop" : "Free",
    windows: [],
    ...(ISO(u?.billing_period_end) ? { until: ISO(u.billing_period_end) } : {}),
  }
  const limit = (name, w) => {
    if (!w || typeof w !== "object") return
    out.windows.push({
      name,
      used: Math.max(0, Number(w.used_percent) || 0),
      ...(ISO(w.reset_at) ? { resetsAt: ISO(w.reset_at) } : {}),
      ...(Number.isFinite(w.resets_in_seconds) ? { resetSecs: Math.max(0, Math.round(w.resets_in_seconds)) } : {}),
    })
  }
  const credits = u?.ai_credits
  const usedUsd = Number.isFinite(credits?.used_usd) ? credits.used_usd : null
  const limitUsd = Number.isFinite(credits?.limit_usd) ? credits.limit_usd : null
  if (usedUsd !== null && limitUsd !== null && limitUsd > 0) {
    // the plan's dollars, as Desktop's codeUsageMeter draws them
    out.windows.push({
      name: "Credits",
      used: Math.min(100, (100 * usedUsd) / limitUsd),
      display: `$${usedUsd.toFixed(2)} / $${limitUsd.toFixed(2)}`,
      amount: usedUsd,
      limit: limitUsd,
      unit: "usd",
      ...(ISO(u?.billing_period_end) ? { resetsAt: ISO(u.billing_period_end) } : {}),
    })
  }
  if (u?.code_usage_subscribed === false) {
    limit("Sustained", u.sustained)
  } else {
    limit("Burst", u.burst)
    limit("Sustained", u.sustained)
  }
  return out
}

// ---- answers -----------------------------------------------------------------

// HINTS say what a gateway refusal the user can act on means, in the words the
// card can carry. Each keeps the sign-in unless the token itself was refused.
const HINTS = [
  [
    /credit_bucket_exhausted|out of credits/i,
    "the plan's credits are used up; add credits or wait for the period to reset",
  ],
  [
    /desktop_access_blocked|desktop access/i,
    "PostHog Desktop access isn't enabled for this project (it needs a paid plan or an approved org)",
  ],
  [/paid_plan_required|model not allowed for this credential/i, "this model needs a paid plan; the free tier serves " + FREE_TIER_LIST],
  [
    /product_retired/i,
    "PostHog retired the old gateway for this product; this plugin mints a gateway token instead — update the plugin",
  ],
  [
    /OAuth application not authorized|product_access_denied/i,
    "this token wasn't issued to PostHog Desktop's app, so the gateway refuses it",
  ],
]

// ---- parameters the gateway's models refuse ----------------------------------

// The most refusals one request is mended through. Each pass takes one
// parameter out, and a body has a handful the GPT models reject.
const REPAIRS = 4

// The parameters an OpenAI-served model refuses, and what to do about each:
// `max_tokens` becomes the field those models take, the rest come out. A
// refusal names its parameter in `error.param`, and a temperature names the one
// value it does take in the message, so the mended body keeps that value rather
// than losing the field.
const TAKEN_OUT = ["top_p", "presence_penalty", "frequency_penalty", "logprobs", "top_logprobs", "stop", "parallel_tool_calls"]

// repair is the body with the parameter the refusal names taken out, or null
// when the refusal isn't one it can mend (a real error is left to be shown).
function repair(body, why) {
  if (typeof body !== "string") return null
  let v
  try {
    v = JSON.parse(body)
  } catch {
    return null
  }
  let param = ""
  let message = ""
  try {
    const e = JSON.parse(why)?.error
    param = typeof e?.param === "string" ? e.param : ""
    message = typeof e?.message === "string" ? e.message : ""
  } catch {}
  if (!param && !message) return null
  if (param === "max_tokens" && "max_tokens" in v) {
    // the models that refuse max_tokens take its value as max_completion_tokens
    if (!("max_completion_tokens" in v)) v.max_completion_tokens = v.max_tokens
    delete v.max_tokens
  } else if (param && param in v && (TAKEN_OUT.includes(param) || param === "temperature")) {
    if (param === "temperature") {
      // "does not support 0.7 with this model. Only the default (1) value is
      // supported": the one value it takes is in the message
      const only = /only the default \(([\d.]+)\)/i.exec(message)
      if (only) v.temperature = Number(only[1])
      else delete v.temperature
    } else {
      delete v[param]
    }
  } else if (!param && /reasoning_effort/i.test(message)) {
    // an effort the model has no rung for: left to the caller, who is offered
    // the ladder (levelsOf), not mended into another depth behind its back
    return null
  } else {
    return null
  }
  return JSON.stringify(v)
}

// explained is a refused answer with the hint for it, if any, and the sign-in
// kept unless the gateway refused the credential itself.
async function explained(res) {
  const text = await res.text()
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  const lapsed = res.status === 401
  headers.set("X-Magpie-Sign-In", lapsed ? "expired" : "kept")
  let msg = text.trim().slice(0, 500)
  try {
    const v = JSON.parse(text)
    const d = v?.error ?? v?.detail ?? v
    msg = (typeof d === "string" ? d : d?.message ?? d?.detail ?? msg) || msg
    if (typeof msg !== "string") msg = JSON.stringify(d).slice(0, 500)
  } catch {}
  for (const [re, hint] of HINTS) {
    if (re.test(text)) {
      headers.set("content-type", "application/json")
      return new Response(JSON.stringify({ error: { message: `${msg} — ${hint}`, type: lapsed ? "authentication_error" : "permission_error" } }), {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    }
  }
  return new Response(text, { status: res.status, statusText: res.statusText, headers })
}

const kept = (res) => {
  const headers = new Headers(res.headers)
  headers.set("X-Magpie-Sign-In", "kept")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

// ---- the plugin --------------------------------------------------------------

export const PostHogAuthPlugin = async ({ client }) => ({
  config: async (config) => {
    config.provider ??= {}
    config.provider.posthog ??= {}
    const p = config.provider.posthog
    p.name ??= "PostHog"
    p.npm ??= NPM_CHAT
    p.api ??= api(REGIONS.us)
    p.models = { ...fallbackModels({ id: "posthog" }, REGIONS.us), ...(p.models ?? {}) }
  },

  provider: {
    id: "posthog",
    // the plan's own list when the account is signed in and the gateway answers;
    // the list above otherwise. The gateway's own /v1/models is unfiltered (every
    // model it serves, for any product), so the product's pin narrows it and the
    // minted credential's pin marks what this account may actually call: the
    // models a paid plan unlocks stay listed with free off, as PostHog's own
    // picker marks them, and magpie's free-only filter leaves them out.
    async models(provider, { auth }) {
      const s = await signedIn(client, auth)
      if (!s) return own(provider, regionOf(auth))
      let gw
      try {
        gw = await gatewayFor(s)
      } catch (e) {
        // a mint that said no is the account's problem, not a list to fall back
        // from: magpie shows the reason over the list
        throw Object.assign(new Error(explainedMint(e)), { signIn: e?.signIn ?? "kept" })
      }
      try {
        const res = await fetch(`${gw.gateway}/v1/models`, {
          headers: { Authorization: `Bearer ${gw.token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return own(provider, s.region)
        const env = await res.json().catch(() => null)
        const list = Array.isArray(env) ? env : env?.data ?? env?.models ?? []
        const product = new Set(gw.product)
        const allowed = gw.allowed === null ? null : new Set(gw.allowed)
        const ms = []
        for (const raw of list) {
          const id = raw?.id
          if (!id || raw.visibility === "hidden" || raw.supported_in_api === false) continue
          const names = [id, raw.canonical, ...(Array.isArray(raw.aliases) ? raw.aliases : [])].filter(Boolean)
          if (!names.some((n) => product.has(n))) continue
          if (BLOCKED.has(String(id).toLowerCase())) continue
          const m = fromGateway(id, raw)
          if (!m.npm) continue // a shape magpie can't speak
          // free is what the plan serves without paying: a paid credential calls
          // the whole list, and then only the free tier's models are free; a free
          // one calls exactly the free tier, and those are all of them
          if (allowed && gw.plan !== "paid") m.free = names.some((n) => allowed.has(n))
          ms.push(m)
        }
        if (!ms.length) return own(provider, s.region)
        const region = { ...s.region, gateway: gw.gateway }
        return Object.fromEntries(ms.map((m) => [m.id, modelOf(provider, region, m)]))
      } catch {
        return own(provider, s.region)
      }
    },
  },

  auth: {
    provider: "posthog",
    icon: ICON,
    // magpie renews a browser sign-in LEAD_MS before its end, once for the
    // account, before its requests, models and usage ask; the check before each
    // request stays for OpenCode, which doesn't call this.
    refreshLead: LEAD_MS,
    refresh: (auth) => refreshed(auth),

    async loader(getAuth) {
      const first = await signedIn(client, getAuth)
      if (!first) return {}
      // a mint that said no is why nothing can be sent: said here, with what to
      // do about it, rather than handed back as an empty set of options
      let gw
      try {
        gw = await gatewayFor(first)
      } catch (e) {
        throw Object.assign(new Error(explainedMint(e)), { signIn: e?.signIn ?? "kept" })
      }
      return {
        baseURL: `${gw.gateway}/v1`,
        apiKey: "posthog", // replaced by the minted token on every request below
        async fetch(input, init) {
          const req = input instanceof Request ? input : null
          let body = init?.body
          if (body === undefined && req) body = await req.clone().text()
          // The gateway serves the GPT models on OpenAI's terms: they refuse
          // `max_tokens`, and a temperature other than their one default, and
          // some refuse sampling altogether. The client speaks the shape it was
          // told (chat completions), so the plugin takes those back out of the
          // body before it goes: once per refusal the gateway names.
          const mend = (why) => {
            const next = repair(body, why)
            if (next === null) return false
            body = next
            return true
          }
          const send = async (token, host) => {
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("authorization")
            headers.delete("x-api-key")
            // the gateway takes the minted token as either header, and magpie's
            // Anthropic path sends x-api-key, so both are set
            headers.set("Authorization", `Bearer ${token}`)
            headers.set("x-api-key", token)
            headers.set("Accept", headers.get("Accept") ?? "application/json")
            if (typeof body === "string" && body !== init?.body) headers.delete("content-length")
            const url = new URL(req ? req.url : String(input))
            // the gateway the token was minted for: the request keeps its path
            // (/v1/chat/completions, /v1/messages), at that host
            return fetch(`${host}${url.pathname}${url.search}`, {
              ...init,
              method: init?.method ?? req?.method,
              headers,
              body,
            })
          }
          let s = await signedIn(client, getAuth)
          if (!s) throw Object.assign(new Error("PostHog isn't signed in"), { signIn: "expired" })
          let gw
          try {
            gw = await gatewayFor(s)
          } catch (e) {
            throw Object.assign(new Error(explainedMint(e)), { signIn: e?.signIn ?? "kept" })
          }
          let res = await send(gw.token, gw.gateway)
          if (res.status === 401) {
            // a token past its end (or one the gateway dropped): mint again, once
            try {
              gw = await gatewayFor(s, true)
              res = await send(gw.token, gw.gateway)
            } catch (e) {
              throw Object.assign(new Error(explainedMint(e)), { signIn: e?.signIn ?? "kept" })
            }
          }
          // a parameter the model refuses: take it out and ask again. Bounded,
          // and only for a body the gateway itself named a parameter in, so a
          // real refusal is never sent twice
          for (let tries = 0; res.status === 400 && tries < REPAIRS; tries++) {
            const why = await res.text()
            if (!mend(why)) {
              res = new Response(why, { status: res.status, statusText: res.statusText, headers: res.headers })
              break
            }
            res = await send(gw.token, gw.gateway)
          }
          return res.status >= 400 ? explained(res) : kept(res)
        },
      }
    },

    // the plan's allowance, as PostHog's own usage endpoint reports it; each read
    // keeps the sign-in, so a vendor's refusal never marks the account lapsed
    async usage(getAuth) {
      const s = await signedIn(client, getAuth)
      if (!s) return { error: "not signed in", signIn: "kept" }
      try {
        const res = await fetch(usageUrl(s.region, projectOf(s.auth)), {
          headers: { Authorization: `Bearer ${s.bearer}`, Accept: "application/json" },
          signal: AbortSignal.timeout(20000),
        })
        if (res.status === 401 || res.status === 403) {
          return { error: "PostHog turned this sign-in away; sign in again", signIn: "expired" }
        }
        if (!res.ok) {
          const text = await res.text()
          let why = text.trim().slice(0, 200)
          try {
            const v = JSON.parse(text)
            why = v?.detail ?? v?.error?.message ?? why
          } catch {}
          return { error: `${why} (HTTP ${res.status})`, signIn: "kept" }
        }
        return { ...usageOf(await res.json()), signIn: "kept" }
      } catch (e) {
        return { error: e?.message ?? String(e), signIn: "kept" }
      }
    },

    methods: [
      {
        type: "oauth",
        label: "PostHog account (browser)",
        prompts: [REGION_PROMPT],
        authorize: browserSignIn,
      },
      {
        type: "api",
        label: "PostHog OAuth access token (pha_…)",
        placeholder: "pha_…",
        prompts: [REGION_PROMPT],
      },
    ],
  },
})

// for tests
export const _internal = {
  REPAIRS,
  repair,
  REGIONS,
  SCOPES,
  PRODUCT_MODELS,
  FREE_TIER,
  BLOCKED,
  FALLBACK,
  OUTPUTS,
  api,
  modelsUrl,
  mintUrl,
  usageUrl,
  projectOf,
  redirectFor,
  CALLBACK_PORTS,
  saved,
  who,
  fromGateway,
  levelsOf,
  outputOf,
  npmOf,
  modelOf,
  fallbackModels,
  usageOf,
  merged,
  stale,
  refreshed,
  bearerOf,
  signedIn,
  gatewayToken,
  gatewayFor,
  mint,
  minted,
  explained,
  explainedMint,
  HINTS,
  renewing,
  renewed,
}
