// timer-migration: once-per-version install of the pool-refresh systemd user timer.
//
// Run with: node --test tests/timer-migration-test.mjs

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import {
  TIMER_MIGRATION_ENV,
  runTimerMigration,
  timerMigrationStatePath,
  timerMigrationUnitPath,
} from "../src/lib/timer-migration.ts"

const scratch = () => mkdtempSync(join(tmpdir(), "timer-migration-"))

const makeRun = (calls, options = {}) =>
  async (file, args) => {
    calls.push([file, ...args])
    if (file === "systemctl" && args[0] === "--user" && args[1] === "show-environment") return
    if (options.failInstall) throw new Error("install failed")
  }

test("disabled by LACODE_NO_TIMER_MIGRATION=1", async () => {
  const home = scratch()
  try {
    const calls = []
    const result = await runTimerMigration({
      env: { [TIMER_MIGRATION_ENV]: "1" },
      platform: "linux",
      version: "1.0.0",
      home,
      run: makeRun(calls),
    })
    assert.deepEqual(result, { action: "disabled" })
    assert.deepEqual(calls, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("disabled when NODE_TEST_CONTEXT is present", async () => {
  const home = scratch()
  try {
    const calls = []
    const result = await runTimerMigration({
      env: { NODE_TEST_CONTEXT: "1" },
      platform: "linux",
      version: "1.0.0",
      home,
      run: makeRun(calls),
    })
    assert.deepEqual(result, { action: "disabled" })
    assert.deepEqual(calls, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("skipped on non-linux with no exec calls", async () => {
  const home = scratch()
  try {
    const calls = []
    const result = await runTimerMigration({
      env: {},
      platform: "darwin",
      version: "1.0.0",
      home,
      run: makeRun(calls),
    })
    assert.deepEqual(result, { action: "skipped", reason: "not-linux" })
    assert.deepEqual(calls, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("skipped when the systemctl probe rejects", async () => {
  const home = scratch()
  try {
    const calls = []
    const run = async (file, args) => {
      calls.push([file, ...args])
      throw new Error("no systemd")
    }
    const result = await runTimerMigration({ env: {}, platform: "linux", version: "1.0.0", home, run })
    assert.deepEqual(result, { action: "skipped", reason: "no-systemd" })
    assert.deepEqual(calls, [["systemctl", "--user", "show-environment"]])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("up-to-date when the state version matches AND the timer unit exists", async () => {
  const home = scratch()
  try {
    const statePath = timerMigrationStatePath(home)
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ version: 1, timersVersion: "1.0.0" }) + "\n")

    const unitPath = timerMigrationUnitPath(home)
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, "[Unit]\n")

    const calls = []
    const result = await runTimerMigration({
      env: {},
      platform: "linux",
      version: "1.0.0",
      home,
      run: makeRun(calls),
    })
    assert.deepEqual(result, { action: "up-to-date", version: "1.0.0" })
    assert.deepEqual(calls, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("reinstalls when the stamp matches but the timer unit is missing", async () => {
  const home = scratch()
  try {
    const statePath = timerMigrationStatePath(home)
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ version: 1, timersVersion: "1.0.0" }) + "\n")

    const calls = []
    const result = await runTimerMigration({
      env: {},
      platform: "linux",
      version: "1.0.0",
      home,
      now: () => new Date("2026-11-06T12:00:00.000Z"),
      run: makeRun(calls),
    })
    assert.deepEqual(result, { action: "installed", version: "1.0.0" })

    assert.deepEqual(calls[0], ["systemctl", "--user", "show-environment"])

    const installer = calls.find((call) => call[0] === process.execPath)
    assert.ok(installer, "installer should be called via process.execPath")
    assert.ok(installer[1].endsWith(join("scripts", "refresh-pool.mjs")), installer[1])
    assert.deepEqual(installer.slice(2), ["--install-timer", "--stable"])

    const state = JSON.parse(readFileSync(statePath, "utf8"))
    assert.deepEqual(state, {
      version: 1,
      timersVersion: "1.0.0",
      installedAt: "2026-11-06T12:00:00.000Z",
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("failed install does not write the state file", async () => {
  const home = scratch()
  try {
    const calls = []
    const result = await runTimerMigration({
      env: {},
      platform: "linux",
      version: "1.0.0",
      home,
      run: makeRun(calls, { failInstall: true }),
    })
    assert.deepEqual(result, { action: "failed", version: "1.0.0", error: "install failed" })
    assert.equal(existsSync(timerMigrationStatePath(home)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("skipped when no version is known", async () => {
  const home = scratch()
  try {
    const calls = []
    const result = await runTimerMigration({
      env: {},
      platform: "linux",
      packageRoot: home,
      home,
      run: makeRun(calls),
    })
    assert.deepEqual(result, { action: "skipped", reason: "no-version" })
    assert.deepEqual(calls, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
