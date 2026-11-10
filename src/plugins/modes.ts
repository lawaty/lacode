import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { readModes, recommendedAnswer, seedModes, YKB_INSTRUCTION, type ModeDefaults } from "../lib/modes.ts"

type ModesOptions = { yolo?: boolean; ykb?: boolean }

export async function modesHooks(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const opts = (options ?? {}) as ModesOptions
  const defaults: ModeDefaults = {}
  if (typeof opts.yolo === "boolean") defaults.yolo = opts.yolo
  if (typeof opts.ykb === "boolean") defaults.ykb = opts.ykb
  seedModes(defaults)

  const state = () => readModes(defaults)
  const warn = (message: string) => {
    input.client.app.log({ body: { service: "modes", level: "warn", message } }).catch(() => {})
  }

  return {
    "permission.ask": async (_permission, output) => {
      if (!state().yolo) return
      if (output.status === "ask") output.status = "allow"
    },

    event: async ({ event }) => {
      if (event.type === "permission.asked") {
        if (!state().yolo) return
        const properties = event.properties as { id?: unknown; sessionID?: unknown }
        const requestID = typeof properties?.id === "string" ? properties.id : ""
        const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : ""
        if (!requestID || !sessionID) return
        try {
          await input.client.postSessionIdPermissionsPermissionId({
            path: { id: sessionID, permissionID: requestID },
            body: { response: "once" },
          })
        } catch (error) {
          warn(`could not auto-approve permission ${requestID}: ${String(error)}`)
        }
        return
      }

      if (event.type === "question.asked") {
        if (!state().ykb) return
        const properties = event.properties as { id?: unknown; questions?: unknown }
        const requestID = typeof properties?.id === "string" ? properties.id : ""
        const questions = Array.isArray(properties?.questions) ? properties.questions : []
        if (!requestID || questions.length === 0) return
        const answers = questions.map((question) => recommendedAnswer(question))
        if (!answers.some((answer) => answer.length > 0)) {
          warn(`question ${requestID} has no options to choose from; leaving it for the user`)
          return
        }
        try {
          await input.client.question.reply({ requestID, answers })
        } catch (error) {
          warn(`could not auto-answer question ${requestID}: ${String(error)}`)
        }
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (!state().ykb) return
      if (!Array.isArray(output?.system)) return
      if (!output.system.includes(YKB_INSTRUCTION)) output.system.push(YKB_INSTRUCTION)
    },
  }
}
