import * as nodeNet from "node:net"
import { createLineDecoder } from "./protocol.ts"
import { decodeClientMessage, decodeDaemonMessage, encodeMessage } from "./protocol.ts"
import type { ClientMessage, DaemonMessage } from "./protocol.ts"

export type ServerDeps = { net?: typeof import("node:net") }
export type ClientMeta = { id: number; remote: string }
export type VoiceServer = {
  start(): Promise<number>
  stop(): Promise<void>
  broadcast(message: DaemonMessage): void
  sendTo(id: number, message: DaemonMessage): boolean
  readonly clientCount: number
  readonly port: number | undefined
}

type ClientRecord = {
  id: number
  remote: string
  socket: nodeNet.Socket
  closed: boolean
}

export function createVoiceServer(
  options: {
    port?: number
    host?: string
    onMessage?: (message: ClientMessage, meta: ClientMeta) => void
    onClientCount?: (count: number) => void
    onClientClosed?: (id: number) => void
    onClientOpened?: (id: number) => void
  },
  deps?: ServerDeps,
): VoiceServer {
  const portOpt = options.port ?? 0
  const host = options.host ?? "127.0.0.1"
  const onMessage = options.onMessage
  const onClientCount = options.onClientCount
  const onClientClosed = options.onClientClosed
  const onClientOpened = options.onClientOpened
  const netMod = (deps && deps.net) ? deps.net : nodeNet

  const clients = new Map<number, ClientRecord>()
  let nextClientId = 1
  let server: nodeNet.Server | undefined
  let boundPort: number | undefined
  let started = false
  let stopped = false

  const closeClient = (client: ClientRecord): void => {
    if (client.closed) return
    client.closed = true
    if (clients.delete(client.id)) {
      try {
        onClientCount?.(clients.size)
      } catch {}
    }
    try {
      onClientClosed?.(client.id)
    } catch {}
  }

  const broadcast = (message: DaemonMessage): void => {
    try {
      const data = encodeMessage(message)
      for (const client of [...clients.values()]) {
        try {
          const sock = client.socket
          if (sock && !sock.destroyed && sock.writable) {
            sock.write(data)
          }
        } catch {}
      }
    } catch {}
  }

  const sendTo = (id: number, message: DaemonMessage): boolean => {
    try {
      const client = clients.get(id)
      if (!client || client.closed) return false
      const sock = client.socket
      if (!sock || sock.destroyed || !sock.writable) return false
      sock.write(encodeMessage(message))
      return true
    } catch {
      return false
    }
  }

  const voiceServer: VoiceServer = {
    get clientCount(): number {
      return clients.size
    },
    get port(): number | undefined {
      return boundPort
    },
    start(): Promise<number> {
      if (started) {
        return Promise.resolve(boundPort !== undefined ? boundPort : portOpt)
      }
      started = true
      return new Promise<number>((resolve, reject) => {
        let srv: nodeNet.Server
        try {
          srv = netMod.createServer((sock: nodeNet.Socket) => {
            const client: ClientRecord = {
              id: nextClientId++,
              remote: sock.remoteAddress ?? "",
              socket: sock,
              closed: false,
            }
            clients.set(client.id, client)
            try {
              onClientCount?.(clients.size)
            } catch {}
            try {
              onClientOpened?.(client.id)
            } catch {}
            const decoder = createLineDecoder(decodeClientMessage)
            sock.on("data", (chunk: Buffer) => {
              try {
                const msgs = decoder(chunk)
                for (const m of msgs) {
                  try {
                    onMessage?.(m, { id: client.id, remote: client.remote })
                  } catch {}
                }
              } catch {}
            })
            sock.on("close", () => {
              closeClient(client)
            })
            sock.on("error", () => {
              try {
                sock.destroy()
              } catch {}
              closeClient(client)
            })
          })
        } catch (err) {
          reject(err as Error)
          return
        }
        server = srv
        srv.once("error", (err: Error) => {
          reject(err)
        })
        try {
          srv.listen(portOpt, host, () => {
            const addr = srv.address()
            if (addr && typeof addr === "object") {
              boundPort = (addr as nodeNet.AddressInfo).port
            } else {
              boundPort = portOpt
            }
            resolve(boundPort as number)
          })
        } catch (err) {
          reject(err as Error)
        }
      })
    },
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      for (const client of [...clients.values()]) {
        try {
          client.socket.destroy()
        } catch {}
      }
      clients.clear()
      const srv = server
      server = undefined
      if (srv) {
        await new Promise<void>((resolve) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            resolve()
          }
          try {
            srv.close(() => finish())
          } catch {
            finish()
            return
          }
          setTimeout(finish, 1000).unref?.()
        })
      }
      boundPort = undefined
      try {
        onClientCount?.(0)
      } catch {}
    },
    broadcast,
    sendTo,
  }

  return voiceServer
}

export type ClientDeps = { net?: typeof import("node:net") }
export type VoiceClient = {
  start(): void
  stop(): void
  send(message: ClientMessage): boolean
  readonly connected: boolean
}

export function createVoiceClient(
  options: {
    port?: number
    host?: string
    onMessage?: (message: DaemonMessage) => void
    onConnectionChange?: (connected: boolean) => void
    reconnectMs?: number
  },
  deps?: ClientDeps,
): VoiceClient {
  const port = options.port ?? 8765
  const host = options.host ?? "127.0.0.1"
  const onMessage = options.onMessage
  const onConnectionChange = options.onConnectionChange
  const reconnectMs = options.reconnectMs ?? 2000
  const netMod = (deps && deps.net) ? deps.net : nodeNet

  let socket: nodeNet.Socket | undefined
  let connected = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let decoder = createLineDecoder(decodeDaemonMessage)

  const setConnected = (value: boolean): void => {
    if (connected === value) return
    connected = value
    try {
      onConnectionChange?.(value)
    } catch {}
  }

  const scheduleReconnect = (): void => {
    if (stopped) return
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      connect()
    }, reconnectMs)
    try {
      timer.unref?.()
    } catch {}
  }

  const connect = (): void => {
    if (stopped) return
    if (socket && !socket.destroyed) return
    decoder = createLineDecoder(decodeDaemonMessage)
    let sock: nodeNet.Socket
    try {
      sock = netMod.createConnection({ port, host })
    } catch {
      socket = undefined
      scheduleReconnect()
      return
    }
    socket = sock
    sock.on("connect", () => {
      setConnected(true)
    })
    sock.on("data", (chunk: Buffer) => {
      try {
        const msgs = decoder(chunk)
        for (const m of msgs) {
          try {
            onMessage?.(m)
          } catch {}
        }
      } catch {}
    })
    sock.on("close", () => {
      socket = undefined
      setConnected(false)
      scheduleReconnect()
    })
    sock.on("error", () => {
      setConnected(false)
      try {
        sock.destroy()
      } catch {}
      socket = undefined
      scheduleReconnect()
    })
  }

  const client: VoiceClient = {
    get connected(): boolean {
      return connected
    },
    start(): void {
      stopped = false
      connect()
    },
    stop(): void {
      if (stopped && !socket && !timer) {
        // still ensure
      }
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (socket) {
        try {
          socket.destroy()
        } catch {}
        socket = undefined
      }
      setConnected(false)
    },
    send(message: ClientMessage): boolean {
      try {
        if (stopped) return false
        if (!socket || socket.destroyed || !socket.writable) return false
        if (!connected) return false
        socket.write(encodeMessage(message))
        return true
      } catch {
        return false
      }
    },
  }

  return client
}
