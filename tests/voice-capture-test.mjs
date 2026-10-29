import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { planCapture, createCapture, createFrameSplitter } from "../src/voice/capture.ts"

function makeExists(available) {
  return (file) => {
    const base = String(file).split("/").pop()
    return available.includes(base)
  }
}

function makeSpawn(spawns) {
  return (bin, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.pid = 1234
    child.killedWith = undefined
    child.kill = (sig) => {
      child.killedWith = sig
    }
    child.unref = () => {}
    const rec = { bin, args, opts, child }
    spawns.push(rec)
    return child
  }
}

test("1. planCapture returns the ffmpeg-pulse plan on linux when ffmpeg exists", () => {
  const exists = makeExists(["ffmpeg"])
  const plan = planCapture({ platform: "linux", exists, env: { PATH: "/usr/bin" } })
  assert.deepEqual(plan, {
    bin: "ffmpeg",
    args: ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
  })
})

test("2. falls back to parec then arecord then undefined", () => {
  let available = ["parec"]
  let exists = makeExists(available)
  let plan = planCapture({ platform: "linux", exists, env: { PATH: "" } })
  assert.equal(plan.bin, "parec")

  available = ["arecord"]
  exists = makeExists(available)
  plan = planCapture({ platform: "linux", exists, env: { PATH: "" } })
  assert.equal(plan.bin, "arecord")

  available = []
  exists = makeExists(available)
  plan = planCapture({ platform: "linux", exists, env: { PATH: "" } })
  assert.equal(plan, undefined)
})

test("3. darwin/win32 plans have the right -f input", () => {
  const exists = makeExists(["ffmpeg"])
  const d = planCapture({ platform: "darwin", exists, env: { PATH: "" } })
  assert.equal(d.bin, "ffmpeg")
  assert.ok(d.args.includes("avfoundation"))
  assert.ok(d.args.includes(":0"))

  const w = planCapture({ platform: "win32", exists, env: { PATH: "" } })
  assert.equal(w.bin, "ffmpeg")
  assert.ok(w.args.includes("dshow"))
  assert.ok(w.args.includes("audio=default"))
})

test("4. LACODE_VOICE_INPUT replaces the input argument on linux and darwin", () => {
  const exists = makeExists(["ffmpeg"])
  const linux = planCapture({ platform: "linux", exists, env: { PATH: "", LACODE_VOICE_INPUT: "hw:1" } })
  assert.ok(linux.args.includes("hw:1"))
  assert.ok(!linux.args.includes("default"))

  const darwin = planCapture({ platform: "darwin", exists, env: { PATH: "", LACODE_VOICE_INPUT: ":1" } })
  assert.ok(darwin.args.includes(":1"))
  assert.ok(!darwin.args.includes(":0"))
})

test("5. createCapture spawns once on double start and forwards stdout chunks", () => {
  const exists = makeExists(["ffmpeg"])
  const spawns = []
  const spawnImpl = makeSpawn(spawns)
  const chunks = []
  const cap = createCapture((c) => chunks.push(c), { platform: "linux", exists, env: { PATH: "" }, spawnImpl })
  cap.start()
  cap.start()
  assert.equal(spawns.length, 1)
  assert.equal(cap.running, true)
  const child = spawns[0].child
  const buf = Buffer.from([1, 2, 3])
  child.stdout.emit("data", buf)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], buf)
  cap.stop()
})

test("6. stop sends SIGTERM, is idempotent, and running is false afterwards", () => {
  const exists = makeExists(["ffmpeg"])
  const spawns = []
  const spawnImpl = makeSpawn(spawns)
  const cap = createCapture(() => {}, { platform: "linux", exists, env: { PATH: "" }, spawnImpl })
  cap.start()
  assert.equal(cap.running, true)
  cap.stop()
  assert.equal(cap.running, false)
  assert.equal(spawns[0].child.killedWith, "SIGTERM")
  cap.stop()
  assert.equal(cap.running, false)
})

test("7. a child error event does not throw and leaves running false", () => {
  const exists = makeExists(["ffmpeg"])
  const spawns = []
  const spawnImpl = makeSpawn(spawns)
  const cap = createCapture(() => {}, { platform: "linux", exists, env: { PATH: "" }, spawnImpl })
  cap.start()
  assert.equal(cap.running, true)
  let threw = false
  try {
    spawns[0].child.emit("error", new Error("boom"))
  } catch {
    threw = true
  }
  assert.equal(threw, false)
  assert.equal(cap.running, false)
})

test("8. frame splitter buffers and emits frames", () => {
  const frames = []
  const split = createFrameSplitter(2, (f) => frames.push(f))
  split(Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03, 0x00]))
  assert.equal(frames.length, 1)
  assert.equal(frames[0][0], 1)
  assert.equal(frames[0][1], 2)
  split(Buffer.from([0x04, 0x00]))
  assert.equal(frames.length, 2)
  assert.equal(frames[1][0], 3)
  assert.equal(frames[1][1], 4)

  const frames2 = []
  const split2 = createFrameSplitter(1, (f) => frames2.push(f))
  split2(Buffer.from([0xff, 0xff]))
  assert.equal(frames2[0][0], -1)
})


test("9. linux plan ends with s16le pipe:1", () => {
  const exists = makeExists(["ffmpeg"])
  const plan = planCapture({ platform: "linux", exists, env: { PATH: "/usr/bin" } })
  assert.deepEqual(plan.args.slice(-3), ["-f", "s16le", "pipe:1"])
})
