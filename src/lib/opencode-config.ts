import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function globalOpencodeConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const jsonc = join(base, "opencode", "opencode.jsonc")
  return existsSync(jsonc) ? jsonc : join(base, "opencode", "opencode.json")
}
