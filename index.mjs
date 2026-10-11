// magpie plugins: every plugin this repository ships, re-exported so one
// install of the package hands magpie all of them (magpie collects each
// function a package's entry module exports, and a package's main is the
// root index). Each plugin lives under plugins/<name>/ with its own test.
export { PostHogAuthPlugin } from "./plugins/posthog/index.mjs"
