import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function setupEnv() {
  const root = mkdtempSync(join(tmpdir(), "lacode-ocfg-"))
  process.env.XDG_CONFIG_HOME = root
  return root
}

const baseConfig = `{
  "plugin": [
    ["file:///home/lawaty/Projects/lacode/dist/index.js", { "yolo": false, "ykb": false }]
  ]
}
`

test("globalOpencodeConfigPath prefers opencode.jsonc when it exists, falls back to .json", async () => {
  const root = setupEnv()
  const dir = join(root, "opencode")
  mkdirSync(dir, { recursive: true })
  const mod = await import(`../src/lib/opencode-config.ts?case=1&t=${Date.now()}`)
  // fallback .json
  assert.equal(mod.globalOpencodeConfigPath(), join(dir, "opencode.json"))
  writeFileSync(join(dir, "opencode.jsonc"), baseConfig)
  assert.equal(mod.globalOpencodeConfigPath(), join(dir, "opencode.jsonc"))
  rmSync(root, { recursive: true, force: true })
})

test("comments and trailing commas parse", async () => {
  const root = setupEnv()
  const dir = join(root, "opencode")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "opencode.jsonc")
  writeFileSync(
    path,
    `{
  // a comment
  "plugin": [
    ["file:///home/lawaty/Projects/lacode/dist/index.js", { "yolo": false, }],
  ],
}
`,
  )
  const mod = await import(`../src/lib/opencode-config.ts?case=2&t=${Date.now()}`)
  const cfg = mod.readOpencodeConfig(path)
  assert.ok(Array.isArray(cfg.plugin))
  assert.equal(cfg.plugin.length, 1)
  rmSync(root, { recursive: true, force: true })
})

test("findLacodePlugin matches the file URL and @lawaty/lacode", async () => {
  const mod = await import(`../src/lib/opencode-config.ts?case=3&t=${Date.now()}`)
  const fileUrl = mod.findLacodePlugin({
    plugin: [["file:///home/lawaty/Projects/lacode/dist/index.js", { yolo: false }]],
  })
  assert.ok(fileUrl)
  assert.equal(fileUrl.index, 0)
  assert.equal(fileUrl.name, "file:///home/lawaty/Projects/lacode/dist/index.js")
  const pkg = mod.findLacodePlugin({ plugin: ["@lawaty/lacode"] })
  assert.ok(pkg)
  assert.equal(pkg.name, "@lawaty/lacode")
  assert.equal(pkg.options, undefined)
  rmSync(setupEnv(), { recursive: true, force: true })
})

test("readModeOptions returns booleans and undefined for missing keys", async () => {
  const mod = await import(`../src/lib/opencode-config.ts?case=4&t=${Date.now()}`)
  const opts = mod.readModeOptions({
    plugin: [["file:///home/lawaty/Projects/lacode/dist/index.js", { yolo: true }]],
  })
  assert.deepEqual(opts, { yolo: true, ykb: undefined })
  const none = mod.readModeOptions({
    plugin: [["file:///home/lawaty/Projects/lacode/dist/index.js", { yolo: "no", ykb: 1 }]],
  })
  assert.deepEqual(none, { yolo: undefined, ykb: undefined })
  rmSync(setupEnv(), { recursive: true, force: true })
})

test("writeModeOptions updates values, preserves // comments, and leaves no .tmp file", async () => {
  const root = setupEnv()
  const dir = join(root, "opencode")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "opencode.jsonc")
  writeFileSync(
    path,
    `{
  // keep this comment
  "plugin": [
    ["file:///home/lawaty/Projects/lacode/dist/index.js", { "yolo": false, "ykb": false }]
  ]
}
`,
  )
  const mod = await import(`../src/lib/opencode-config.ts?case=5&t=${Date.now()}`)
  mod.writeModeOptions({ yolo: true, ykb: true }, path)
  const text = readFileSync(path, "utf8")
  assert.match(text, /\/\/ keep this comment/)
  assert.match(text, /"yolo": true/)
  assert.match(text, /"ykb": true/)
  const files = readdirSync(dir)
  assert.ok(!files.some((f) => f.endsWith(".tmp")), `unexpected tmp files: ${files.join(",")}`)
  rmSync(root, { recursive: true, force: true })
})

test("a string plugin entry becomes [name, { ... }]", async () => {
  const root = setupEnv()
  const dir = join(root, "opencode")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "opencode.jsonc")
  writeFileSync(path, `{\n  "plugin": ["@lawaty/lacode"]\n}\n`)
  const mod = await import(`../src/lib/opencode-config.ts?case=6&t=${Date.now()}`)
  mod.writeModeOptions({ yolo: true }, path)
  const cfg = mod.readOpencodeConfig(path)
  assert.deepEqual(cfg.plugin, [["@lawaty/lacode", { yolo: true }]])
  rmSync(root, { recursive: true, force: true })
})

test("a tuple with no options object gains one", async () => {
  const root = setupEnv()
  const dir = join(root, "opencode")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "opencode.jsonc")
  writeFileSync(path, `{\n  "plugin": [["@lawaty/lacode"]]\n}\n`)
  const mod = await import(`../src/lib/opencode-config.ts?case=7&t=${Date.now()}`)
  mod.writeModeOptions({ ykb: true }, path)
  const cfg = mod.readOpencodeConfig(path)
  assert.deepEqual(cfg.plugin, [["@lawaty/lacode", { ykb: true }]])
  rmSync(root, { recursive: true, force: true })
})

test("a missing lacode entry throws OpenCodeConfigError", async () => {
  const root = setupEnv()
  const dir = join(root, "opencode")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "opencode.jsonc")
  writeFileSync(path, `{\n  "plugin": ["other-plugin"]\n}\n`)
  const mod = await import(`../src/lib/opencode-config.ts?case=8&t=${Date.now()}`)
  assert.throws(() => mod.writeModeOptions({ yolo: true }, path), mod.OpenCodeConfigError)
  rmSync(root, { recursive: true, force: true })
})

test(".json fallback is read and written", async () => {
  const root = setupEnv()
  const dir = join(root, "opencode")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "opencode.json")
  writeFileSync(path, baseConfig)
  const mod = await import(`../src/lib/opencode-config.ts?case=9&t=${Date.now()}`)
  assert.equal(mod.globalOpencodeConfigPath(), path)
  const cfg = mod.readOpencodeConfig(path)
  assert.deepEqual(mod.readModeOptions(cfg), { yolo: false, ykb: false })
  mod.writeModeOptions({ yolo: true }, path)
  const updated = mod.readOpencodeConfig(path)
  assert.deepEqual(mod.readModeOptions(updated), { yolo: true, ykb: false })
  rmSync(root, { recursive: true, force: true })
})
