// Host shim -- NOT the source of truth.
//
// This directory is the payload bin/oc-sync ships to a remote host, where
// opencode auto-discovers every file in plugins/ and calls every export of it
// as a plugin. It used to hold three thin shims, one per feature, but a feature
// shim never creates the agents and never injects the commands: both live in
// src/index.ts, so a host that loaded only the shims bound zero pool variants
// and had no /context-* commands. This one file re-exports the whole plugin,
// which is what the author's own machine loads from dist/index.js.
//
// A plugin file must export exactly one plugin, and it does.

export { default as LaCode } from "../src/index.ts"