import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import {
  stripAnsi,
  visibleLength,
  humanMs,
  humanBytes,
  bar,
  padRight,
  padLeft,
  formatTable,
  Progress,
  Spinner,
} from "../scripts/cli-display.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function runModule(code, env = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

test("stripAnsi / visibleLength: ANSI CSI codes removed, visibleLength ignores them, plain strings unchanged", () => {
  const ansi = "\x1b[31mred\x1b[0m \x1b[1;32mbold\x1b[0m"
  assert.equal(stripAnsi(ansi), "red bold")
  assert.equal(visibleLength(ansi), 8)
  assert.equal(stripAnsi("plain text"), "plain text")
  assert.equal(visibleLength("plain text"), 10)
  assert.equal(stripAnsi(""), "")
  assert.equal(visibleLength(""), 0)
})

test("humanMs: sub-second ms, seconds, minutes, boundaries, null/negative handled without throwing", () => {
  assert.equal(humanMs(0), "0ms")
  assert.equal(humanMs(1), "1ms")
  assert.equal(humanMs(999), "999ms")
  assert.equal(humanMs(1000), "1s")
  assert.equal(humanMs(1200), "1.2s")
  assert.equal(humanMs(59999), "60s")
  assert.equal(humanMs(60000), "1m00s")
  assert.equal(humanMs(61000), "1m01s")
  assert.equal(humanMs(125000), "2m05s")
  assert.equal(humanMs(null), "0ms")
  assert.equal(humanMs(undefined), "0ms")
  assert.equal(humanMs(-1), "0ms")
  assert.equal(humanMs(-1000), "0ms")
  assert.equal(humanMs(Number.NaN), "0ms")
  assert.equal(humanMs(Infinity), "0ms")
})

test("humanBytes: 0 B, bytes, KB, MB, GB (1024-based), trailing .0 dropped", () => {
  assert.equal(humanBytes(0), "0 B")
  assert.equal(humanBytes(1), "1 B")
  assert.equal(humanBytes(512), "512 B")
  assert.equal(humanBytes(1023), "1023 B")
  assert.equal(humanBytes(1024), "1 KB")
  assert.equal(humanBytes(1536), "1.5 KB")
  assert.equal(humanBytes(1024 * 1024), "1 MB")
  assert.equal(humanBytes(1.5 * 1024 * 1024), "1.5 MB")
  assert.equal(humanBytes(1024 * 1024 * 1024), "1 GB")
  assert.equal(humanBytes(2 * 1024 * 1024 * 1024), "2 GB")
  assert.equal(humanBytes(-5), "0 B")
  assert.equal(humanBytes(null), "0 B")
})

test("bar: zero progress, full, over-total clamped, unknown/zero total treated as full, exact width", () => {
  assert.equal(bar(0, 10, 10), "░░░░░░░░░░")
  assert.equal(visibleLength(bar(0, 10, 10)), 10)
  assert.equal(bar(10, 10, 10), "██████████")
  assert.equal(bar(15, 10, 10), "██████████")
  assert.equal(bar(5, 0, 10), "██████████")
  assert.equal(bar(5, -1, 10), "██████████")
  assert.equal(bar(5, Number.NaN, 10), "██████████")
  assert.equal(bar(3, 10, 10), "███░░░░░░░")
  assert.equal(visibleLength(bar(3, 10, 6)), 6)
})

test("padRight / padLeft: ANSI-aware width; truncation behavior matches implementation", () => {
  assert.equal(padRight("abc", 5), "abc  ")
  assert.equal(padLeft("abc", 5), "  abc")
  assert.equal(padRight("abcdef", 5), "abcd…")
  assert.equal(padLeft("abcdef", 5), "abcd…")
  assert.equal(padRight("ab", 2), "ab")
  assert.equal(padLeft("ab", 2), "ab")

  const colored = "\x1b[31mab\x1b[0m"
  const paddedRight = padRight(colored, 5)
  assert.equal(visibleLength(paddedRight), 5)
  assert.equal(stripAnsi(paddedRight), "ab   ")
  assert.ok(paddedRight.includes("\x1b[31m"))
  assert.ok(paddedRight.includes("\x1b[0m"))

  const paddedLeft = padLeft(colored, 5)
  assert.equal(visibleLength(paddedLeft), 5)
  assert.equal(stripAnsi(paddedLeft), "   ab")

  const longColored = "\x1b[31mabcdef\x1b[0m"
  const truncated = padRight(longColored, 5)
  assert.equal(visibleLength(truncated), 5)
  assert.equal(stripAnsi(truncated), "abcd…")
  assert.ok(truncated.includes("\x1b[31m"))
})

test("formatTable: header/rows alignment, visible width columns, maxWidth shrinking, no trailing newline", () => {
  const table = formatTable({
    headers: ["Name", "Count", "Size"],
    rows: [
      ["alpha", "1", "10 B"],
      ["beta", "20", "2 KB"],
    ],
    align: ["left", "right", "right"],
  })
  const lines = table.split("\n")
  assert.equal(lines.length, 3)
  assert.equal(lines[0], "Name   Count  Size")
  assert.equal(lines[1], "alpha      1  10 B")
  assert.equal(lines[2], "beta      20  2 KB")
  assert.ok(!table.endsWith("\n"))

  const colored = formatTable({
    headers: ["A", "B"],
    rows: [["\x1b[32mok\x1b[0m", "1"]],
    align: ["left", "right"],
  })
  const coloredLines = colored.split("\n")
  assert.equal(stripAnsi(coloredLines[1]), "ok  1")
  assert.ok(coloredLines[1].includes("\x1b[32m"))

  const shrunk = formatTable({
    headers: ["Col1", "Col2"],
    rows: [["longlong", "x"]],
    maxWidth: 8,
  })
  for (const line of shrunk.split("\n")) {
    assert.ok(visibleLength(line) <= 8, `line too wide: ${JSON.stringify(line)}`)
  }
  assert.ok(shrunk.length > 0)
})

test("Color gating: NO_COLOR=1 disables, FORCE_COLOR=1 enables, default piped disables", () => {
  const code = "import('./scripts/cli-display.mjs').then(m=>process.stdout.write(JSON.stringify({text:m.color.red('x'),enabled:m.colorEnabled})))"

  const noColor = JSON.parse(runModule(code, { NO_COLOR: "1", FORCE_COLOR: undefined }))
  assert.equal(noColor.enabled, false)
  assert.equal(noColor.text, "x")
  assert.ok(!noColor.text.includes("\x1b"))

  const forced = JSON.parse(runModule(code, { FORCE_COLOR: "1", NO_COLOR: undefined }))
  assert.equal(forced.enabled, true)
  assert.ok(forced.text.includes("\x1b"))
  assert.ok(forced.text.includes("x"))

  const piped = JSON.parse(runModule(code, { NO_COLOR: undefined, FORCE_COLOR: undefined, TERM: "xterm-256color" }))
  assert.equal(piped.enabled, false)
  assert.equal(piped.text, "x")
  assert.ok(!piped.text.includes("\x1b"))
})

test("Progress non-TTY injected stream: update/tick write nothing, done() no message writes nothing, done(msg) writes one plain line", () => {
  const writes = []
  const stream = { isTTY: false, write(chunk) { writes.push(String(chunk)) } }
  const progress = new Progress({ total: 10, label: "Work", stream })
  progress.update(1, "a")
  progress.tick("b")
  progress.update(5)
  assert.deepEqual(writes, [])

  progress.done()
  assert.deepEqual(writes, [])

  const writes2 = []
  const stream2 = { isTTY: false, write(chunk) { writes2.push(String(chunk)) } }
  const progress2 = new Progress({ total: 3, label: "Work", stream: stream2 })
  progress2.update(1)
  progress2.done("finished")
  assert.deepEqual(writes2, ["finished\n"])
})

test("Progress TTY injected stream: update renders with \\r and clear-line escape, done(fin) ends with final line", () => {
  const writes = []
  const stream = { isTTY: true, columns: 60, write(chunk) { writes.push(String(chunk)) } }
  const progress = new Progress({ total: 10, label: "Load", stream, width: 10 })
  progress.update(5, "half")
  assert.ok(writes.length >= 1)
  const first = writes[0]
  assert.ok(first.includes("\r"))
  assert.ok(first.includes("\x1b[2K"))
  assert.ok(stripAnsi(first).includes("Load"))
  assert.ok(stripAnsi(first).includes("5/10"))

  progress.done("fin")
  const all = writes.join("")
  assert.ok(all.includes("\r\x1b[2K"))
  assert.equal(writes[writes.length - 1], "fin\n")
  assert.ok(writes[writes.length - 2].includes("\r\x1b[2K"))
})

test("Spinner non-TTY: start/update silent, stop(msg) emits one plain line", () => {
  const writes = []
  const stream = { isTTY: false, write(chunk) { writes.push(String(chunk)) } }
  const spinner = new Spinner({ stream, label: "work" })
  try {
    spinner.start()
    spinner.update("next")
    assert.deepEqual(writes, [])
    spinner.stop("done")
    assert.deepEqual(writes, ["done\n"])
  } finally {
    spinner.stop()
  }
})

test("Spinner TTY: emits frames with \\r and clear-line escape, stop writes final line and cleans timer", async () => {
  const writes = []
  const stream = { isTTY: true, columns: 60, write(chunk) { writes.push(String(chunk)) } }
  const spinner = new Spinner({ stream, label: "work", intervalMs: 10 })
  try {
    spinner.start()
    assert.ok(writes.length >= 1)
    assert.ok(writes[0].includes("\r\x1b[2K"))
    assert.ok(stripAnsi(writes[0]).includes("work"))

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 35))
    assert.ok(writes.length >= 2, "spinner should render additional frames")

    spinner.stop("all done")
    const final = writes[writes.length - 1]
    assert.equal(final, "all done\n")
    assert.ok(writes[writes.length - 2].includes("\r\x1b[2K"))
  } finally {
    spinner.stop()
  }
})
