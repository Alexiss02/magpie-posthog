// Self-check for the PostHog plugin's pure parts and its hooks, against a fake
// client and (for the models/usage hooks) the live gateway.
//   node test-posthog.mjs            hooks only, no network
//   node test-posthog.mjs --live     also asks the real gateway's model list
import assert from "node:assert/strict"
import { PostHogAuthPlugin, _internal as I } from "./index.mjs"

const client = { auth: { set: async () => {} } }
const hooks = await PostHogAuthPlugin({ client })

// ---- config ------------------------------------------------------------------
const config = {}
await hooks.config(config)
assert.equal(config.provider.posthog.name, "PostHog")
assert.equal(config.provider.posthog.npm, "@ai-sdk/openai-compatible")
assert.equal(config.provider.posthog.api, "https://gateway.us.posthog.com/posthog_code/v1")
assert.equal(Object.keys(config.provider.posthog.models).length, 30)
assert.equal(config.provider.posthog.models["claude-sonnet-5"].limit.context, 1000000)
// the four the gateway serves without a paid plan, and no others
assert.equal(config.provider.posthog.models["@cf/zai-org/glm-5.2"].name, "GLM-5.2")
assert.equal(config.provider.posthog.models["@cf/zai-org/glm-5.2"].free, true)
assert.equal(config.provider.posthog.models["deepseek-ai/deepseek-v4-flash-0731"].free, true)
assert.equal(config.provider.posthog.models["moonshotai/kimi-k3"].free, true)
assert.equal(config.provider.posthog.models["zai-org/glm-5.3-flash"].free, true)
assert.equal(config.provider.posthog.models["claude-opus-5"].free, false)
assert.equal(config.provider.posthog.models["gpt-5.5"].free, false)

// ---- the redirect the app registered ----------------------------------------
assert.equal(I.redirectFor(51234), "http://localhost:51234/callback")
// the posthog_code app registers only http://localhost:{8237,8239}/callback,
// and PostHog port-relaxes a redirect only when the app registers the portless
// form — so the callback must sit on one of those two or consent fails with
// "Mismatching redirect URI" (observed on an ephemeral-port EU login)
assert.equal(I.redirectFor(8237), "http://localhost:8237/callback")
assert.equal(I.redirectFor(8239), "http://localhost:8239/callback")
assert.deepEqual(I.CALLBACK_PORTS, [8237, 8239])
assert.equal(I.api(I.REGIONS.eu), "https://gateway.eu.posthog.com/posthog_code/v1")
assert.equal(I.usageUrl(I.REGIONS.us), "https://gateway.us.posthog.com/v1/usage/posthog_code")
assert.equal(I.SCOPES.includes("llm_gateway:read"), true)

// ---- a token response as the account keeps it --------------------------------
const env = {
  access_token: "pha_x",
  refresh_token: "phr_y",
  expires_in: 3600,
  scoped_organizations: ["0f1e"],
  scoped_teams: [12345],
}
const s = I.saved(I.REGIONS.us, env)
assert.equal(s.type, "success")
assert.equal(s.access, "pha_x")
assert.equal(s.refresh, "phr_y")
assert.equal(s.region, "us")
assert.equal(s.project, 12345) // one scoped project is the one requests name
assert.ok(s.expires > Date.now())
assert.match(s.accountId, /PostHog US/)
// two projects name none, so no header is sent for them
assert.equal(I.saved(I.REGIONS.us, { ...env, scoped_teams: [1, 2] }).project, undefined)

// ---- a gateway model as a plugin model ---------------------------------------
const m = I.modelOf({ id: "posthog" }, I.REGIONS.eu, I.fromGateway("gpt-5.5", {
  id: "gpt-5.5",
  display_name: "gpt-5.5",
  context_window: 1050000,
  supports_vision: true,
  supported_reasoning_levels: ["low", "high"],
  pricing: { prompt: "0.000005", completion: "0.00003", input_cache_read: "0.0000005" },
}))
assert.equal(m.name, "GPT-5.5") // PostHog's own label, not the raw id
assert.equal(m.limit.context, 1050000)
assert.equal(m.cost.input, 0.000005)
assert.equal(m.cost.cache.read, 0.0000005)
assert.equal(m.api.url, "https://gateway.eu.posthog.com/posthog_code/v1")
assert.deepEqual(Object.keys(m.variants), ["low", "high"])
assert.equal(m.capabilities.attachment, true)

// ---- the reasoning depths, which the gateway's list never carries --------------
// every one of its 30 models answers supported_reasoning_levels: [], so the
// catalog's are what a model gets
assert.equal(I.levelsOf("claude-opus-5").join(","), "low,medium,high,xhigh,max,ultracode")
assert.equal(I.levelsOf("claude-opus-4-5").join(","), "low,medium,high")
assert.equal(I.levelsOf("claude-sonnet-4-6").join(","), "low,medium,high")
assert.equal(I.levelsOf("gpt-5.5").join(","), "low,medium,high,xhigh")
assert.equal(I.levelsOf("gpt-5.6-sol").join(","), "low,medium,high,xhigh,max")
assert.equal(I.levelsOf("gpt-6.1-sol").join(","), "low,medium,high,xhigh,max")
// GLM takes two depths, not the ladder
assert.deepEqual(I.levelsOf("zai-org/glm-5.3-flash"), ["high", "max"])
assert.deepEqual(I.levelsOf("@cf/zai-org/glm-5.2"), ["high", "max"])
// Kimi and DeepSeek reason, but expose no depth to pick
assert.deepEqual(I.levelsOf("moonshotai/kimi-k3"), [])
assert.deepEqual(I.levelsOf("deepseek-ai/deepseek-v4-flash-0731"), [])
// a variant the catalog doesn't name: its family's, else every Codex model's
assert.equal(I.levelsOf("gpt-5.4").join(","), "low,medium,high")
assert.equal(I.levelsOf("gpt-5.3-codex").join(","), "low,medium,high")
// an unnamed Claude model yields none: PostHog never gave it a depth to pick
assert.deepEqual(I.levelsOf("claude-unnamed-9"), [])
// the gateway's own answer wins when it ever carries one
assert.equal(I.fromGateway("claude-opus-5", { supported_reasoning_levels: ["low"] }).levels.join(","), "low")
assert.equal(I.fromGateway("moonshotai/kimi-k3", {}).levels.length, 0)
assert.equal(I.modelOf({ id: "posthog" }, I.REGIONS.us, I.fromGateway("zai-org/glm-5.3-flash", {})).capabilities.reasoning, true)
assert.equal(I.modelOf({ id: "posthog" }, I.REGIONS.us, I.fromGateway("moonshotai/kimi-k3", {})).capabilities.reasoning, false)

// ---- the reply limit, which magpie fills from models.dev when the plugin omits
// it. models.dev lists DeepSeek V4 Flash's output at 384000, above the 262144
// its backend takes, so the plugin names the cap itself; every other model is
// told its window, which is what its backend accepts.
assert.equal(I.outputOf("deepseek-ai/deepseek-v4-flash-0731", 1048000), 262144)
assert.equal(I.outputOf("moonshotai/kimi-k3", 262144), 262144)
assert.equal(I.outputOf("zai-org/glm-5.3-flash", 1000000), 1000000)
// never more than the window: a reply cannot outgrow the room its prompt left
assert.equal(I.outputOf("deepseek-ai/deepseek-v4-flash-0731", 200000), 200000)
assert.equal(I.outputOf("unknown-model", 500000), 500000)
assert.equal(I.outputOf("unknown-model", 0), 0)
// and the shape a client reads carries it
assert.equal(I.modelOf({ id: "posthog" }, I.REGIONS.us, I.fromGateway("deepseek-ai/deepseek-v4-flash-0731", { context_window: 1048000 })).limit.output, 262144)
assert.equal(I.modelOf({ id: "posthog" }, I.REGIONS.us, I.fromGateway("moonshotai/kimi-k3", { context_window: 262144 })).limit.output, 262144)

// ---- the allowance -----------------------------------------------------------
const u = I.usageOf({
  is_pro: true,
  burst: { used_percent: 12.5, resets_in_seconds: 900, reset_at: "2026-10-11T12:00:00Z", exceeded: false },
  sustained: { used_percent: 3, resets_in_seconds: 86400, reset_at: "2026-10-12T00:00:00Z", exceeded: false },
  ai_credits: { exhausted: false, used_usd: 2.5, limit_usd: 10 },
  billing_period_end: "2026-11-01T00:00:00Z",
})
assert.equal(u.plan, "Pro")
assert.deepEqual(u.windows.map((w) => w.name), ["Burst", "Sustained", "AI credits"])
assert.equal(u.windows[0].used, 12.5)
assert.equal(u.windows[0].resetSecs, 900)
assert.equal(u.windows[2].used, 25)
assert.equal(u.windows[2].display, "$2.50 / $10.00")
assert.equal(u.until, "2026-11-01T00:00:00Z")
// no credits window when the plan reports none
assert.deepEqual(I.usageOf({ is_pro: false, ai_credits: { exhausted: false } }).windows, [])
assert.equal(I.usageOf({ is_pro: false }).plan, "Free")
// a free plan (code usage not subscribed) shows only the sustained bucket,
// as Desktop's codeUsageMeter does — burst is dropped
const free = I.usageOf({
  is_pro: false,
  code_usage_subscribed: false,
  burst: { used_percent: 10, resets_in_seconds: 86400, reset_at: "2026-10-12T00:00:00Z", exceeded: false },
  sustained: { used_percent: 3, resets_in_seconds: 2592000, reset_at: "2026-11-10T00:00:00Z", exceeded: false },
})
assert.deepEqual(free.windows.map((w) => w.name), ["Sustained"])
assert.equal(free.windows[0].used, 3)

// ---- a refusal keeps the sign-in and says what it means ----------------------
const refused = await I.explained(new Response(
  JSON.stringify({ error: { message: "Model 'claude-opus-5' needs a paid PostHog plan.", type: "permission_error", code: "product_access_denied" } }),
  { status: 403, headers: { "content-type": "application/json" } },
))
assert.equal(refused.status, 403)
assert.equal(refused.headers.get("X-Magpie-Sign-In"), "kept")
const said = await refused.json()
assert.match(said.error.message, /paid plan/)
assert.match(said.error.message, /needs a paid plan/) // the hint, not just the vendor's words
assert.match(said.error.message, /glm-5\.2/) // and it names what the free tier does serve
const other = await I.explained(new Response("boom", { status: 500 }))
assert.equal(await other.text(), "boom")
assert.equal(other.headers.get("X-Magpie-Sign-In"), "kept")

// ---- a stored sign-in is renewed only when it is about to end -----------------
assert.equal(I.stale({ expires: Date.now() + 3600e3 }), false)
assert.equal(I.stale({ expires: Date.now() + 1000 }), true)
assert.equal(I.stale({}), false)
assert.equal(I.bearerOf({ type: "api", key: "pha_z" }), "pha_z")
assert.equal(I.bearerOf({ type: "oauth", access: "pha_a", refresh: "phr_b" }), "pha_a")

// ---- signedIn: the account behind every gateway read --------------------------
// nothing signed in, either way the host hands the account over
assert.equal(await I.signedIn(client, async () => undefined), null)
assert.equal(await I.signedIn(client, undefined), null)
assert.equal(await I.signedIn(client, { region: "us" }), null)
// an account with an access token, read straight or through the host's reader
const held = { type: "api", key: "pha_z", region: "us" }
const one = await I.signedIn(client, async () => held)
assert.equal(one.bearer, "pha_z")
assert.equal(one.region.id, "us")
assert.equal(one.region.gateway, "https://gateway.us.posthog.com")
assert.equal((await I.signedIn(client, held)).bearer, "pha_z")
// a stored sign-in with no access token at all is not one
assert.equal(await I.signedIn(client, async () => ({ type: "oauth", refresh: "phr_b" })), null)

// ---- the hooks, without a sign-in --------------------------------------------
const models = await hooks.provider.models({ id: "posthog" }, { auth: undefined })
assert.equal(Object.keys(models).length, 30)
const anon = await hooks.auth.usage(async () => undefined)
assert.equal(anon.error, "not signed in")
assert.equal(hooks.auth.loader(async () => undefined) instanceof Promise, true)
assert.equal(await hooks.auth.loader(async () => undefined).then((o) => o.baseURL), undefined)

// ---- the hooks, live ---------------------------------------------------------
if (process.argv.includes("--live")) {
  const auth = { type: "oauth", access: "pha_expired", refresh: "", region: "us", expires: Date.now() + 3600e3 }
  const live = await hooks.provider.models({ id: "posthog" }, { auth })
  assert.equal(Object.keys(live).length, 30, "the gateway's own list")
  assert.ok(live["claude-opus-5"], "claude-opus-5 is in the plan")
  assert.equal(live["claude-opus-5"].name, "Claude Opus 5", "the plan's own name")
  assert.equal(live["zai-org/glm-5.3-flash"].name, "GLM-5.3 Flash")
  assert.equal(live["claude-opus-5"].api.url, "https://gateway.us.posthog.com/posthog_code/v1")
  const liveUsage = await hooks.auth.usage(async () => auth)
  assert.equal(liveUsage.signIn, "expired", "an expired token is what the gateway says")
  assert.equal(I.FREE_TIER.size, 4)
  console.log("live: gateway listed", Object.keys(live).length, "models; usage said", liveUsage.error)
}

console.log("ok")
