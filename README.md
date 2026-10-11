# magpie-plugins

Provider plugins for [magpie](https://github.com/yetone/magpie) (and OpenCode):
sign in to a subscription or a coding plan, and chat with its models through
magpie's gateway.

One repository, one install: magpie collects every plugin a package's entry
module exports, so `plugin add` here adds all of them.

```
magpie plugin add github:Alexiss02/magpie-plugins
```

Installed from the repository, magpie keeps it current by itself — it compares
the installed commit with the repository's branch about once an hour and installs
the newest, the same way it keeps itself up to date. `magpie plugin update` asks
for it now.

## Plugins

| Plugin | Provider id | What it serves |
|---|---|---|
| [posthog](plugins/posthog) | `posthog` | PostHog Desktop's coding plan (PostHog Code) through PostHog's LLM gateway |

```
magpie plugin login posthog
```

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
