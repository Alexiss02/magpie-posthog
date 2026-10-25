// Self-check for the PostHog plugin's pure parts and its hooks, against a fake
// client and a fake gateway (for the models/usage hooks), and — with --live —
// the real cloud and AI gateway.
//   node test-posthog.mjs            hooks only, no network
//   node test-posthog.mjs --live     also signs in and talks to PostHog
import assert from "node:assert/strict"
import { PostHogAuthPlugin, _internal as I } from "./index.mjs"

const client = { auth: { set: async () => {} } }
const hooks = await PostHogAuthPlugin({ client })

// ---- config ------------------------------------------------------------------
const config = {}
await hooks.config(config)
assert.equal(config.provider.posthog.name, "PostHog")
assert.equal(config.provider.posthog.npm, "@ai-sdk/openai-compatible")
assert.equal(config.provider.posthog.api, "https://ai-gateway.us.posthog.com/v1")
// the gateway's catalogue, minus the models Desktop's own app blocks
assert.equal(Object.keys(config.provider.posthog.models).length, 25)
assert.equal(config.provider.posthog.models["claude-sonnet-5"].limit.context, 1000000)
assert.equal(config.provider.posthog.models["claude-sonnet-5"].api.npm, "@ai-sdk/anthropic")
assert.equal(config.provider.posthog.models["zai-org/glm-5.2"].api.npm, "@ai-sdk/openai-compatible")
// the four the gateway serves without a paid plan, and no others
assert.equal(config.provider.posthog.models["zai-org/glm-5.2"].name, "GLM-5.2")
assert.equal(config.provider.posthog.models["zai-org/glm-5.2"].free, true)
assert.equal(config.provider.posthog.models["deepseek-ai/deepseek-v4-flash-0731"].free, true)
assert.equal(config.provider.posthog.models["moonshotai/kimi-k3"].free, true)
assert.equal(config.provider.posthog.models["zai-org/glm-5.3-flash"].free, true)
assert.equal(config.provider.posthog.models["claude-opus-5"].free, false)
assert.equal(config.provider.posthog.models["gpt-5.5"].free, false)
// the models PostHog's own app blocks never list
assert.equal(config.provider.posthog.models["gpt-5-mini"], undefined)
assert.equal(config.provider.posthog.models["gpt-5.2"], undefined)
assert.equal(config.provider.posthog.models["claude-opus-4-6"], undefined)
assert.equal(config.provider.posthog.models["claude-haiku-4-5"], undefined)

// ---- the endpoints ------------------------------------------------------------
assert.equal(I.redirectFor(51234), "http://localhost:51234/callback")
// the posthog_code app registers only http://localhost:{8237,8239}/callback, and
// PostHog port-relaxes a redirect only when the app registers the portless form
assert.deepEqual(I.CALLBACK_PORTS, [8237, 8239])
assert.equal(I.api(I.REGIONS.eu), "https://ai-gateway.eu.posthog.com/v1")
assert.equal(I.modelsUrl(I.REGIONS.us), "https://ai-gateway.us.posthog.com/v1/models")
assert.equal(
  I.mintUrl(I.REGIONS.us, 608221),
  "https://us.posthog.com/api/projects/608221/desktop/gateway_token/",
)
assert.equal(I.usageUrl(I.REGIONS.eu, "@current"), "https://eu.posthog.com/api/projects/@current/desktop/usage/")
assert.equal(I.SCOPES.includes("llm_gateway:read"), true)
// no billing:read: the desktop usage endpoint carries the plan's dollars
assert.equal(I.SCOPES.includes("billing:read"), false)

// ---- a token response as the account keeps it --------------------------------
const env = {
  access_token: "pha_x",
  refresh_token: "phr_y",
  expires_in: 3600,
  scoped_organizations: [1],
  scoped_teams: [12345],
}
const s = I.saved(I.REGIONS.us, env)
assert.equal(s.type, "success")
assert.equal(s.access, "pha_x")
assert.equal(s.refresh, "phr_y")
assert.equal(s.region, "us")
assert.equal(s.project, 12345) // one scoped project is the one the mint names
assert.ok(s.expires > Date.now())
assert.match(s.accountId, /PostHog US/)
// two projects name none, so the mint asks for the account's current one
assert.equal(I.saved(I.REGIONS.us, { ...env, scoped_teams: [1, 2] }).project, undefined)
assert.equal(I.projectOf(I.saved(I.REGIONS.us, { ...env, scoped_teams: [1, 2] })), "@current")

// ---- the mint's answer as the plugin holds it ---------------------------------
const gw = I.gatewayToken(I.REGIONS.us, {
  token: "phe_t",
  expires_at: new Date(Date.now() + 300e3).toISOString(),
  gateway_url: "https://ai-gateway.us.posthog.com",
  plan: "free",
  allowed_models: ["zai-org/glm-5.2", "moonshotai/kimi-k3"],
  product_models: ["zai-org/glm-5.2", "claude-sonnet-5"],
})
assert.equal(gw.token, "phe_t")
assert.equal(gw.gateway, "https://ai-gateway.us.posthog.com")
assert.equal(gw.plan, "free")
assert.deepEqual(gw.allowed, ["zai-org/glm-5.2", "moonshotai/kimi-k3"])
assert.deepEqual(gw.product, ["zai-org/glm-5.2", "claude-sonnet-5"])
assert.ok(gw.expiresAt > Date.now())
// a mint that names no product list keeps the plan's own
assert.deepEqual(I.gatewayToken(I.REGIONS.us, { token: "phe_t", expires_at: "x" }).product, I.PRODUCT_MODELS)
assert.equal(I.gatewayToken(I.REGIONS.us, { token: "phe_t" }).plan, "free")

// ---- a gateway model as a plugin model ---------------------------------------
// the Go gateway's shape: api_shapes say which API it answers, and its prices
// are strings of dollars per token
const m = I.modelOf({ id: "posthog" }, I.REGIONS.eu, I.fromGateway("zai-org/glm-5.2", {
  id: "zai-org/glm-5.2",
  name: "GLM-5.2",
  context_window: 262144,
  api_shapes: ["openai-chat-completions", "openai-responses", "anthropic-messages"],
  pricing: { prompt: "0.0000014", completion: "0.0000044", cache_read: "0.00000026" },
}))
assert.equal(m.name, "GLM-5.2")
assert.equal(m.api.url, "https://ai-gateway.eu.posthog.com/v1")
assert.equal(m.api.npm, "@ai-sdk/openai-compatible") // chat completions, as the shape list leads
assert.equal(m.limit.context, 262144)
assert.equal(m.cost.input, 0.0000014)
assert.equal(m.cost.cache.read, 0.00000026)
assert.equal(m.cost.cache.write, 0)
assert.deepEqual(Object.keys(m.variants), ["high", "max"])
assert.equal(m.capabilities.attachment, false) // GLM takes no images
assert.equal(m.capabilities.reasoning, true)
// Claude is served on the Messages API only, so magpie is told to speak that
const claude = I.fromGateway("claude-opus-5", { context_window: 1000000, api_shapes: ["anthropic-messages"] })
assert.equal(claude.npm, "@ai-sdk/anthropic")
assert.equal(I.modelOf({ id: "posthog" }, I.REGIONS.us, claude).capabilities.attachment, true)
// a shape magpie can't speak is not offered
assert.equal(I.fromGateway("gemini-3.5-flash", { api_shapes: ["gemini-generate-content"] }).npm, null)
// no shapes at all: the family's, the Messages API for Claude
assert.equal(I.npmOf("claude-sonnet-5", []), "@ai-sdk/anthropic")
assert.equal(I.npmOf("zai-org/glm-5.2", []), "@ai-sdk/openai-compatible")

// ---- the reasoning depths, which the gateway's list never carries --------------
// every one of its models answers supported_reasoning_levels: [], so the
// catalog's are what a model gets — and only the depths the gateway accepts
// (ultracode is Desktop's own rung and a 400 here, so it is on no ladder; `max`
// is on no GPT model's, which the gateway answers "does not support 'max'")
assert.equal(I.levelsOf("claude-opus-5").join(","), "low,medium,high,xhigh,max")
assert.equal(I.levelsOf("claude-opus-4-5").join(","), "low,medium,high")
// Sonnet 4.6 takes max but not xhigh
assert.equal(I.levelsOf("claude-sonnet-4-6").join(","), "low,medium,high,max")
assert.equal(I.levelsOf("gpt-5").join(","), "minimal,low,medium,high")
assert.equal(I.levelsOf("gpt-5.5").join(","), "low,medium,high,xhigh")
assert.equal(I.levelsOf("gpt-5.6-sol").join(","), "low,medium,high,xhigh")
assert.equal(I.levelsOf("gpt-6.1-sol").join(","), "low,medium,high,xhigh")
// GLM takes two depths, not the ladder
assert.deepEqual(I.levelsOf("zai-org/glm-5.3-flash"), ["high", "max"])
assert.deepEqual(I.levelsOf("zai-org/glm-5.2"), ["high", "max"])
// Kimi and DeepSeek reason, but expose no depth to pick
assert.deepEqual(I.levelsOf("moonshotai/kimi-k3"), [])
assert.deepEqual(I.levelsOf("deepseek-ai/deepseek-v4-flash-0731"), [])
// a variant the catalog doesn't name: its family's, else every Codex model's
assert.equal(I.levelsOf("gpt-5.4").join(","), "low,medium,high,xhigh")
assert.equal(I.levelsOf("gpt-5.3-codex").join(","), "low,medium,high")
// an unnamed Claude model yields none: PostHog never gave it a depth to pick
assert.deepEqual(I.levelsOf("claude-unnamed-9"), [])

// ---- the reply limit ----------------------------------------------------------
// the window is what a prompt and its reply share; Kimi's backend rejects a sum
// over it, so its reply is half the window. Everything else takes its window.
assert.equal(I.outputOf("moonshotai/kimi-k3", 1048576), 524288)
assert.equal(I.outputOf("zai-org/glm-5.2", 262144), 262144)
assert.equal(I.outputOf("zai-org/glm-5.3-flash", 1000000), 1000000)
assert.equal(I.outputOf("deepseek-ai/deepseek-v4-flash-0731", 1048000), 1048000)
// never more than the window: a reply cannot outgrow the room its prompt left
assert.equal(I.outputOf("moonshotai/kimi-k3", 262144), 262144)
assert.equal(I.outputOf("unknown-model", 500000), 500000)
assert.equal(I.outputOf("unknown-model", 0), 0)
assert.equal(I.modelOf({ id: "posthog" }, I.REGIONS.us, I.fromGateway("moonshotai/kimi-k3", { context_window: 1048576 })).limit.output, 524288)

// ---- the parameters the GPT models refuse -------------------------------------
// the gateway serves them on OpenAI's terms: max_tokens and a sampling value
// are a 400 naming the parameter, so the body is mended and asked again
const why = (param, message, code = "unsupported_parameter") =>
  JSON.stringify({ error: { message, type: "invalid_request_error", param, code } })
const mended = (body, refusal) => {
  const out = I.repair(JSON.stringify(body), refusal)
  return out === null ? null : JSON.parse(out)
}
// max_tokens becomes the field those models take, at the same value
assert.deepEqual(mended({ model: "gpt-5", max_tokens: 64, messages: [] }, why("max_tokens", "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")), {
  model: "gpt-5",
  max_completion_tokens: 64,
  messages: [],
})
// a cap already there is not overwritten
assert.deepEqual(mended({ max_tokens: 8, max_completion_tokens: 64 }, why("max_tokens", "x")), { max_completion_tokens: 64 })
// a temperature keeps the one value the model does take, as the message names it
assert.deepEqual(
  mended({ temperature: 0.7, messages: [] }, why("temperature", "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.", "unsupported_value")),
  { temperature: 1, messages: [] },
)
// a parameter with no stand-in comes out
for (const p of ["top_p", "presence_penalty", "frequency_penalty", "stop", "logprobs", "top_logprobs", "parallel_tool_calls"]) {
  assert.deepEqual(mended({ [p]: 1, model: "gpt-5" }, why(p, `Unsupported parameter: '${p}' is not supported with this model.`)), { model: "gpt-5" }, p)
}
// a refusal the plugin can't mend is left alone: a real error is shown, not retried
assert.equal(mended({ model: "gpt-5" }, why("", "You are not allowed to request logprobs from this model", null)), null)
assert.equal(mended({ model: "gpt-5" }, why("model", "The requested model does not exist")), null)
// an effort is the caller's choice, not silently changed to another depth
assert.equal(mended({ reasoning_effort: "max" }, why("reasoning_effort", "Unsupported value: 'reasoning_effort' does not support 'max' with this model.", "unsupported_value")), null)
// a body that isn't JSON, or isn't text, is not a body to mend
assert.equal(I.repair(undefined, why("max_tokens", "x")), null)
assert.equal(I.repair("not json", why("max_tokens", "x")), null)
assert.equal(I.repair("{}", "not json"), null)
assert.ok(I.REPAIRS >= 2)

// ---- the allowance ------------------------------------------------------------
// a plan that pays: the dollar bucket first, then the two valves
const u = I.usageOf({
  product: "posthog_code",
  burst: { used_percent: 12.5, resets_in_seconds: 86400, reset_at: "2026-10-26T00:00:00Z", exceeded: false },
  sustained: { used_percent: 3, resets_in_seconds: 2592000, reset_at: "2026-11-24T00:00:00Z", exceeded: false },
  ai_credits: { exhausted: false, used_usd: 0.48, limit_usd: 20, breakdown: { token_credits: 48 } },
  is_rate_limited: false,
  is_pro: false,
  code_usage_subscribed: true,
  billing_period_end: "2026-11-13T05:58:42.090000Z",
})
assert.equal(u.plan, "Desktop")
assert.deepEqual(u.windows.map((w) => w.name), ["Credits", "Burst", "Sustained"])
assert.equal(u.windows[0].display, "$0.48 / $20.00")
assert.equal(u.windows[0].amount, 0.48)
assert.equal(u.windows[0].limit, 20)
assert.equal(u.windows[0].unit, "usd")
assert.equal(u.windows[0].used, 2.4)
assert.equal(u.windows[0].resetsAt, "2026-11-13T05:58:42.090Z")
assert.equal(u.windows[1].used, 12.5)
assert.equal(u.windows[1].resetSecs, 86400)
assert.equal(u.until, "2026-11-13T05:58:42.090Z")

// a free plan (code usage not subscribed) shows its sustained valve and no
// dollars, as Desktop's own codeUsageMeter does; burst is meaningless there
const free = I.usageOf({
  burst: { used_percent: 40, resets_in_seconds: 86400, reset_at: "2026-10-26T00:00:00Z", exceeded: false },
  sustained: { used_percent: 1, resets_in_seconds: 2592000, reset_at: "2026-11-24T00:00:00Z", exceeded: false },
  ai_credits: { exhausted: false, used_usd: null, limit_usd: null, breakdown: null },
  is_pro: false,
  code_usage_subscribed: false,
  billing_period_end: "2026-11-13T05:58:42.090000Z",
})
assert.equal(free.plan, "Free")
assert.deepEqual(free.windows.map((w) => w.name), ["Sustained"])
assert.equal(free.windows[0].used, 1)

// an absent code_usage_subscribed is unknown, not free: both valves stay
const unknown = I.usageOf({ burst: { used_percent: 1 }, sustained: { used_percent: 2 } })
assert.deepEqual(unknown.windows.map((w) => w.name), ["Burst", "Sustained"])
// and a usage read with nothing in it is a plan with no windows
assert.deepEqual(I.usageOf({}).windows, [])
assert.deepEqual(I.usageOf(undefined).windows, [])

// ---- a refusal keeps the sign-in and says what it means ----------------------
const refused = await I.explained(
  new Response(
    JSON.stringify({
      error: { message: "model not allowed for this credential", type: "permission_error", code: "model_not_allowed" },
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  ),
)
assert.equal(refused.status, 403)
assert.equal(refused.headers.get("X-Magpie-Sign-In"), "kept")
const said = await refused.json()
assert.match(said.error.message, /model not allowed/)
assert.match(said.error.message, /needs a paid plan/) // the hint, not just the vendor's words
assert.match(said.error.message, /glm-5\.2/) // and it names what the free tier does serve
// a retired product says so rather than leaving the user to guess
const retired = await I.explained(
  new Response(JSON.stringify({ error: { message: "PostHog Code no longer runs on this gateway.", reason: "product_retired" } }), {
    status: 403,
    headers: { "content-type": "application/json" },
  }),
)
assert.match((await retired.json()).error.message, /update the plugin/)
// the gateway refusing the credential itself is the one thing that marks it
const unauth = await I.explained(new Response('{"error":{"message":"authentication failed"}}', { status: 401 }))
assert.equal(unauth.headers.get("X-Magpie-Sign-In"), "expired")
// anything else is carried through as it came
const other = await I.explained(new Response("boom", { status: 500 }))
assert.equal(await other.text(), "boom")
assert.equal(other.headers.get("X-Magpie-Sign-In"), "kept")

// ---- a stored sign-in is renewed only when it is about to end -----------------
assert.equal(I.stale({ expires: Date.now() + 3600e3 }), false)
assert.equal(I.stale({ expires: Date.now() + 1000 }), true)
assert.equal(I.stale({}), false)
assert.equal(I.bearerOf({ type: "api", key: "pha_z" }), "pha_z")
assert.equal(I.bearerOf({ type: "oauth", access: "pha_a", refresh: "phr_b" }), "pha_a")

// ---- signedIn: the account behind every read ---------------------------------
assert.equal(await I.signedIn(client, async () => undefined), null)
assert.equal(await I.signedIn(client, undefined), null)
assert.equal(await I.signedIn(client, { region: "us" }), null)
const held = { type: "api", key: "pha_z", region: "us" }
const one = await I.signedIn(client, async () => held)
assert.equal(one.bearer, "pha_z")
assert.equal(one.region.id, "us")
assert.equal(one.region.gateway, "https://ai-gateway.us.posthog.com")
assert.equal((await I.signedIn(client, held)).bearer, "pha_z")
assert.equal(await I.signedIn(client, async () => ({ type: "oauth", refresh: "phr_b" })), null)

// ---- the hooks, without a sign-in --------------------------------------------
const models = await hooks.provider.models({ id: "posthog" }, { auth: undefined })
assert.equal(Object.keys(models).length, 25)
const anon = await hooks.auth.usage(async () => undefined)
assert.equal(anon.error, "not signed in")
assert.equal(hooks.auth.loader(async () => undefined) instanceof Promise, true)
assert.equal(await hooks.auth.loader(async () => undefined).then((o) => o.baseURL), undefined)

// ---- the hooks, with a sign-in, against a fake cloud and gateway --------------
const realFetch = globalThis.fetch
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const gatewayModels = [
  {
    id: "zai-org/glm-5.2",
    name: "GLM-5.2",
    context_window: 262144,
    canonical: "posthog/zai-org/glm-5.2",
    api_shapes: ["openai-chat-completions", "anthropic-messages"],
    pricing: { prompt: "0.0000014", completion: "0.0000044", cache_read: "0.00000026" },
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    context_window: 1000000,
    canonical: "anthropic/claude-opus-5",
    api_shapes: ["anthropic-messages"],
    pricing: { prompt: "0.000005", completion: "0.000025" },
  },
  {
    // served by the gateway for another product, and outside the desktop pin
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    context_window: 1048576,
    canonical: "google/gemini-3.5-flash",
    api_shapes: ["gemini-generate-content"],
  },
]
const signed = { type: "oauth", access: "pha_z", refresh: "phr_y", expires: Date.now() + 3600e3, region: "us", project: 608221 }
let sent = []
let mintedAt = 0
try {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.endsWith("/desktop/gateway_token/")) {
      mintedAt += 1
      assert.equal(u, "https://us.posthog.com/api/projects/608221/desktop/gateway_token/")
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer pha_z")
      return json(
        {
          enabled: true,
          token: "phe_" + mintedAt,
          expires_at: new Date(Date.now() + 300e3).toISOString(),
          gateway_url: "https://ai-gateway.us.posthog.com",
          plan: "free",
          allowed_models: ["zai-org/glm-5.2"],
          product_models: ["zai-org/glm-5.2", "claude-opus-5"],
        },
        201,
      )
    }
    if (u.endsWith("/v1/models")) return json({ object: "list", data: gatewayModels, models: gatewayModels })
    if (u.endsWith("/desktop/usage/")) {
      return json({
        product: "posthog_code",
        burst: { used_percent: 0, resets_in_seconds: 86400, reset_at: "2026-10-26T00:00:00Z", exceeded: false },
        sustained: { used_percent: 1, resets_in_seconds: 2592000, reset_at: "2026-11-24T00:00:00Z", exceeded: false },
        ai_credits: { exhausted: false, used_usd: null, limit_usd: null, breakdown: null },
        is_rate_limited: false,
        is_pro: false,
        code_usage_subscribed: false,
        billing_period_end: "2026-11-13T05:58:42.090000Z",
      })
    }
    if (u.endsWith("/v1/chat/completions")) {
      sent.push({ url: u, headers: init.headers, body: init.body })
      if (new Headers(init.headers).get("authorization") !== "Bearer phe_1") {
        return json({ error: { message: "authentication failed", type: "authentication_error" } }, 401)
      }
      return json({ choices: [{ message: { content: "hi" } }] })
    }
    throw new Error("unexpected fetch: " + u)
  }

  // the list is the product's pin, and the credential's pin marks what it may call
  const live = await hooks.provider.models({ id: "posthog" }, { auth: signed })
  assert.deepEqual(Object.keys(live).sort(), ["claude-opus-5", "zai-org/glm-5.2"])
  assert.equal(live["zai-org/glm-5.2"].free, true)
  assert.equal(live["claude-opus-5"].free, false)
  assert.equal(live["zai-org/glm-5.2"].api.npm, "@ai-sdk/openai-compatible")
  assert.equal(live["claude-opus-5"].api.npm, "@ai-sdk/anthropic")
  assert.equal(mintedAt, 1) // the mint is held, not asked again for the list

  // usage reads the cloud's own endpoint
  const usage = await hooks.auth.usage(async () => signed)
  assert.equal(usage.plan, "Free")
  assert.deepEqual(usage.windows.map((w) => w.name), ["Sustained"])
  assert.equal(usage.windows[0].used, 1)

  // a request goes through the minted token, whatever the account's bearer is
  const loader = await hooks.auth.loader(async () => signed)
  assert.equal(loader.baseURL, "https://ai-gateway.us.posthog.com/v1")
  const res = await loader.fetch("https://ai-gateway.us.posthog.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer placeholder", "content-type": "application/json" },
    body: JSON.stringify({ model: "zai-org/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).choices[0].message.content, "hi")
  assert.equal(sent.length, 1)
  assert.equal(new Headers(sent[0].headers).get("authorization"), "Bearer phe_1")
  assert.equal(new Headers(sent[0].headers).get("x-api-key"), "phe_1")
  assert.equal(sent[0].url, "https://ai-gateway.us.posthog.com/v1/chat/completions")

  // a 401 from the gateway mints once more and retries the request. The mint is
  // throttled per account (120 an hour), so the window is aged here rather than
  // waited out.
  let rejectOnce = true
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.endsWith("/v1/chat/completions")) {
      sent.push({ url: u, headers: init.headers, body: init.body })
      if (rejectOnce) {
        rejectOnce = false
        return json({ error: { message: "authentication failed", type: "authentication_error" } }, 401)
      }
      return json({ choices: [{ message: { content: "hi" } }] })
    }
    if (u.endsWith("/desktop/gateway_token/")) {
      mintedAt += 1
      return json(
        {
          token: "phe_" + mintedAt,
          expires_at: new Date(Date.now() + 300e3).toISOString(),
          gateway_url: "https://ai-gateway.us.posthog.com",
          plan: "free",
          allowed_models: ["zai-org/glm-5.2"],
          product_models: ["zai-org/glm-5.2", "claude-opus-5"],
        },
        201,
      )
    }
    throw new Error("unexpected fetch: " + u)
  }
  for (const entry of I.minted.values()) entry.mintedAt = Date.now() - 60_000
  const retried = await loader.fetch("https://ai-gateway.us.posthog.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "zai-org/glm-5.2" }),
  })
  assert.equal(retried.status, 200)
  assert.equal(mintedAt, 2)
  assert.equal(new Headers(sent.at(-1).headers).get("authorization"), "Bearer phe_2")

  // a second 401 inside the mint throttle's window is an error to retry, not a
  // mint loop
  rejectOnce = true
  await assert.rejects(
    loader.fetch("https://ai-gateway.us.posthog.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "zai-org/glm-5.2" }),
    }),
    /retry in a few seconds/,
  )

  // a mint that says no is the account's problem, said with what to do
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/desktop/gateway_token/")) {
      return json({ enabled: false, reason: "credit_bucket_exhausted", detail: "Your organization has reached its limit" }, 402)
    }
    throw new Error("unexpected fetch: " + url)
  }
  const fresh = await PostHogAuthPlugin({ client })
  await assert.rejects(fresh.auth.loader(async () => ({ ...signed, access: "pha_other" })), /credits are used up/)
} finally {
  globalThis.fetch = realFetch
  I.minted.clear()
}

// ---- the hooks, live ---------------------------------------------------------
if (process.argv.includes("--live")) {
  const { readFileSync } = await import("node:fs")
  const { homedir } = await import("node:os")
  const { join } = await import("node:path")
  // a sign-in magpie already keeps, when there is one
  let auth = { type: "oauth", access: process.env.POSTHOG_ACCESS ?? "", refresh: "", region: "us", expires: Date.now() + 3600e3 }
  if (!auth.access) {
    try {
      const stored = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8")).posthog
      if (stored?.access) auth = stored
    } catch {}
  }
  if (!auth.access) {
    console.log("live: no PostHog sign-in (set POSTHOG_ACCESS, or sign in with magpie first); skipped")
  } else {
    const live = await hooks.provider.models({ id: "posthog" }, { auth })
    assert.ok(Object.keys(live).length > 0, "the plan's list")
    const glm = live["zai-org/glm-5.2"]
    assert.ok(glm, "GLM-5.2 is in the plan")
    assert.equal(glm.api.url, "https://ai-gateway.us.posthog.com/v1")
    assert.equal(glm.api.npm, "@ai-sdk/openai-compatible")
    if (live["claude-opus-5"]) assert.equal(live["claude-opus-5"].api.npm, "@ai-sdk/anthropic")
    const liveUsage = await hooks.auth.usage(async () => auth)
    assert.equal(liveUsage.signIn, "kept", "a usage read keeps the sign-in")
    console.log(
      "live: the plan lists",
      Object.keys(live).length,
      "models; usage says",
      liveUsage.plan,
      liveUsage.windows.map((w) => `${w.name} ${w.display ?? w.used + "%"}`).join(", "),
    )
    // one real chat through the plugin's own fetch, on a free model that answers
    // text rather than spending the whole budget thinking
    const free = live["zai-org/glm-5.2"] ?? Object.values(live).find((x) => x.free)
    if (free) {
      const loader = await hooks.auth.loader(async () => auth)
      const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: free.id, max_tokens: 64, messages: [{ role: "user", content: "say hi" }] }),
      })
      const said = await res.json()
      assert.equal(res.status, 200, JSON.stringify(said).slice(0, 300))
      const text = said.choices?.[0]?.message?.content ?? said.choices?.[0]?.message?.reasoning_content ?? ""
      assert.ok(String(text).length > 0, "the model answered something")
      console.log("live:", free.id, "answered:", JSON.stringify(String(text).slice(0, 60)))
    }
  }
}

console.log("ok")
