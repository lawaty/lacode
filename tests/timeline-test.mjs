import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as tl from "../src/lib/timeline.ts"

const dir = mkdtempSync(join(tmpdir(), "lacode-timeline-"))
process.env.LACODE_TIMELINE_DIR = dir
after(() => rmSync(dir, { recursive: true, force: true }))

test("timelineFile validates sessionID", () => {
  assert.throws(() => tl.timelineFile("a/b"))
  assert.ok(tl.timelineFile("abc_1").endsWith("abc_1.jsonl"))
})

test("buildExcerpt cursor found", () => {
  const msgs = [
    { info: { id: "m1", role: "user", time: { created: 1 }, model: { providerID: "p", modelID: "m" } }, parts: [{ type: "text", text: "hello" }] },
    { info: { id: "m2", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "hi there" }, { type: "tool", tool: "read", state: { status: "done", input: { filePath: "/a" } } }] },
    { info: { id: "m3", role: "user", time: { created: 3 } }, parts: [{ type: "text", text: "next q", synthetic: false, ignored: false }] },
  ]
  const r = tl.buildExcerpt(msgs, { messageID: "m1" })
  assert.equal(r.count, 2)
  assert.match(r.text, /\[assistant\] hi there/)
  assert.match(r.text, /\[tool\] read \(done\) \/a/)
  assert.match(r.text, /\[user\] next q/)
  assert.deepEqual(r.next, { messageID: "m3", time: 3 })
  assert.deepEqual(r.model, { providerID: "p", modelID: "m" })
})

test("buildExcerpt cursor not found time fallback", () => {
  const msgs = [
    { info: { id: "a", role: "user", time: { created: 10 } }, parts: [{ type: "text", text: "old" }] },
    { info: { id: "b", role: "user", time: { created: 20 } }, parts: [{ type: "text", text: "new" }] },
  ]
  const r = tl.buildExcerpt(msgs, { messageID: "missing", time: 10 })
  assert.equal(r.count, 1)
  assert.match(r.text, /new/)
  assert.equal(r.next.messageID, "b")
})

test("buildExcerpt budget truncation", () => {
  const big = "x".repeat(10000)
  const msgs = [
    { info: { id: "a", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: big }] },
    { info: { id: "b", role: "user", time: { created: 2 } }, parts: [{ type: "text", text: "second" }] },
  ]
  const r = tl.buildExcerpt(msgs, undefined, 100)
  assert.equal(r.count, 1)
  assert.ok(r.text.length <= 100)
  assert.ok(r.next)
})

test("parseBullets basic", () => {
  assert.deepEqual(tl.parseBullets("- A\n* B\n1. C\nplain prose\n"), ["A", "B", "C"])
})

test("parseBullets long/dup/prose-only", () => {
  const kept = "x".repeat(250)
  const dropped = "x".repeat(400)
  assert.deepEqual(tl.parseBullets(`- A\n- a\n- ${kept}\n- ${dropped}\njust prose\n`), ["A", kept])
  assert.deepEqual(tl.parseBullets("just prose\nno bullets"), [])
})

test("salvageBullets drops preamble and recovers bullets", () => {
  assert.deepEqual(tl.salvageBullets("Here are the entries:\nConfig: silenced warnings\n- Pool: added routing\n"), ["Config: silenced warnings", "Pool: added routing"])
})

test("salvageBullets strips markers without following space", () => {
  assert.deepEqual(tl.salvageBullets("-A\n*B\n1.C\n"), ["A", "B", "C"])
})

test("salvageBullets recovers fenced content", () => {
  assert.deepEqual(tl.salvageBullets("```\n- A\n- B\n```\n"), ["A", "B"])
})

test("salvageBullets case-insensitive dedupe", () => {
  assert.deepEqual(tl.salvageBullets("- A\n- a\n- B\n"), ["A", "B"])
})

test("salvageBullets drops markdown heading", () => {
  assert.deepEqual(tl.salvageBullets("# Title\n- A\n"), ["A"])
})

test("appendEntries/readEntries/dedupe/removeEntries round trip", () => {
  const sid = "sess1"
  assert.equal(tl.appendEntries(sid, ["hello", "world", ""], 1000), 2)
  assert.equal(tl.appendEntries(sid, ["HELLO", "new"], 2000), 1)
  const entries = tl.readEntries(sid)
  assert.equal(entries.length, 3)
  assert.equal(entries[0].text, "hello")
  tl.removeEntries(sid)
  assert.equal(tl.appendEntries(sid, ["one"], 3000, { messageID: "m1", time: 10 }), 1)
  assert.deepEqual(tl.readEntries(sid)[0].through, { messageID: "m1", time: 10 })
  tl.removeEntries(sid)
  assert.deepEqual(tl.readEntries(sid), [])
})

test("buildExcerpt tool result", () => {
  const msgs = [
    { info: { id: "t1", role: "assistant", time: { created: 1 } }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "ok 588 tests" } }] },
  ]
  const r = tl.buildExcerpt(msgs)
  assert.match(r.text, /bash/)
  assert.match(r.text, /npm test/)
  assert.match(r.text, /ok 588 tests/)
})

test("appendEntries truncates to 320", () => {
  const sid = "sess_trunc"
  const long = "y".repeat(400)
  assert.equal(tl.appendEntries(sid, [long], 1000), 1)
  const entries = tl.readEntries(sid)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].text.length, 320)
  tl.removeEntries(sid)
})

test("isInternalTitle", () => {
  assert.equal(tl.isInternalTitle("context (auto) foo"), true)
  assert.equal(tl.isInternalTitle("timeline (auto)"), true)
  assert.equal(tl.isInternalTitle("pool probe"), true)
  assert.equal(tl.isInternalTitle("normal"), false)
  assert.equal(tl.isInternalTitle(undefined), false)
})

test("appendEntriesAt/readEntriesAt round trip", () => {
  const file = join(dir, "at-roundtrip.jsonl")
  assert.equal(tl.appendEntriesAt(file, ["hello", "world", ""], 1000), 2)
  assert.equal(tl.appendEntriesAt(file, ["HELLO", "new"], 2000), 1)
  const entries = tl.readEntriesAt(file)
  assert.equal(entries.length, 3)
  assert.equal(entries[0].text, "hello")
  assert.equal(tl.appendEntriesAt(file, ["one"], 3000, { messageID: "m1", time: 10 }), 1)
  const last = tl.readEntriesAt(file)
  assert.deepEqual(last[last.length - 1].through, { messageID: "m1", time: 10 })
  assert.deepEqual(tl.readEntriesAt(join(dir, "missing.jsonl")), [])
  assert.deepEqual(tl.readEntriesAt(file, 0), [])
})

test("appendEntries writes real newlines between entries", () => {
  const file = join(dir, "newlines.jsonl")
  assert.equal(tl.appendEntriesAt(file, ["first entry", "second entry"], 1000), 2)
  const raw = readFileSync(file, "utf8")
  assert.equal(raw.split("\n").filter(Boolean).length, 2)
  assert.ok(raw.includes("}\n{"), "expected a real newline between JSON objects")
  assert.ok(!raw.includes("}\\n{"), "must not contain a literal backslash-n")
})

test("buildExcerpt skips reprocess command turn", () => {
  const msgs = [
    { info: { id: "u1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "timeline_reprocess please" }] },
    { info: { id: "a1", role: "assistant", time: { created: 2 } }, parts: [{ type: "tool", tool: "timeline_reprocess", state: { status: "done", input: {} } }] },
    { info: { id: "u2", role: "user", time: { created: 3 } }, parts: [{ type: "text", text: "normal question" }] },
    { info: { id: "a2", role: "assistant", time: { created: 4 } }, parts: [{ type: "text", text: "normal answer" }] },
  ]
  const r = tl.buildExcerpt(msgs)
  assert.doesNotMatch(r.text, /timeline_reprocess/)
  assert.match(r.text, /normal question/)
  assert.match(r.text, /normal answer/)
})
test("parseBullets strips markdown noise", () => {
  assert.deepEqual(tl.parseBullets("- **Pool:** added `bucket` routing\n"), ["Pool: added bucket routing"])
})

test("timelineStateFile validates sessionID and path", () => {
  assert.throws(() => tl.timelineStateFile("a/b"))
  assert.ok(tl.timelineStateFile("abc_1").endsWith("abc_1.state.json"))
})

test("timeline state write/read round trip preserves fields and version", () => {
  const sid = "state_roundtrip"
  const state = {
    version: 99,
    cursor: { messageID: "m9", time: 123 },
    failures: 4,
    pending: true,
    nextAttemptAt: 456,
    updatedAt: 789,
  }
  tl.writeTimelineState(sid, state)
  assert.deepEqual(tl.readTimelineState(sid), {
    version: tl.TIMELINE_STATE_VERSION,
    cursor: { messageID: "m9", time: 123 },
    failures: 4,
    pending: true,
    nextAttemptAt: 456,
    updatedAt: 789,
  })
  tl.removeTimelineState(sid)
})

test("timeline state missing and malformed JSON return undefined", () => {
  assert.equal(tl.readTimelineState("state_missing"), undefined)
  const bad = "state_malformed"
  writeFileSync(tl.timelineStateFile(bad), "{not json")
  assert.equal(tl.readTimelineState(bad), undefined)
  tl.removeTimelineState(bad)
})

test("timeline state normalizes invalid values", () => {
  const sid = "state_normalize"
  tl.writeTimelineState(sid, {
    version: 0,
    cursor: { messageID: "", time: Infinity },
    failures: -3,
    pending: "yes",
    nextAttemptAt: 0,
    updatedAt: NaN,
  })
  const first = tl.readTimelineState(sid)
  assert.ok(first)
  assert.equal(first.version, tl.TIMELINE_STATE_VERSION)
  assert.equal(first.cursor, undefined)
  assert.equal(first.failures, 0)
  assert.equal(first.pending, false)
  assert.equal(first.nextAttemptAt, undefined)
  assert.equal(typeof first.updatedAt, "number")
  assert.ok(Number.isFinite(first.updatedAt))

  tl.writeTimelineState(sid, {
    version: 1,
    failures: NaN,
    pending: false,
    nextAttemptAt: -5,
    updatedAt: 1,
  })
  const second = tl.readTimelineState(sid)
  assert.equal(second.failures, 0)
  assert.equal(second.nextAttemptAt, undefined)
  tl.removeTimelineState(sid)
})

test("removeTimelineState deletes the file", () => {
  const sid = "state_remove"
  tl.writeTimelineState(sid, { version: 1, failures: 0, pending: false, updatedAt: 1 })
  assert.ok(tl.readTimelineState(sid))
  tl.removeTimelineState(sid)
  assert.equal(tl.readTimelineState(sid), undefined)
})

test("listTimelineStates finds only valid state files", () => {
  const sidA = "state_list_a"
  const sidB = "state_list_b"
  const bad = "state_list_bad"
  tl.writeTimelineState(sidA, { version: 1, failures: 1, pending: true, updatedAt: 1 })
  tl.writeTimelineState(sidB, { version: 1, failures: 0, pending: false, updatedAt: 2, cursor: { messageID: "m" } })
  tl.appendEntries("state_list_timeline", ["not state"], 1)
  writeFileSync(join(dir, bad + ".state.json"), "{broken")
  writeFileSync(join(dir, "bad name.state.json"), JSON.stringify({ version: 1, failures: 0, pending: false, updatedAt: 1 }))

  const listed = tl.listTimelineStates().filter((x) => x.sessionID.startsWith("state_list_"))
  const ids = listed.map((x) => x.sessionID).sort()
  assert.deepEqual(ids, [sidA, sidB])
  assert.equal(listed.find((x) => x.sessionID === sidA).state.pending, true)

  tl.removeTimelineState(sidA)
  tl.removeTimelineState(sidB)
  tl.removeEntries("state_list_timeline")
  rmSync(join(dir, bad + ".state.json"), { force: true })
  rmSync(join(dir, "bad name.state.json"), { force: true })
})

test("writeTimelineState leaves no temp file behind on success", () => {
  const sid = "state_tmp"
  tl.writeTimelineState(sid, { version: 1, failures: 0, pending: false, updatedAt: 1 })
  const temps = readdirSync(dir).filter((n) => n.includes(sid) && n.includes(".tmp"))
  assert.deepEqual(temps, [])
  tl.removeTimelineState(sid)
})
