// PostHog Desktop's coding plan as a magpie / OpenCode provider plugin.
//
// A PostHog account signs in in the browser (PostHog's own /oauth/authorize,
// PKCE S256, a loopback callback), or is taken as an OAuth access token pasted
// in. Its chats are OpenAI-compatible chat completions at the LLM gateway's
// product route, https://gateway.{us|eu}.posthog.com/posthog_code/v1, streamed
// or not, with the account's `pha_` access token as the bearer.
//
// The client id is PostHog Desktop's own (PostHog Code), which is the only
// thing the gateway's `posthog_code` product accepts: its OAuth application
// allowlist names the three Desktop apps, and that app's scope ceiling is
// `@default` plus the privileged `llm_gateway:read` the gateway requires.
// Asking for that scope alone is enough — the server clamps the request to the
// ceiling and grants identity scopes with it.
//
// The Desktop app's own sign-in lives in an AES-256-GCM blob keyed to the
// machine id, which this plugin does not read: sign in here instead, or paste
// the token the app mints.

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

const NPM = "@ai-sdk/openai-compatible"
const PRODUCT = "posthog_code"
const SCOPES = "openid profile email llm_gateway:read"
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const EARLY_MS = 60 * 1000 // a token this close to its end is refreshed before a request
const LEAD_MS = 5 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
const KEEP_RENEWED_MS = 60 * 1000 // how long a refresh's result answers for the old refresh token
const ICON = "https://github.com/PostHog.png?size=96"

// PostHog Cloud's two regions, each with the Desktop app's client id (a public
// client: PKCE, no secret) and the gateway that serves its coding plan.
const REGIONS = {
  us: {
    id: "us",
    name: "US",
    cloud: "https://us.posthog.com",
    gateway: "https://gateway.us.posthog.com",
    clientId: "HCWoE0aRFMYxIxFNTTwkOORn5LBjOt2GVDzwSw5W",
  },
  eu: {
    id: "eu",
    name: "EU",
    cloud: "https://eu.posthog.com",
    gateway: "https://gateway.eu.posthog.com",
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
const api = (r) => `${r.gateway}/${PRODUCT}/v1`
const usageUrl = (r) => `${r.gateway}/v1/usage/${PRODUCT}`
const modelsUrl = (r) => `${r.gateway}/${PRODUCT}/v1/models`

// ---- the plan's models -------------------------------------------------------

// The gateway's own catalogue, as a fallback for a signed-out account or a list
// the gateway won't give: [id, context, vision, reasoning levels, prompt,
// completion, cache read, cache write], prices per token.
const FALLBACK = [
  ["claude-haiku-4-5", 200000, true, "0.000001", "0.000005", "0.0000001", "0.00000125"],
  ["claude-sonnet-4-5", 200000, true, "0.000003", "0.000015", "0.0000003", "0.00000375"],
  ["claude-sonnet-4-6", 1000000, true, "0.000003", "0.000015", "0.0000003", "0.00000375"],
  ["claude-sonnet-5", 1000000, true, "0.000002", "0.00001", "0.0000002", "0.0000025"],
  ["claude-sonnet-5-5", 1000000, true, "0.000002", "0.00001", "0.0000002", "0.0000025"],
  ["claude-opus-4-5", 200000, true, "0.000005", "0.000025", "0.0000005", "0.00000625"],
  ["claude-opus-4-6", 1000000, true, "0.000005", "0.000025", "0.0000005", "0.00000625"],
  ["claude-opus-4-7", 1000000, true, "0.000005", "0.000025", "0.0000005", "0.00000625"],
  ["claude-opus-4-8", 1000000, true, "0.000005", "0.000025", "0.0000005", "0.00000625"],
  ["claude-opus-5", 1000000, true, "0.000005", "0.000025", "0.0000005", "0.00000625"],
  ["claude-opus-5-5", 1000000, true, "0.000004", "0.00002", "0.0000004", "0.000005"],
  ["claude-fable-5", 1000000, true, "0.00001", "0.00005", "0.000001", "0.0000125"],
  ["claude-fable-5-1", 1000000, true, "0.00001", "0.00005", "0.000001", "0.0000125"],
  ["gpt-5-mini", 272000, true, "0.00000025", "0.000002", "0.000000025", "0.00000025"],
  ["gpt-5.2", 272000, true, "0.00000175", "0.000014", "0.000000175", "0.00000175"],
  ["gpt-5.3-codex", 272000, true, "0.00000175", "0.000014", "0.000000175", "0.00000175"],
  ["gpt-5.4", 1050000, true, "0.0000025", "0.000015", "0.00000025", "0.0000025"],
  ["gpt-5.5", 1050000, true, "0.000005", "0.00003", "0.0000005", "0.000005"],
  ["gpt-5.6-luna", 922000, true, "0.0000002", "0.0000012", "0.00000002", "0.0000002"],
  ["gpt-5.6-sol", 922000, true, "0.000004", "0.00002", "0.0000004", "0.000004"],
  ["gpt-5.6-terra", 922000, true, "0.000002", "0.000012", "0.0000002", "0.000002"],
  ["gpt-6-astra", 922000, true, "0.00001", "0.00005", "0.000001", "0.0000125"],
  ["gpt-6-luna", 922000, true, "0.0000001", "0.0000005", "0.00000001", "0.0000001"],
  ["gpt-6-sol", 922000, true, "0.000002", "0.00001", "0.0000002", "0.0000025"],
  ["gpt-6.1-sol", 922000, true, "0.000002", "0.00001", "0.0000002", "0.0000025"],
  ["@cf/zai-org/glm-5.2", 128000, false, "0.0000014", "0.0000044", "0.00000014", "0.0000014"],
  ["zai-org/glm-5.3", 1048576, false, "0.0000014", "0.0000044", "0.00000014", "0.0000014"],
  ["zai-org/glm-5.3-flash", 1000000, false, "0.00000015", "0.0000005", "0.000000015", "0.00000015"],
  ["moonshotai/kimi-k3", 262144, false, "0.000003", "0.000015", "0.0000003", "0.000003"],
  ["deepseek-ai/deepseek-v4-flash-0731", 1048000, false, "0.00000013", "0.00000026", "0.000000013", "0.00000013"],
]

// What the plan serves without a paid subscription (the gateway's
// posthog_code_free_tier_models); every other model answers 403
// paid_plan_required until the org has a plan.
const FREE_TIER = new Set([
  "@cf/zai-org/glm-5.2",
  "deepseek-ai/deepseek-v4-flash-0731",
  "moonshotai/kimi-k3",
  "zai-org/glm-5.3-flash",
])
const FREE_TIER_LIST = [...FREE_TIER].join(", ")

// What PostHog's own picker calls each model (its model catalog, resolved to a
// label); the gateway's display_name is the raw id, which reads badly beside
// the FREE badge and the plan's other rows.
const NAMES = {
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-fable-5": "Claude Fable 5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "@cf/zai-org/glm-5.2": "GLM-5.2",
  "zai-org/glm-5.3": "GLM-5.3",
  "zai-org/glm-5.3-flash": "GLM-5.3 Flash",
  "moonshotai/kimi-k3": "Kimi K3",
  "deepseek-ai/deepseek-v4-flash-0731": "DeepSeek V4 Flash 0731",
}

// nameOf is the plan's own name for a model, the gateway's when it has a better
// one than the id, the id otherwise.
const nameOf = (id, given) => NAMES[id] ?? (given && given !== id ? given : id)

// ---- reasoning levels --------------------------------------------------------

// The gateway's model list carries no reasoning levels at all (its
// supported_reasoning_levels is empty for every model it serves), so the depths
// come from PostHog's own model catalog — the same data its Desktop picker draws
// its effort dropdown from. The ladders are its, verbatim:
const STANDARD = ["low", "medium", "high"]
const THROUGH_MAX = [...STANDARD, "xhigh", "max"]
const EXTENDED = [...THROUGH_MAX, "ultracode"]
// GLM exposes two thinking depths rather than the whole ladder.
const GLM = ["high", "max"]

// What each of the gateway's models takes, by id.
const EFFORTS = {
  "@cf/zai-org/glm-5.2": GLM,
  "zai-org/glm-5.3": GLM,
  "zai-org/glm-5.3-flash": GLM,
  "moonshotai/kimi-k3": [],
  "deepseek-ai/deepseek-v4-flash-0731": [],
  "claude-opus-4-5": STANDARD,
  "claude-opus-4-6": THROUGH_MAX,
  "claude-opus-4-7": EXTENDED,
  "claude-opus-4-8": EXTENDED,
  "claude-opus-5": EXTENDED,
  "claude-opus-5-5": EXTENDED,
  "claude-fable-5": EXTENDED,
  "claude-fable-5-1": EXTENDED,
  "claude-sonnet-5-5": EXTENDED,
  "claude-sonnet-5": EXTENDED,
  "claude-sonnet-4-6": STANDARD,
  "gpt-5": STANDARD,
  "gpt-5.5": [...STANDARD, "xhigh"],
  "gpt-5.6-sol": THROUGH_MAX,
  "gpt-5.6-terra": THROUGH_MAX,
  "gpt-5.6-luna": THROUGH_MAX,
  "gpt-6-astra": THROUGH_MAX,
  "gpt-6-sol": THROUGH_MAX,
  "gpt-6.1-sol": THROUGH_MAX,
  "gpt-6-luna": THROUGH_MAX,
}

// A whole family's depths, for a variant the gateway lists and the catalog
// doesn't (gpt-5.4, gpt-5.3-codex): the longest matching prefix wins.
const FAMILY_EFFORTS = [
  ["gpt-6-astra", THROUGH_MAX],
  ["gpt-6-sol", THROUGH_MAX],
  ["gpt-6.1-sol", THROUGH_MAX],
  ["gpt-6-luna", THROUGH_MAX],
  ["gpt-5.6", THROUGH_MAX],
  ["gpt-5.5", [...STANDARD, "xhigh"]],
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

// ---- reply limits ------------------------------------------------------------

// The most a reply may hold, where the vendor caps it below the model's window.
// The gateway's model list carries only a context window, and magpie fills an
// absent output from models.dev — whose figure for DeepSeek V4 Flash (384000)
// is above the 262144 its backend takes, so a client told 384000 asks for more
// than the gateway accepts and every request 400s. The rest take their window,
// which is what a client asks for when it is told the window alone.
const OUTPUTS = { "deepseek-ai/deepseek-v4-flash-0731": 262144 }

// outputOf is a model's reply limit as a client is told it: the cap above, its
// window otherwise, never more than the window (which would size a reply past
// the room its prompt left).
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
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: api(region), npm: NPM },
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
    // magpie's own: served at no cost to the plan's credits
    free: FREE_TIER.has(m.id),
    rate: 0,
  }
}

const fallbackModels = (provider, region) =>
  Object.fromEntries(FALLBACK.map(([id, context, vision, prompt, completion, read, write]) => [
    id,
    modelOf(provider, region, {
      id,
      name: nameOf(id),
      context,
      vision,
      levels: levelsOf(id),
      input: price(prompt),
      output: price(completion),
      read: price(read),
      write: price(write),
    }),
  ]))

// own is the list the provider was given, else the one above: the host passes
// the provider the config hook built, and a caller that passes a bare one
// still gets the plan's models.
const own = (provider, region) =>
  provider?.models && Object.keys(provider.models).length ? provider.models : fallbackModels(provider, region)

// A gateway model object (ModelObject) as the plugin's own shape. Its prices
// are strings of dollars per token. The gateway answers with no reasoning
// levels, so the catalog's fill in — and would win over it if it ever did.
function fromGateway(id, m) {
  const said = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.filter(Boolean) : []
  return {
    id,
    name: nameOf(id, m.display_name || m.slug),
    context: Number(m.context_window) || 0,
    vision: m.supports_vision === true,
    levels: said.length ? said : levelsOf(id),
    input: price(m.pricing?.prompt),
    output: price(m.pricing?.completion),
    read: price(m.pricing?.input_cache_read),
    write: price(m.pricing?.input_cache_write),
  }
}

// ---- the sign-in -------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// listen binds one of the registered callback ports for the sign-in, whose
// redirect the authorization server then accepts (CALLBACK_PORTS above). No
// host is given, so the server takes both the ::1 and the 127.0.0.1 a browser
// may resolve localhost to.
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
    // a token scoped to one project names it, so the gateway can be asked for
    // that project's Desktop access rather than the account's current one
    ...(teams.length === 1 ? { project: teams[0] } : {}),
    accountId: who(env, region),
    ...extra,
  }
}

// who is the account's own name for itself, when the token says: PostHog's
// OAuth tokens name scoped organizations and teams, not people, so the region
// is what the row shows until the user names it.
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
  // as the Desktop app asks: the consent picks a project, and the gateway
  // authorizes a request against the project its token names
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

// ---- renewing ----------------------------------------------------------------

// renewing is each refresh under way, by region and the refresh token it
// spends; renewed is what each gave, kept a minute so one that read the old
// refresh token after it was spent takes that rather than spending it again.
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
// (and saved) when it is. A refresh that fails leaves the access token there
// is, for the vendor's answer to tell.
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

// bearerOf is the token a request carries: the stored one, or a pasted `pha_`
// access token (an "api" sign-in).
const bearerOf = (a) => (a?.type === "api" ? a.key ?? "" : a?.access ?? "")

// signedIn is what every read of the gateway starts from: the account with a
// bearer that isn't about to end (refreshed when it was), or null when nothing
// is signed in. getAuth may be the stored account or the host's reader of it.
async function signedIn(client, getAuth) {
  const auth = typeof getAuth === "function" ? await getAuth() : getAuth
  if (!auth || (!auth.access && !auth.key)) return null
  const a = await fresh(client, auth)
  const bearer = bearerOf(a)
  return bearer ? { auth: a, region: regionOf(a), bearer } : null
}

// ---- the allowance -----------------------------------------------------------

// usageOf is the plan's allowance as the gateway reports it: its burst and
// sustained cost limits, each a percent of what it allows, and the AI credits
// the coding plan spends, as dollars.
function usageOf(u) {
  const out = {
    plan: u.is_pro ? "Pro" : "Free",
    windows: [],
    ...(u.billing_period_end ? { until: u.billing_period_end } : {}),
  }
  const limit = (name, w) => {
    if (!w || typeof w !== "object") return
    out.windows.push({
      name,
      used: Math.max(0, Number(w.used_percent) || 0),
      ...(w.reset_at ? { resetsAt: w.reset_at } : {}),
      ...(Number.isFinite(w.resets_in_seconds) ? { resetSecs: Math.max(0, Math.round(w.resets_in_seconds)) } : {}),
    })
  }
  limit("Burst", u.burst)
  limit("Sustained", u.sustained)
  const c = u.ai_credits
  if (c && Number.isFinite(c.limit_usd) && c.limit_usd > 0) {
    const used = Number.isFinite(c.used_usd) ? c.used_usd : 0
    out.windows.push({
      name: "AI credits",
      used: (100 * used) / c.limit_usd,
      display: `$${used.toFixed(2)} / $${c.limit_usd.toFixed(2)}`,
      amount: used,
      limit: c.limit_usd,
      unit: "usd",
    })
  }
  return out
}

// ---- answers -----------------------------------------------------------------

// HINTS say what a gateway refusal the user can act on means, in the words the
// card can carry. Each keeps the sign-in: a refusal is not a lapsed one.
const HINTS = [
  [/credit_bucket_exhausted|out of credits/i, "the plan's credits are used up; add credits or wait for the period to reset"],
  [/code_access_required|desktop access/i, "PostHog Desktop access isn't enabled for this project (it needs a paid plan or an approved org)"],
  [/paid_plan_required|needs a paid PostHog plan/i, "this model needs a paid plan; the free tier serves " + FREE_TIER_LIST],
  [/product_access_denied|OAuth application not authorized/i, "this token wasn't issued to PostHog Desktop's app, so the posthog_code gateway refuses it"],
]

// explained is a refused answer with the hint for it, if any, and the sign-in
// kept: the host marks an account lapsed on an error that says to sign in
// again, and a vendor's refusal is not that.
async function explained(res) {
  const text = await res.text()
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("X-Magpie-Sign-In", "kept")
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
      return new Response(JSON.stringify({ error: { message: `${msg} — ${hint}`, type: "permission_error" } }), {
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
    p.npm ??= NPM
    p.api ??= api(REGIONS.us)
    p.models = { ...fallbackModels({ id: "posthog" }, REGIONS.us), ...(p.models ?? {}) }
  },

  provider: {
    id: "posthog",
    // the plan's own list when the account is signed in and the gateway
    // answers; the list above otherwise
    async models(provider, { auth }) {
      const s = await signedIn(client, auth)
      if (!s) return own(provider, regionOf(auth))
      try {
        const res = await fetch(modelsUrl(s.region), {
          headers: { Authorization: `Bearer ${s.bearer}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return own(provider, s.region)
        const env = await res.json().catch(() => null)
        const list = Array.isArray(env) ? env : env?.data ?? env?.models ?? []
        const ms = list
          .filter((m) => m?.id && m.visibility !== "hidden" && m.supported_in_api !== false)
          .map((m) => fromGateway(m.id, m))
        if (!ms.length) return own(provider, s.region)
        return Object.fromEntries(ms.map((m) => [m.id, modelOf(provider, s.region, m)]))
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
      return {
        baseURL: api(first.region),
        apiKey: "",
        async fetch(input, init) {
          const s = await signedIn(client, getAuth)
          if (!s) throw new Error("PostHog isn't signed in")
          const req = input instanceof Request ? input : null
          const headers = new Headers(init?.headers ?? req?.headers)
          headers.delete("authorization")
          headers.delete("x-api-key")
          headers.set("Authorization", `Bearer ${s.bearer}`)
          headers.set("Accept", headers.get("Accept") ?? "application/json")
          // the project the token is scoped to, so the gateway authorizes the
          // request against it rather than the account's current one
          if (s.auth.project) headers.set("X-PostHog-Project-Id", String(s.auth.project))
          let body = init?.body
          if (body === undefined && req) body = await req.clone().text()
          const res = await fetch(req ? req.url : input, {
            ...init,
            method: init?.method ?? req?.method,
            headers,
            body,
          })
          return res.status >= 400 ? explained(res) : kept(res)
        },
      }
    },

    // the plan's allowance, as the gateway reports it; each read keeps the
    // sign-in, so a vendor's refusal never marks the account lapsed
    async usage(getAuth) {
      const s = await signedIn(client, getAuth)
      if (!s) return { error: "not signed in", signIn: "kept" }
      try {
        const res = await fetch(usageUrl(s.region), {
          headers: { Authorization: `Bearer ${s.bearer}`, Accept: "application/json" },
          signal: AbortSignal.timeout(20000),
        })
        if (res.status === 401) return { error: "PostHog turned this sign-in away; sign in again", signIn: "expired" }
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
  REGIONS,
  SCOPES,
  FREE_TIER,
  api,
  usageUrl,
  modelsUrl,
  redirectFor,
  CALLBACK_PORTS,
  saved,
  who,
  fromGateway,
  levelsOf,
  outputOf,
  modelOf,
  fallbackModels,
  usageOf,
  merged,
  stale,
  refreshed,
  bearerOf,
  signedIn,
  explained,
  HINTS,
  renewing,
  renewed,
}
