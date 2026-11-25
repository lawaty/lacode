export type PermissionAction = "ask" | "allow" | "deny"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * Upgrade every "ask" to "allow" in a permission config value, preserving
 * "deny" and everything else. Handles both the scalar form ("ask") and the
 * pattern-map object form ({ "*": "ask", ... }). Mutates objects in place.
 * Returns true if any value changed.
 */
export function upgradePermissionValue(value: unknown): boolean {
  if (value === "ask") return true
  if (!isPlainObject(value)) return false

  let changed = false
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (child === "ask") {
      value[key] = "allow"
      changed = true
    } else if (isPlainObject(child)) {
      if (upgradePermissionValue(child)) changed = true
    }
  }
  return changed
}

function upgradePermissionField(target: Record<string, unknown>, key: string, injectExternalDirectory: boolean): boolean {
  const p = target[key]
  let changed = false

  if (p === undefined) {
    if (injectExternalDirectory) {
      target[key] = { external_directory: "allow" }
      return true
    }
    return false
  }

  if (typeof p === "string") {
    if (p === "ask") {
      target[key] = "allow"
      changed = true
    }
    return changed
  }

  if (isPlainObject(p)) {
    if (upgradePermissionValue(p)) changed = true
    if (injectExternalDirectory && p.external_directory === undefined) {
      p.external_directory = "allow"
      changed = true
    }
  }

  return changed
}

/**
 * Apply YOLO permission relaxation to an OpenCode config object, in place.
 *
 * - Upgrades `cfg.permission` (scalar or object form): every "ask" -> "allow",
 *   "deny" preserved.
 * - If `cfg.permission` is an object and `external_directory` is undefined,
 *   sets `cfg.permission.external_directory = "allow"` (YOLO must not prompt
 *   for external directory access). If it is present, it is upgraded like any
 *   other rule (ask->allow, deny preserved).
 * - Upgrades every `cfg.agent[name].permission` the same way (do not inject
 *   external_directory per-agent; the global rule covers inheritance).
 * - Defensive: ignore null/non-object cfg, non-object agents, disabled agents,
 *   arrays, and unknown value shapes.
 * Returns true if anything changed.
 */
export function applyYoloPermissions(cfg: Record<string, unknown>): boolean {
  if (!isPlainObject(cfg)) return false

  let changed = upgradePermissionField(cfg, "permission", true)

  const agents = cfg.agent
  if (isPlainObject(agents)) {
    for (const value of Object.values(agents)) {
      if (!isPlainObject(value)) continue
      if (value.disable === true) continue
      if (value.permission === undefined) continue
      if (upgradePermissionField(value, "permission", false)) changed = true
    }
  }

  return changed
}
