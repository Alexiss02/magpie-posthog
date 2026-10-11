// Bumps package.json's version: the number magpie shows on the plugin's row,
// which every change pushed must move.
//
//   node bump.mjs           0.1.0 → 0.1.1  (a fix)
//   node bump.mjs minor     0.1.0 → 0.2.0  (a new plugin)
//   node bump.mjs 0.3.0     an explicit version
import { readFileSync, writeFileSync } from "node:fs"

const path = new URL("./package.json", import.meta.url)
const pkg = JSON.parse(readFileSync(path, "utf8"))
const was = pkg.version

const [major, minor, patch] = was.split(".").map(Number)
const how = (process.argv[2] || "patch").trim()
const next = /^\d+\.\d+\.\d+$/.test(how)
  ? how
  : how === "major"
    ? `${major + 1}.0.0`
    : how === "minor"
      ? `${major}.${minor + 1}.0`
      : how === "patch"
        ? `${major}.${minor}.${patch + 1}`
        : null

if (!next) {
  console.error(`usage: node bump.mjs [patch|minor|major|<x.y.z>]  (not ${JSON.stringify(how)})`)
  process.exit(1)
}

// the file's own formatting is kept: only the version line is replaced
const text = readFileSync(path, "utf8")
writeFileSync(path, text.replace(`"version": "${was}"`, `"version": "${next}"`))
console.log(`${was} → ${next}`)
