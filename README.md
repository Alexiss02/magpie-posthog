# magpie-posthog

Provider plugins for [magpie](https://github.com/yetone/magpie) (and OpenCode):
sign in to a subscription or a coding plan, and chat with its models through
magpie's gateway.

One repository, one install: magpie collects every plugin a package's entry
module exports, so `plugin add` here adds all of them.

```
magpie plugin add github:Alexiss02/magpie-posthog
```

The package is `PostHog` (its `package.json` name, which magpie shows on the
plugin's row); the provider it signs in to is `posthog`.

Installed from the repository, magpie keeps it current by itself — it compares
the installed commit with the repository's branch about once an hour and installs
the newest, the same way it keeps itself up to date. `magpie plugin update` asks
for it now.

## Plugins

| Plugin | Provider id | What it serves |
|---|---|---|
| [posthog](plugins/posthog) | `posthog` | PostHog Desktop's coding plan (PostHog Code) through PostHog's AI gateway |

```
magpie plugin login posthog
```

The plugin signs in with PostHog Desktop's own OAuth client and mints a short-lived `phe_` gateway
token per project, which is what PostHog's AI gateway takes — the older
`gateway.{us,eu}.posthog.com/posthog_code` product is retired.

## Layout

| | |
|---|---|
| `index.mjs` | re-exports every plugin, so one install hands magpie all of them |
| `plugins/<name>/index.mjs` | one plugin: its sign-in, its model list, its request path |
| `plugins/<name>/test-*.mjs` | that plugin's self-check, offline; `--live` also asks its vendor |
| `package.json` | the entry point magpie reads, and the `magpie.icon` it shows |

A plugin is one file: that is magpie's own convention for a provider plugin (its
built-in `plug-*.mjs` are single files too).

## Self-check

```
node plugins/posthog/test-posthog.mjs           # offline
node plugins/posthog/test-posthog.mjs --live    # also asks the vendor
```

`npm test` is the first of the two.

## Versions

`package.json`'s `version` is what magpie shows on the plugin's row, so **every
change pushed bumps it** — a fix `0.1.1`, a new plugin `0.2.0`. It stays `0.x`
while the plugins are young: a `1.0.0` would claim a stability these have not
earned. For a plugin installed from git the version is display only; magpie
tracks the commit to decide what is out of date.

```
node bump.mjs            # 0.1.0 → 0.1.1, a fix
node bump.mjs minor      # 0.1.0 → 0.2.0, a new plugin
node bump.mjs 0.3.0      # an explicit version
```

`npm run bump` and `npm run bump:minor` are the first two.
