import { strict as assert } from "node:assert"
import { test } from "node:test"

import { applyYoloPermissions, upgradePermissionValue } from "../src/lib/yolo-permissions.ts"

test("upgradePermissionValue upgrades scalar ask and preserves allow/deny", () => {
  assert.equal(upgradePermissionValue("ask"), true)
  assert.equal(upgradePermissionValue("allow"), false)
  assert.equal(upgradePermissionValue("deny"), false)
  assert.equal(upgradePermissionValue(42), false)
  assert.equal(upgradePermissionValue(null), false)
})

test("1. top-level scalar permission: \"ask\" -> becomes \"allow\", returns true", () => {
  const cfg = { permission: "ask" }
  assert.equal(applyYoloPermissions(cfg), true)
  assert.equal(cfg.permission, "allow")
})

test("2. top-level object upgrades ask, preserves deny, adds external_directory allow", () => {
  const cfg = { permission: { read: "ask", bash: "ask", edit: "deny" } }
  assert.equal(applyYoloPermissions(cfg), true)
  assert.deepEqual(cfg.permission, {
    read: "allow",
    bash: "allow",
    edit: "deny",
    external_directory: "allow",
  })
})

test("3. top-level pattern map upgrades * but preserves deny pattern", () => {
  const cfg = { permission: { bash: { "*": "ask", "rm -rf /*": "deny" } } }
  assert.equal(applyYoloPermissions(cfg), true)
  assert.deepEqual(cfg.permission, {
    bash: { "*": "allow", "rm -rf /*": "deny" },
    external_directory: "allow",
  })
})

test("4. existing external_directory pattern map is upgraded, not replaced wholesale", () => {
  const cfg = {
    permission: {
      external_directory: { "*": "ask", "/ok/*": "allow" },
    },
  }
  assert.equal(applyYoloPermissions(cfg), true)
  assert.deepEqual(cfg.permission.external_directory, { "*": "allow", "/ok/*": "allow" })
})

test("5. explicit external_directory: \"deny\" is preserved", () => {
  const cfg = { permission: { read: "ask", external_directory: "deny" } }
  assert.equal(applyYoloPermissions(cfg), true)
  assert.deepEqual(cfg.permission, {
    read: "allow",
    external_directory: "deny",
  })
})

test("6. per-agent permissions are upgraded, deny preserved, no external_directory injection", () => {
  const cfg = {
    agent: {
      build: { permission: { read: "ask", bash: "deny" } },
    },
  }
  assert.equal(applyYoloPermissions(cfg), true)
  assert.deepEqual(cfg.agent.build.permission, { read: "allow", bash: "deny" })
  assert.equal(Object.hasOwn(cfg.agent.build.permission, "external_directory"), false)
})

test("7. idempotent: first call returns true, second returns false", () => {
  const cfg = { permission: { read: "ask", edit: "deny" } }
  assert.equal(applyYoloPermissions(cfg), true)
  assert.equal(applyYoloPermissions(cfg), false)
  assert.deepEqual(cfg.permission, {
    read: "allow",
    edit: "deny",
    external_directory: "allow",
  })
})

test("8. applyYoloPermissions({}) sets permission.external_directory = \"allow\" and returns true", () => {
  const cfg = {}
  assert.equal(applyYoloPermissions(cfg), true)
  assert.deepEqual(cfg.permission, { external_directory: "allow" })
})

test("9. non-object/malformed input does not throw", () => {
  assert.doesNotThrow(() => applyYoloPermissions(null))
  assert.doesNotThrow(() => applyYoloPermissions([]))
  assert.doesNotThrow(() => applyYoloPermissions({ agent: { x: false } }))
  assert.doesNotThrow(() => applyYoloPermissions({ agent: [1, 2] }))
  assert.doesNotThrow(() => applyYoloPermissions({ permission: 123, agent: { build: { permission: null } } }))
  assert.equal(applyYoloPermissions(null), false)
  assert.equal(applyYoloPermissions([]), false)

  const malformed = { agent: { x: false, y: null, z: { permission: "ask" } } }
  assert.equal(applyYoloPermissions(malformed), true)
  assert.deepEqual(malformed.permission, { external_directory: "allow" })
  assert.equal(malformed.agent.z.permission, "allow")
})
