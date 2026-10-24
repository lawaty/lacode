import { strict as assert } from "node:assert"
import { readClipboardImage } from "../src/lib/clipboard.ts"

let failures = 0
const ok = (name) => {
  process.stdout.write(`  ok  ${name}\n`)
}
const check = async (name, fn) => {
  try {
    await fn()
    ok(name)
  } catch (error) {
    failures++
    process.stdout.write(`  FAIL ${name}: ${error?.message ?? error}\n`)
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 1, 2, 3, 4, 5])
const XCLIP_ARGS = ["-selection", "clipboard", "-t", "image/png", "-o"]
const WLPASTE_ARGS = ["--type", "image/png"]

// Every run/have is injected: the suite never spawns a real binary and
// never touches the network.
const fakeRun = (scripts) => {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, args])
    return scripts[cmd]
  }
  return { run, calls }
}

await check("linux xclip returns png bytes untouched", async () => {
  const { run, calls } = fakeRun({ xclip: { ok: true, stdout: PNG, stderr: "" } })
  const out = await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" }, run, have: (cmd) => cmd === "xclip" })
  assert.ok(out !== null, "expected image bytes")
  assert.ok(out.equals(PNG), "bytes must come back untouched")
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ["xclip", XCLIP_ARGS])
})

await check("empty clipboard output resolves to null", async () => {
  const { run } = fakeRun({ xclip: { ok: true, stdout: Buffer.alloc(0), stderr: "" } })
  const out = await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" }, run, have: (cmd) => cmd === "xclip" })
  assert.equal(out, null)
})

await check("non-image bytes resolve to null", async () => {
  const { run } = fakeRun({ xclip: { ok: true, stdout: Buffer.from("definitely not an image"), stderr: "" } })
  const out = await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" }, run, have: (cmd) => cmd === "xclip" })
  assert.equal(out, null)
})

await check("wayland session falls back to xclip when wl-paste is absent", async () => {
  const { run, calls } = fakeRun({ xclip: { ok: true, stdout: PNG, stderr: "" } })
  const out = await readClipboardImage({
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    run,
    have: (cmd) => cmd === "xclip",
  })
  assert.ok(out !== null, "expected image bytes")
  assert.ok(out.equals(PNG))
  assert.equal(calls.length, 1, "wl-paste must be skipped, not run")
  assert.deepEqual(calls[0], ["xclip", XCLIP_ARGS])
})

await check("non-zero exit resolves to null", async () => {
  const { run, calls } = fakeRun({ xclip: { ok: false, stdout: PNG, stderr: "xclip: error: no image" } })
  const out = await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" }, run, have: (cmd) => cmd === "xclip" })
  assert.equal(out, null)
  assert.equal(calls.length, 1)
})

await check("wayland session prefers wl-paste when both exist", async () => {
  const { run, calls } = fakeRun({
    "wl-paste": { ok: true, stdout: PNG, stderr: "" },
    xclip: { ok: true, stdout: PNG, stderr: "" },
  })
  const out = await readClipboardImage({
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    run,
    have: () => true,
  })
  assert.ok(out !== null, "expected image bytes")
  assert.equal(calls.length, 1, "xclip must not run once wl-paste succeeds")
  assert.deepEqual(calls[0], ["wl-paste", WLPASTE_ARGS])
})

await check("darwin without pngpaste resolves to null without spawning", async () => {
  const { run, calls } = fakeRun({ pngpaste: { ok: true, stdout: PNG, stderr: "" } })
  const out = await readClipboardImage({ platform: "darwin", env: {}, run, have: () => false })
  assert.equal(out, null)
  assert.equal(calls.length, 0)
})

if (failures > 0) {
  process.stdout.write(`\nFAIL: ${failures} check(s) failed\n`)
  process.exit(1)
}
process.stdout.write("\nclipboard: all checks passed\n")
