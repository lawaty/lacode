// Package root discovery, split out of src/lib/pool.ts so a consumer that only
// needs the path -- the CLI, the self-updater -- does not pull the whole pool and
// its preset resolution into its bundle.
//
// Package root: the directory holding `presets/`, `bin/` and `package.json`.
//
// This module is `src/lib/package-root.ts` in a checkout -- two levels down --
// but the published package ships the very same code bundled into `dist/*.js`,
// one level down. A fixed "two levels up" hop therefore resolves to the
// package's PARENT once installed, the bundled preset is not found, and the pool
// falls through to FALLBACK_SLOTS -- still routing, still passing a test that
// only checks that routing happened, and quietly not the preset the user
// installed. So walk up to the manifest that names this package instead of
// counting directories, which is correct from any depth; the old hop is the last
// resort for a `dist/` copied somewhere with no manifest above it.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE_NAME = "@lawaty/lacode"

export const findPackageRoot = (start: string): string => {
  let dir = start
  for (let up = 0; up < 6; up++) {
    try {
      if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === PACKAGE_NAME) return dir
    } catch {
      // No manifest, or one that is not ours: keep walking.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(start, "..", "..")
}

export const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)))
