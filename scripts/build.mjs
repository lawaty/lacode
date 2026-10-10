// The build.
//
// WHY IT EXISTS: the package used to ship raw TypeScript from `src/`, which is
// fine in a working tree and fatal in an installed one. Node strips types
// natively from 22.18, but it EXPLICITLY REFUSES to do that for files under
// node_modules — so `lacode --help` on a global install died with
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, and so would any
// `import "@lawaty/lacode"` from plain node. Bun (opencode itself is a Bun
// single-file executable) is happy to strip types inside node_modules, which is
// why the plugin half kept working and hid the defect. A package cannot depend
// on its consumer's loader being lenient, so the sources are compiled to plain
// JavaScript here and `dist/` is what ships.
//
// ONE BUNDLE PER ENTRY POINT, not one bundle plus chunks: every entry point is
// bundled on its own so the relative `.ts` import specifiers inside `src/` never
// need rewriting (`./lib/pool.ts` -> `./pool.js` is the kind of edit that rots
// the first time a file is added). The cost is that `dist/index.js` contains its
// own copy of the pool, the agents and the tunnel; that is a few tens of
// kilobytes and it buys entry points that resolve with zero resolution logic.
//
// The peer dependency and the node builtins stay EXTERNAL on purpose. Bundling
// `@opencode-ai/plugin` would put a SECOND copy of the SDK inside this package:
// opencode would then see two module instances, and instance identity is what
// plugin state and hook registration hang on. peerDependencies exist precisely
// so a peer is supplied by the host and never duplicated; inlining it would
// quietly defeat that.

import { builtinModules } from "node:module"
import { chmod, rm, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as esbuild from "esbuild"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Every published entry point, in the order the manifest declares them.
 *
 * `out` must match `exports` / `bin` in package.json exactly; `assertManifestIsBuilt`
 * fails the build loudly when the two drift, so a new subpath cannot be added to
 * the manifest without someone noticing it ships nothing.
 */
export const ENTRY_POINTS = [
  { subpath: ".", in: "src/index.ts", out: "dist/index.js" },
  { subpath: "./pool", in: "src/lib/pool.ts", out: "dist/pool.js" },
  { subpath: "./agents", in: "src/agents.ts", out: "dist/agents.js" },
  { subpath: "./commands", in: "src/commands.ts", out: "dist/commands.js" },
  { subpath: "./tunnel", in: "src/tunnel/index.ts", out: "dist/tunnel.js" },
  { subpath: "bin", in: "bin/lacode", out: "dist/lacode.js", executable: true },
]

/** Never inlined: the peer SDK the host provides, and everything node ships. */
export const EXTERNAL = [
  "@opencode-ai/plugin",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]

/**
 * Fail the build when package.json points at something that was not emitted.
 *
 * A dangling `exports` entry is the exact defect this build exists to remove, so
 * the build is also the place that makes it impossible to reintroduce silently.
 */
const assertManifestIsBuilt = async (manifest) => {
  const targets = [
    ...Object.values(manifest.exports ?? {}),
    ...Object.values(manifest.bin ?? {}),
  ]
  const missing = []
  for (const target of targets) {
    if (typeof target !== "string" || target === "./package.json") continue
    if (target.endsWith(".ts")) missing.push(`${target} (TypeScript; node refuses to strip types under node_modules)`)
    else if (!(await exists(join(ROOT, target)))) missing.push(`${target} (not built)`)
  }
  if (missing.length > 0) throw new Error(`package.json points at files the build does not produce:\n  ${missing.join("\n  ")}`)
}

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Build `dist/`. Exported so the test fixtures can build without shelling out. */
export const build = async ({ log = false } = {}) => {
  // Wipe first: a stale dist/index.js from a renamed source is worse than no
  // dist at all, because the manifest would happily resolve to it.
  await rm(join(ROOT, "dist"), { recursive: true, force: true })

  for (const entry of ENTRY_POINTS) {
    await esbuild.build({
      entryPoints: [join(ROOT, entry.in)],
      outfile: join(ROOT, entry.out),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: EXTERNAL,
      // esbuild hoists a leading `#!` to the top of the output on its own, so
      // dist/lacode.js keeps its shebang and stays directly executable.
      logLevel: log ? "info" : "silent",
    })
    // npm only guarantees the executable bit on `bin` targets at INSTALL time.
    // Setting it here means the tarball, a `git archive`, and a plain `cp -r` of
    // dist/ all carry a runnable CLI rather than one that needs a chmod first.
    if (entry.executable) await chmod(join(ROOT, entry.out), 0o755)
    if (log) console.log(`  ${entry.in} -> ${entry.out}`)
  }

  const { default: manifest } = await import(pathToFileURL(join(ROOT, "package.json")).href, { with: { type: "json" } })
  await assertManifestIsBuilt(manifest)
  return ENTRY_POINTS.map((entry) => entry.out)
}

// Run as `npm run build`, and also importable — `node --test tests/` builds the
// fixtures from the same function, so the tests and the tarball cannot disagree.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputs = await build({ log: true })
  console.log(`built ${outputs.length} entry points into dist/`)
}