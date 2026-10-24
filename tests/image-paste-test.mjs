import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { imagePasteHooks } from "../src/plugins/image-paste.ts"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
const HASH = createHash("sha256").update(PNG).digest("hex")
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x01])
const PNG2_HASH = createHash("sha256").update(PNG2).digest("hex")
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01])
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x00, 0x00, 0x00, 0x00])
const UNKNOWN = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f])
const JPEG_HASH = createHash("sha256").update(JPEG).digest("hex")
const GIF_HASH = createHash("sha256").update(GIF).digest("hex")
const WEBP_HASH = createHash("sha256").update(WEBP).digest("hex")

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

function makeInput() {
  const logs = []
  const toasts = []
  const input = {
    client: {
      app: { log: async (x) => { logs.push(x) } },
      tui: { showToast: async (x) => { toasts.push(x) } },
    },
  }
  return { input, logs, toasts }
}

function writeImage(dir, name, bytes) {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}

await check("inserts clipboard image as file part before text part", async () => {
  const { input, logs, toasts } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const hooks = await imagePasteHooks(input, { dir }, { readClipboard: async () => PNG })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out)
  assert.equal(out.parts.length, 2)
  assert.equal(out.parts[0].type, "file")
  assert.equal(out.parts[0].mime, "image/png")
  assert.equal(out.parts[0].url, "data:image/png;base64," + PNG.toString("base64"))
  assert.equal(out.parts[0].filename, "clipboard-" + HASH.slice(0, 8) + ".png")
  assert.equal(typeof out.parts[0].id, "string")
  assert.ok(out.parts[0].id.length > 0)
  assert.equal(typeof out.parts[0].messageID, "string")
  assert.ok(out.parts[0].messageID.length > 0)
  assert.equal(out.parts[0].sessionID, "s")
  assert.deepEqual(out.parts[1], { type: "text", text: "hi" })
})

await check("writes the png to disk", async () => {
  const { input } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const hooks = await imagePasteHooks(input, { dir }, { readClipboard: async () => PNG })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out)
  assert.deepEqual(readFileSync(join(dir, HASH + ".png")), PNG)
  assert.deepEqual(readdirSync(dir), [HASH + ".png"])
  assert.equal(statSync(join(dir, HASH + ".png")).mode & 0o777, 0o600)
})

await check("stable dedupe filename", async () => {
  const { input } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const hooks = await imagePasteHooks(input, { dir }, { readClipboard: async () => PNG })
  const out1 = { parts: [{ type: "text", text: "hi" }] }
  const out2 = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out1)
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out2)
  assert.equal(out1.parts[0].filename, out2.parts[0].filename)
  assert.equal(readdirSync(dir).length, 1)
})

await check("oversize refuses without adding a part", async () => {
  const { input, logs, toasts } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const hooks = await imagePasteHooks(input, { dir, maxBytes: 8 }, { readClipboard: async () => PNG })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out)
  assert.equal(out.parts.length, 1)
  assert.equal(out.parts[0].type, "text")
  const logEntry = logs.find((l) => l.body && l.body.service === "image-paste" && l.body.level === "warn" && l.body.message === "image too large: 16 bytes, max 8")
  assert.ok(logEntry, "expected warn log")
  const toastEntry = toasts.find((t) => t.body && t.body.title === "lacode" && t.body.message === "image too large: 16 bytes, max 8" && t.body.variant === "warning")
  assert.ok(toastEntry, "expected toast")
  assert.equal(readdirSync(dir).length, 0)
})

await check("null clipboard adds nothing and logs", async () => {
  const { input, logs, toasts } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const hooks = await imagePasteHooks(input, { dir }, { readClipboard: async () => null })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out)
  assert.equal(out.parts.length, 1)
  const logEntry = logs.find((l) => l.body && l.body.level === "warn" && l.body.message === "No image on the clipboard")
  assert.ok(logEntry, "expected warn log")
  const toastEntry = toasts.find((t) => t.body && t.body.message === "No image on the clipboard" && t.body.variant === "warning")
  assert.ok(toastEntry, "expected toast")
  assert.equal(readdirSync(dir).length, 0)
})

await check("other command names do nothing", async () => {
  const { input, logs, toasts } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  let calls = 0
  const hooks = await imagePasteHooks(input, { dir }, { readClipboard: async () => { calls++; return PNG } })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "help", sessionID: "s", arguments: "" }, out)
  assert.equal(out.parts.length, 1)
  assert.equal(calls, 0)
  assert.equal(logs.length, 0)
  assert.equal(toasts.length, 0)
  assert.equal(readdirSync(dir).length, 0)
})

await check("disabled returns no hooks", async () => {
  const { input } = makeInput()
  const hooks = await imagePasteHooks(input, { enabled: false })
  assert.deepEqual(hooks, {})
})

await check("writes jpeg to disk", async () => {
  const { input } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const hooks = await imagePasteHooks(input, { dir }, { readClipboard: async () => JPEG })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out)
  assert.equal(out.parts.length, 2)
  assert.equal(out.parts[0].type, "file")
  assert.equal(out.parts[0].mime, "image/jpeg")
  assert.equal(out.parts[0].filename, "clipboard-" + JPEG_HASH.slice(0, 8) + ".jpg")
  assert.equal(out.parts[0].url, "data:image/jpeg;base64," + JPEG.toString("base64"))
  assert.deepEqual(out.parts[1], { type: "text", text: "hi" })
  assert.deepEqual(readFileSync(join(dir, JPEG_HASH + ".jpg")), JPEG)
  assert.deepEqual(readdirSync(dir), [JPEG_HASH + ".jpg"])
  assert.equal(statSync(join(dir, JPEG_HASH + ".jpg")).mode & 0o777, 0o600)
})

await check("writes gif to disk", async () => {
  const { input } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const hooks = await imagePasteHooks(input, { dir }, { readClipboard: async () => GIF })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out)
  assert.equal(out.parts[0].mime, "image/gif")
  assert.equal(out.parts[0].filename, "clipboard-" + GIF_HASH.slice(0, 8) + ".gif")
  assert.deepEqual(readdirSync(dir), [GIF_HASH + ".gif"])
})

await check("writes webp to disk", async () => {
  const { input } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const hooks = await imagePasteHooks(input, { dir }, { readClipboard: async () => WEBP })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out)
  assert.equal(out.parts[0].mime, "image/webp")
  assert.equal(out.parts[0].filename, "clipboard-" + WEBP_HASH.slice(0, 8) + ".webp")
  assert.deepEqual(readdirSync(dir), [WEBP_HASH + ".webp"])
})

await check("unknown signature adds nothing and logs", async () => {
  const { input, logs, toasts } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const hooks = await imagePasteHooks(input, { dir }, { readClipboard: async () => UNKNOWN })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image-in-cb", sessionID: "s", arguments: "hi" }, out)
  assert.equal(out.parts.length, 1)
  const logEntry = logs.find((l) => l.body && l.body.service === "image-paste" && l.body.level === "warn" && l.body.message === "unsupported clipboard image format (expected PNG, JPEG, GIF or WebP)")
  assert.ok(logEntry, "expected warn log")
  const toastEntry = toasts.find((t) => t.body && t.body.title === "lacode" && t.body.message === "unsupported clipboard image format (expected PNG, JPEG, GIF or WebP)" && t.body.variant === "warning")
  assert.ok(toastEntry, "expected toast")
  assert.equal(readdirSync(dir).length, 0)
})

await check("image command attaches two png files in argument order", async () => {
  const { input, logs } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const src = mkdtempSync(join(tmpdir(), "lacode-src-"))
  const a = writeImage(src, "a.png", PNG)
  const b = writeImage(src, "b.png", PNG2)
  const hooks = await imagePasteHooks(input, { dir })
  const out = { parts: [{ type: "text", text: "hi" }] }
  // Deliberately non-sorted order: the parts must follow the arguments, not the names.
  await hooks["command.execute.before"]({ command: "image", sessionID: "s", arguments: `${b} ${a}` }, out)
  assert.equal(out.parts.length, 3)
  assert.equal(out.parts[0].type, "file")
  assert.equal(out.parts[0].mime, "image/png")
  assert.equal(out.parts[0].filename, `b-${PNG2_HASH.slice(0, 8)}.png`)
  assert.equal(out.parts[1].type, "file")
  assert.equal(out.parts[1].mime, "image/png")
  assert.equal(out.parts[1].filename, `a-${HASH.slice(0, 8)}.png`)
  assert.deepEqual(out.parts[2], { type: "text", text: "hi" })
  const disk = readdirSync(dir)
  assert.equal(disk.length, 2)
  assert.ok(disk.includes(HASH + ".png"))
  assert.ok(disk.includes(PNG2_HASH + ".png"))
  assert.equal(logs.length, 0)
})

await check("image command dedupes identical bytes within one message", async () => {
  const { input, logs, toasts } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const src = mkdtempSync(join(tmpdir(), "lacode-src-"))
  const a = writeImage(src, "a.png", PNG)
  const b = writeImage(src, "b.png", PNG)
  const hooks = await imagePasteHooks(input, { dir })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image", sessionID: "s", arguments: `${a} ${b}` }, out)
  assert.equal(out.parts.length, 2)
  assert.equal(out.parts[0].type, "file")
  assert.equal(out.parts[0].filename, `a-${HASH.slice(0, 8)}.png`)
  assert.deepEqual(out.parts[1], { type: "text", text: "hi" })
  assert.deepEqual(readdirSync(dir), [HASH + ".png"])
  assert.equal(logs.length, 0)
  assert.equal(toasts.length, 0)
})

await check("image command honours quoted paths containing spaces", async () => {
  const { input, logs } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const src = mkdtempSync(join(tmpdir(), "lacode-src-"))
  const a = writeImage(src, "one image.png", PNG)
  const b = writeImage(src, "two image.png", PNG2)
  const hooks = await imagePasteHooks(input, { dir })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image", sessionID: "s", arguments: `"${a}" '${b}'` }, out)
  assert.equal(out.parts.length, 3)
  assert.equal(out.parts[0].type, "file")
  assert.equal(out.parts[0].filename, `one image-${HASH.slice(0, 8)}.png`)
  assert.equal(out.parts[1].type, "file")
  assert.equal(out.parts[1].filename, `two image-${PNG2_HASH.slice(0, 8)}.png`)
  assert.equal(logs.length, 0)
})

await check("image command skips a missing path and warns once", async () => {
  const { input, logs, toasts } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const src = mkdtempSync(join(tmpdir(), "lacode-src-"))
  const a = writeImage(src, "a.png", PNG)
  const missing = join(src, "nope.png")
  const hooks = await imagePasteHooks(input, { dir })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image", sessionID: "s", arguments: `${missing} ${a}` }, out)
  assert.equal(out.parts.length, 2)
  assert.equal(out.parts[0].type, "file")
  assert.equal(out.parts[0].filename, `a-${HASH.slice(0, 8)}.png`)
  assert.deepEqual(out.parts[1], { type: "text", text: "hi" })
  assert.equal(logs.length, 1)
  assert.equal(logs[0].body.service, "image-paste")
  assert.equal(logs[0].body.level, "warn")
  assert.equal(logs[0].body.message, "skipped 1 image file: nope.png")
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].body.title, "lacode")
  assert.equal(toasts[0].body.message, "skipped 1 image file: nope.png")
  assert.equal(toasts[0].body.variant, "warning")
  assert.deepEqual(readdirSync(dir), [HASH + ".png"])
})

await check("image command honours maxImages", async () => {
  const { input, logs, toasts } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const src = mkdtempSync(join(tmpdir(), "lacode-src-"))
  const a = writeImage(src, "a.png", PNG)
  const b = writeImage(src, "b.png", PNG2)
  const hooks = await imagePasteHooks(input, { dir, maxImages: 1 })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image", sessionID: "s", arguments: `${a} ${b}` }, out)
  assert.equal(out.parts.length, 2)
  assert.equal(out.parts[0].type, "file")
  assert.equal(out.parts[0].filename, `a-${HASH.slice(0, 8)}.png`)
  assert.deepEqual(out.parts[1], { type: "text", text: "hi" })
  assert.equal(logs.length, 1)
  assert.equal(logs[0].body.message, "skipped 1 image file: b.png")
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].body.message, "skipped 1 image file: b.png")
  // A skipped file is never archived: caps are checked before the write, so the
  // archive only ever holds images that actually made it into a message.
  assert.equal(readdirSync(dir).length, 1)
})

await check("image command keeps per-kind extensions for jpeg and png", async () => {
  const { input, logs } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const src = mkdtempSync(join(tmpdir(), "lacode-src-"))
  const a = writeImage(src, "a.png", PNG)
  const b = writeImage(src, "b.jpg", JPEG)
  const hooks = await imagePasteHooks(input, { dir })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image", sessionID: "s", arguments: `${a} ${b}` }, out)
  assert.equal(out.parts.length, 3)
  assert.equal(out.parts[0].mime, "image/png")
  assert.ok(out.parts[0].filename.endsWith(".png"), `png part filename must end .png, got ${out.parts[0].filename}`)
  assert.equal(out.parts[1].mime, "image/jpeg")
  assert.ok(out.parts[1].filename.endsWith(".jpg"), `jpg part filename must end .jpg, got ${out.parts[1].filename}`)
  const disk = readdirSync(dir)
  assert.ok(disk.includes(HASH + ".png"))
  assert.ok(disk.includes(JPEG_HASH + ".jpg"))
  assert.equal(logs.length, 0)
})

await check("image command expands a glob argument in sorted order", async () => {
  const { input, logs } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const src = mkdtempSync(join(tmpdir(), "lacode-src-"))
  writeImage(src, "a.png", PNG)
  writeImage(src, "b.png", PNG2)
  const hooks = await imagePasteHooks(input, { dir })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image", sessionID: "s", arguments: `${src}/*.png` }, out)
  assert.equal(out.parts.length, 3)
  assert.equal(out.parts[0].type, "file")
  assert.equal(out.parts[0].filename, `a-${HASH.slice(0, 8)}.png`)
  assert.equal(out.parts[1].type, "file")
  assert.equal(out.parts[1].filename, `b-${PNG2_HASH.slice(0, 8)}.png`)
  assert.equal(logs.length, 0)
})

await check("image command enforces the 20 MiB total-bytes cap", async () => {
  const { input, logs, toasts } = makeInput()
  const dir = mkdtempSync(join(tmpdir(), "lacode-image-"))
  const src = mkdtempSync(join(tmpdir(), "lacode-src-"))
  const bigPng = (fill) => {
    const b = Buffer.alloc(8 * 1024 * 1024, fill)
    PNG.copy(b, 0)
    return b
  }
  const big1 = bigPng(0x01)
  const big2 = bigPng(0x02)
  const big3 = bigPng(0x03)
  const a = writeImage(src, "a.png", big1)
  const b = writeImage(src, "b.png", big2)
  const c = writeImage(src, "c.png", big3)
  const hooks = await imagePasteHooks(input, { dir, maxBytes: 16 * 1024 * 1024 })
  const out = { parts: [{ type: "text", text: "hi" }] }
  await hooks["command.execute.before"]({ command: "image", sessionID: "s", arguments: `${a} ${b} ${c}` }, out)
  assert.equal(out.parts.length, 3)
  assert.equal(out.parts[0].type, "file")
  assert.equal(out.parts[0].filename, `a-${createHash("sha256").update(big1).digest("hex").slice(0, 8)}.png`)
  assert.equal(out.parts[1].type, "file")
  assert.equal(out.parts[1].filename, `b-${createHash("sha256").update(big2).digest("hex").slice(0, 8)}.png`)
  assert.deepEqual(out.parts[2], { type: "text", text: "hi" })
  assert.equal(logs.length, 1)
  assert.equal(logs[0].body.message, "skipped 1 image file: c.png")
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].body.message, "skipped 1 image file: c.png")
  // The capped file is not archived, same as the maxImages case.
  assert.equal(readdirSync(dir).length, 2)
})

if (failures > 0) {
  process.stdout.write(`\nFAIL: ${failures} check(s) failed\n`)
  process.exit(1)
}
process.stdout.write("\nimage-paste: all checks passed\n")
