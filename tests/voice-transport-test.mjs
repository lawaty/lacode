import { test } from "node:test"
import assert from "node:assert/strict"
import { createVoiceServer, createVoiceClient } from "../src/voice/transport.ts"
import {
  createLineDecoder,
  decodeClientMessage,
  decodeDaemonMessage,
  encodeMessage,
} from "../src/voice/protocol.ts"

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond, timeout = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timeout")
    await delay(10)
  }
}

test("1. server starts on port 0 and reports a real port", async () => {
  const server = createVoiceServer({ port: 0 })
  const port = await server.start()
  assert.equal(typeof port, "number")
  assert.ok(port > 0)
  assert.equal(server.port, port)
  await server.stop()
})

test("2. client connects, sends hello, server onMessage receives it", async () => {
  const received = []
  const server = createVoiceServer({ port: 0, onMessage: (m, _meta) => received.push(m) })
  const port = await server.start()
  const client = createVoiceClient({ port, reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  const ok = client.send({ t: "hello", v: 1, client: "test" })
  assert.equal(ok, true)
  await waitFor(() => received.length > 0)
  assert.deepEqual(received[0], { t: "hello", v: 1, client: "test" })
  client.stop()
  await server.stop()
})

test("3. server broadcast transcript reaches client onMessage with exact text", async () => {
  const msgs = []
  const server = createVoiceServer({ port: 0 })
  const port = await server.start()
  const client = createVoiceClient({ port, onMessage: (m) => msgs.push(m), reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  server.broadcast({ t: "transcript", text: "hello world", source: "manual" })
  await waitFor(() => msgs.length > 0)
  assert.deepEqual(msgs[0], { t: "transcript", text: "hello world", source: "manual" })
  client.stop()
  await server.stop()
})

test("4. two clients receive broadcast; clientCount 1 -> 2 -> 0", async () => {
  const server = createVoiceServer({ port: 0 })
  const port = await server.start()
  const c1msgs = []
  const c2msgs = []
  const c1 = createVoiceClient({ port, onMessage: (m) => c1msgs.push(m), reconnectMs: 50 })
  const c2 = createVoiceClient({ port, onMessage: (m) => c2msgs.push(m), reconnectMs: 50 })
  c1.start()
  await waitFor(() => c1.connected)
  assert.equal(server.clientCount, 1)
  c2.start()
  await waitFor(() => c2.connected)
  assert.equal(server.clientCount, 2)
  server.broadcast({ t: "transcript", text: "x", source: "wake" })
  await waitFor(() => c1msgs.length > 0 && c2msgs.length > 0)
  c1.stop()
  await waitFor(() => server.clientCount === 1)
  c2.stop()
  await waitFor(() => server.clientCount === 0)
  assert.equal(server.clientCount, 0)
  await server.stop()
})

test("5. junk lines ignored and do not kill connection", async () => {
  const received = []
  const server = createVoiceServer({ port: 0, onMessage: (m, _meta) => received.push(m) })
  const port = await server.start()
  const net = await import("node:net")
  const sock = net.createConnection({ port, host: "127.0.0.1" })
  await new Promise((resolve) => sock.on("connect", resolve))
  sock.write("not json\n")
  sock.write('{"t":"nope"}\n')
  sock.write('{"t":"ping"}\n')
  await delay(100)
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], { t: "ping" })
  sock.destroy()
  await server.stop()
})

test("6. partial chunk split across two writes decoded once", () => {
  const decoder = createLineDecoder(decodeClientMessage)
  const first = decoder(Buffer.from('{"t":"ping"'))
  assert.deepEqual(first, [])
  const second = decoder(Buffer.from("}\n"))
  assert.equal(second.length, 1)
  assert.deepEqual(second[0], { t: "ping" })
})

test("7. client with no server: start no throw, connected false, reconnects", async () => {
  const PORT = 45123
  const client = createVoiceClient({ port: PORT, reconnectMs: 50 })
  let threw = false
  try {
    client.start()
  } catch {
    threw = true
  }
  assert.equal(threw, false)
  assert.equal(client.connected, false)
  const server = createVoiceServer({ port: PORT })
  await server.start()
  await waitFor(() => client.connected, 5000)
  assert.equal(client.connected, true)
  client.stop()
  await server.stop()
})

test("8. stop idempotent both sides", async () => {
  const server = createVoiceServer({ port: 0 })
  const port = await server.start()
  const client = createVoiceClient({ port, reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  client.stop()
  client.stop()
  await server.stop()
  await server.stop()
  assert.equal(client.connected, false)
})

test("9. server assigns distinct ids to two clients", async () => {
  const opened = []
  const seen = []
  const server = createVoiceServer({
    port: 0,
    onClientOpened: (id) => opened.push(id),
    onMessage: (m, meta) => seen.push({ m, meta }),
  })
  const port = await server.start()
  const c1 = createVoiceClient({ port, reconnectMs: 50 })
  const c2 = createVoiceClient({ port, reconnectMs: 50 })
  c1.start()
  await waitFor(() => c1.connected)
  c2.start()
  await waitFor(() => c2.connected)
  await waitFor(() => opened.length === 2)
  assert.equal(typeof opened[0], "number")
  assert.equal(typeof opened[1], "number")
  assert.notEqual(opened[0], opened[1])
  assert.equal(opened[0], 1)
  assert.equal(opened[1], 2)
  c1.send({ t: "hello", v: 1, client: "a" })
  c2.send({ t: "hello", v: 1, client: "b" })
  await waitFor(() => seen.length === 2)
  const ids = new Set(seen.map((entry) => entry.meta.id))
  assert.equal(ids.size, 2)
  assert.ok(ids.has(opened[0]))
  assert.ok(ids.has(opened[1]))
  c1.stop()
  c2.stop()
  await server.stop()
})

test("10. sendTo reaches only the addressed client", async () => {
  const opened = []
  const aMsgs = []
  const bMsgs = []
  const server = createVoiceServer({
    port: 0,
    onClientOpened: (id) => opened.push(id),
  })
  const port = await server.start()
  const c1 = createVoiceClient({ port, onMessage: (m) => aMsgs.push(m), reconnectMs: 50 })
  const c2 = createVoiceClient({ port, onMessage: (m) => bMsgs.push(m), reconnectMs: 50 })
  c1.start()
  await waitFor(() => c1.connected)
  c2.start()
  await waitFor(() => c2.connected)
  await waitFor(() => opened.length === 2)
  const idA = opened[0]
  const idB = opened[1]
  const ok = server.sendTo(idA, { t: "transcript", text: "for a", source: "manual" })
  assert.equal(ok, true)
  await waitFor(() => aMsgs.length === 1)
  assert.deepEqual(aMsgs[0], { t: "transcript", text: "for a", source: "manual" })
  await delay(150)
  assert.equal(bMsgs.length, 0)
  assert.equal(server.sendTo(idB, { t: "transcript", text: "for b", source: "wake" }), true)
  await waitFor(() => bMsgs.length === 1)
  assert.deepEqual(bMsgs[0], { t: "transcript", text: "for b", source: "wake" })
  assert.equal(aMsgs.length, 1)
  c1.stop()
  c2.stop()
  await server.stop()
})

test("11. sendTo unknown id returns false and does not throw", async () => {
  const server = createVoiceServer({ port: 0 })
  await server.start()
  let result
  assert.doesNotThrow(() => {
    result = server.sendTo(999, { t: "transcript", text: "nobody", source: "manual" })
  })
  assert.equal(result, false)
  await server.stop()
})

test("12. onClientClosed fires once and sendTo(closedId) returns false", async () => {
  const opened = []
  const closed = []
  const server = createVoiceServer({
    port: 0,
    onClientOpened: (id) => opened.push(id),
    onClientClosed: (id) => closed.push(id),
  })
  const port = await server.start()
  const client = createVoiceClient({ port, reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  await waitFor(() => opened.length === 1)
  const id = opened[0]
  client.stop()
  await waitFor(() => closed.length > 0)
  await delay(150)
  assert.deepEqual(closed, [id])
  assert.equal(server.sendTo(id, { t: "transcript", text: "gone", source: "manual" }), false)
  await server.stop()
})

test("13. claim is delivered with the sender's meta id", async () => {
  const opened = []
  const seen = []
  const server = createVoiceServer({
    port: 0,
    onClientOpened: (id) => opened.push(id),
    onMessage: (m, meta) => seen.push({ m, meta }),
  })
  const port = await server.start()
  const client = createVoiceClient({ port, reconnectMs: 50 })
  client.start()
  await waitFor(() => client.connected)
  await waitFor(() => opened.length === 1)
  assert.equal(client.send({ t: "claim" }), true)
  await waitFor(() => seen.length === 1)
  assert.deepEqual(seen[0].m, { t: "claim" })
  assert.equal(seen[0].meta.id, opened[0])
  assert.equal(typeof seen[0].meta.remote, "string")
  client.stop()
  await server.stop()
})

test("14. broadcast still reaches every client", async () => {
  const aMsgs = []
  const bMsgs = []
  const server = createVoiceServer({ port: 0 })
  const port = await server.start()
  const c1 = createVoiceClient({ port, onMessage: (m) => aMsgs.push(m), reconnectMs: 50 })
  const c2 = createVoiceClient({ port, onMessage: (m) => bMsgs.push(m), reconnectMs: 50 })
  c1.start()
  await waitFor(() => c1.connected)
  c2.start()
  await waitFor(() => c2.connected)
  await waitFor(() => server.clientCount === 2)
  server.broadcast({ t: "transcript", text: "everyone", source: "wake" })
  await waitFor(() => aMsgs.length === 1 && bMsgs.length === 1)
  assert.deepEqual(aMsgs[0], { t: "transcript", text: "everyone", source: "wake" })
  assert.deepEqual(bMsgs[0], { t: "transcript", text: "everyone", source: "wake" })
  c1.stop()
  c2.stop()
  await server.stop()
})
