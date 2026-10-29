import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveVoiceConfig, VOICE_CONFIG_PATH, VOICE_DATA_DIR } from "../src/voice/config.ts"

test("1. all defaults when nothing exists", () => {
  const cfg = resolveVoiceConfig({ env: {}, home: "/tmp/fakehome", readFile: () => null })
  assert.equal(cfg.wakeSensitivity, 0.5)
  assert.equal(cfg.port, 8765)
  assert.equal(cfg.host, "127.0.0.1")
  assert.equal(cfg.model, "whisper-large-v3-turbo")
  assert.equal(cfg.language, "en")
  assert.equal(cfg.armOnStart, true)
  assert.equal(cfg.sampleRate, 16000)
  assert.equal(cfg.wakeEngine, "vosk")
  assert.equal(cfg.voskModelPath, "/tmp/fakehome/.local/share/lacode/voice/vosk-model-small-en-us-0.15")
  assert.deepEqual(cfg.wakePhrases, ["hey la code"])
  assert.equal(cfg.groqKey, undefined)
  assert.equal(cfg.picovoiceKey, undefined)
  assert.equal(cfg.wakeWordPath, undefined)
  assert.equal(cfg.input, undefined)
})

test("2. env overrides file for port/model/language", () => {
  const file = JSON.stringify({ port: 1234, model: "file-model", language: "fr" })
  const cfg = resolveVoiceConfig({
    env: { LACODE_VOICE_PORT: "9999", LACODE_VOICE_MODEL: "env-model", LACODE_VOICE_LANGUAGE: "de" },
    home: "/tmp/fakehome",
    readFile: (p) => file,
  })
  assert.equal(cfg.port, 9999)
  assert.equal(cfg.model, "env-model")
  assert.equal(cfg.language, "de")
})

test("3. LACODE_VOICE_NO_ARM=1 forces armOnStart false even when file says true", () => {
  const file = JSON.stringify({ armOnStart: true })
  const cfg = resolveVoiceConfig({
    env: { LACODE_VOICE_NO_ARM: "1" },
    home: "/tmp/fakehome",
    readFile: (p) => file,
  })
  assert.equal(cfg.armOnStart, false)
})

test("4. sensitivity clamps", () => {
  const mk = (v) => resolveVoiceConfig({
    env: { LACODE_WAKE_SENSITIVITY: String(v) },
    home: "/tmp/fakehome",
    readFile: () => null,
  })
  assert.equal(mk(5).wakeSensitivity, 1)
  assert.equal(mk(-1).wakeSensitivity, 0)
  assert.equal(resolveVoiceConfig({ env: { LACODE_WAKE_SENSITIVITY: "abc" }, home: "/tmp/fakehome", readFile: () => null }).wakeSensitivity, 0.5)
})

test("5. invalid port -> 8765", () => {
  for (const v of [0, 70000, "abc"]) {
    const cfg = resolveVoiceConfig({
      env: { LACODE_VOICE_PORT: String(v) },
      home: "/tmp/fakehome",
      readFile: () => null,
    })
    assert.equal(cfg.port, 8765, `port ${v}`)
  }
  // also JSON invalid
  const cfg2 = resolveVoiceConfig({
    env: {},
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ port: 0 }),
  })
  assert.equal(cfg2.port, 8765)
})

test("6. wakeWordPath expands ~/ against fake home", () => {
  const file = JSON.stringify({ wakeWordPath: "~/x.ppn" })
  const cfg = resolveVoiceConfig({
    env: {},
    home: "/tmp/fakehome",
    readFile: (p) => file,
  })
  assert.equal(cfg.wakeWordPath, "/tmp/fakehome/x.ppn")
})

test("7. malformed JSON and array yield defaults without throwing", () => {
  const c1 = resolveVoiceConfig({ env: {}, home: "/tmp/fakehome", readFile: () => "{bad" })
  assert.equal(c1.port, 8765)
  assert.equal(c1.model, "whisper-large-v3-turbo")
  const c2 = resolveVoiceConfig({ env: {}, home: "/tmp/fakehome", readFile: () => "[1,2,3]" })
  assert.equal(c2.port, 8765)
  assert.equal(c2.model, "whisper-large-v3-turbo")
})

test("8. groqKey resolves from env then file", () => {
  // env
  const c1 = resolveVoiceConfig({
    env: { GROQ_KEY: "envkey" },
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ groqKey: "filekey" }),
  })
  assert.equal(c1.groqKey, "envkey")
  assert.equal(c1.groqSource, "env")
  // file
  const c2 = resolveVoiceConfig({
    env: {},
    home: "/tmp/fakehome",
    readFile: (p) => {
      if (p.endsWith("voice.json")) return JSON.stringify({ groqKey: "filekey" })
      return null
    },
  })
  assert.equal(c2.groqKey, "filekey")
  assert.equal(c2.groqSource, "file")
})

test("9. missing readFile throwing does not propagate", () => {
  const cfg = resolveVoiceConfig({
    env: {},
    home: "/tmp/fakehome",
    readFile: () => { throw new Error("boom") },
  })
  assert.equal(cfg.port, 8765)
  assert.equal(cfg.model, "whisper-large-v3-turbo")
})

test("10. XDG_DATA_HOME moves the default Vosk model directory", () => {
  const env = { XDG_DATA_HOME: "/tmp/xdg" }
  assert.equal(VOICE_DATA_DIR({ env, home: "/tmp/fakehome" }), "/tmp/xdg/lacode/voice")
  const cfg = resolveVoiceConfig({ env, home: "/tmp/fakehome", readFile: () => null })
  assert.equal(cfg.voskModelPath, "/tmp/xdg/lacode/voice/vosk-model-small-en-us-0.15")
})

test("11. LACODE_WAKE_ENGINE=porcupine wins over the JSON value", () => {
  const cfg = resolveVoiceConfig({
    env: { LACODE_WAKE_ENGINE: "porcupine" },
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ wakeEngine: "vosk" }),
  })
  assert.equal(cfg.wakeEngine, "porcupine")
})

test("12. invalid engine value falls back to vosk", () => {
  const fromEnv = resolveVoiceConfig({
    env: { LACODE_WAKE_ENGINE: "nope" },
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ wakeEngine: "porcupine" }),
  })
  assert.equal(fromEnv.wakeEngine, "vosk")
  const fromJson = resolveVoiceConfig({
    env: {},
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ wakeEngine: "nope" }),
  })
  assert.equal(fromJson.wakeEngine, "vosk")
})

test("13. LACODE_WAKE_PHRASES trims entries and drops empty ones", () => {
  const cfg = resolveVoiceConfig({
    env: { LACODE_WAKE_PHRASES: "hey lacode, hey la code, ,  " },
    home: "/tmp/fakehome",
    readFile: () => null,
  })
  assert.deepEqual(cfg.wakePhrases, ["hey lacode", "hey la code"])
})

test("14. wakePhrases JSON array keeps only non-empty strings", () => {
  const cfg = resolveVoiceConfig({
    env: {},
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ wakePhrases: [" hey lacode ", "", 42, "hey la code"] }),
  })
  assert.deepEqual(cfg.wakePhrases, ["hey lacode", "hey la code"])
})

test("15. voskModelPath expands ~/ against fake home", () => {
  const fromJson = resolveVoiceConfig({
    env: {},
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ voskModelPath: "~/m" }),
  })
  assert.equal(fromJson.voskModelPath, "/tmp/fakehome/m")
  const fromEnv = resolveVoiceConfig({
    env: { LACODE_VOSK_MODEL: "~/n" },
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ voskModelPath: "~/m" }),
  })
  assert.equal(fromEnv.voskModelPath, "/tmp/fakehome/n")
})

test("16. default wakePhrases is exactly ['hey la code'] and env still overrides", () => {
  const defaults = resolveVoiceConfig({ env: {}, home: "/tmp/fakehome", readFile: () => null })
  assert.deepEqual(defaults.wakePhrases, ["hey la code"])
  const overridden = resolveVoiceConfig({
    env: { LACODE_WAKE_PHRASES: "hey lacode, hey there" },
    home: "/tmp/fakehome",
    readFile: () => null,
  })
  assert.deepEqual(overridden.wakePhrases, ["hey lacode", "hey there"])
})

test("17. non-loopback host without opt-in resolves to 127.0.0.1 (env)", () => {
  const cfg = resolveVoiceConfig({
    env: { LACODE_VOICE_HOST: "0.0.0.0" },
    home: "/tmp/fakehome",
    readFile: () => null,
  })
  assert.equal(cfg.host, "127.0.0.1")
})

test("18. non-loopback host without opt-in resolves to 127.0.0.1 (json)", () => {
  const cfg = resolveVoiceConfig({
    env: {},
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ host: "192.168.1.5" }),
  })
  assert.equal(cfg.host, "127.0.0.1")
})

test("19. non-loopback host WITH opt-in (env) is kept", () => {
  const cfg = resolveVoiceConfig({
    env: { LACODE_VOICE_HOST: "0.0.0.0", LACODE_VOICE_ALLOW_NONLOCAL: "1" },
    home: "/tmp/fakehome",
    readFile: () => null,
  })
  assert.equal(cfg.host, "0.0.0.0")
})

test("20. non-loopback host WITH opt-in (json) is kept", () => {
  const cfg = resolveVoiceConfig({
    env: {},
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ host: "192.168.1.5", allowNonLocal: true }),
  })
  assert.equal(cfg.host, "192.168.1.5")
})

test("21. loopback hosts are kept without opt-in", () => {
  for (const h of ["127.0.0.1", "::1", "localhost"]) {
    const cfg = resolveVoiceConfig({
      env: {},
      home: "/tmp/fakehome",
      readFile: () => JSON.stringify({ host: h }),
    })
    assert.equal(cfg.host, h, h)
  }
})

test("22. empty LACODE_WAKE_ENGINE does not override JSON", () => {
  const cfg = resolveVoiceConfig({
    env: { LACODE_WAKE_ENGINE: "   " },
    home: "/tmp/fakehome",
    readFile: () => JSON.stringify({ wakeEngine: "porcupine" }),
  })
  assert.equal(cfg.wakeEngine, "porcupine")
})

test("VOICE_CONFIG_PATH", () => {
  assert.equal(VOICE_CONFIG_PATH("/tmp/fakehome"), "/tmp/fakehome/.config/lacode/voice.json")
})
