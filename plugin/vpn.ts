import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"

type ServerType = "http" | "socks5" | "direct" | "command"

type ServerConfig = {
  name?: string
  type?: ServerType
  enabled?: boolean
  host?: string
  port?: number
  url?: string
  start?: string[]
  stop?: string[]
  waitPort?: number
  waitHost?: string
  waitMs?: number
}

type VpnOptions = {
  enabled?: boolean
  listenHost?: string
  listenPort?: number
  rotateMinutes?: number
  connectTimeoutMs?: number
  healthCheckUrl?: string
  strict?: boolean
  rewriteProviders?: boolean
  excludeProviders?: string[]
  exportEnv?: boolean
  noProxy?: string[]
  servers?: ServerConfig[]
}

type Upstream = {
  name: string
  kind: "http" | "socks5" | "direct" | "blocked"
  host: string
  port: number
  user?: string
  pass?: string
}

type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

type ProviderConfig = { options?: Record<string, any> }
type ConfigLike = { provider?: Record<string, ProviderConfig | undefined> }

const PREFIX = "/p/"
const DEFAULT_NO_PROXY = ["localhost", "127.0.0.1", "::1", "10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12"]
const CONFIG_FILE =
  process.env.OPENCODE_VPN_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", "vpn.json")

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function readOptions(): VpnOptions {
  try {
    const text = fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "")
    return JSON.parse(text) as VpnOptions
  } catch {
    return {}
  }
}

function isLocalHost(host: string) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (["localhost", "0.0.0.0", "::1", "::"].includes(name) || name.endsWith(".local")) return true
  if (/^127\./.test(name) || /^10\./.test(name) || /^192\.168\./.test(name) || /^169\.254\./.test(name)) return true
  const match = /^172\.(\d+)\./.exec(name)
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31)
}

function directConnect(host: string, port: number, timeout: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    socket.setNoDelay(true)
    socket.on("error", () => {})
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timeout connecting ${host}:${port}`))
    }, timeout)
    socket.once("connect", () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function secureConnect(socket: net.Socket, host: string, timeout: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host })
    secure.setNoDelay(true)
    secure.on("error", () => {})
    const timer = setTimeout(() => {
      secure.destroy()
      reject(new Error(`tls timeout ${host}`))
    }, timeout)
    secure.once("secureConnect", () => {
      clearTimeout(timer)
      resolve(secure)
    })
    secure.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

class Reader {
  private chunks: Buffer[] = []
  private length = 0
  private error: Error | null = null
  private ended = false
  private waiter: (() => void) | null = null
  private socket: net.Socket

  constructor(socket: net.Socket) {
    this.socket = socket
    socket.on("data", this.onData)
    socket.on("error", this.onError)
    socket.on("close", this.onClose)
  }

  private onData = (chunk: Buffer) => {
    this.chunks.push(chunk)
    this.length += chunk.length
    this.wake()
  }

  private onError = (err: Error) => {
    this.error = err
    this.wake()
  }

  private onClose = () => {
    this.ended = true
    this.wake()
  }

  private wake() {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }

  async take(size: number): Promise<Buffer> {
    while (this.length < size) {
      if (this.error) throw this.error
      if (this.ended) throw new Error("connection closed")
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
    const all = Buffer.concat(this.chunks, this.length)
    const out = all.subarray(0, size)
    const rest = all.subarray(size)
    this.chunks = rest.length ? [rest] : []
    this.length = rest.length
    return out
  }

  detach(): Buffer {
    this.socket.off("data", this.onData)
    this.socket.off("error", this.onError)
    this.socket.off("close", this.onClose)
    return Buffer.concat(this.chunks, this.length)
  }
}

async function socks5Connect(upstream: Upstream, host: string, port: number, timeout: number): Promise<net.Socket> {
  const socket = await directConnect(upstream.host, upstream.port, timeout)
  const reader = new Reader(socket)
  const fail = (message: string): never => {
    socket.destroy()
    throw new Error(message)
  }
  const auth = upstream.user
    ? Buffer.concat([
        Buffer.from([1, Buffer.byteLength(upstream.user)]),
        Buffer.from(upstream.user, "utf8"),
        Buffer.from([Buffer.byteLength(upstream.pass || "")]),
        Buffer.from(upstream.pass || "", "utf8"),
      ])
    : null

  socket.write(auth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]))
  const greeting = await reader.take(2)
  if (greeting[0] !== 5) fail("socks5: bad version")
  if (greeting[1] === 0xff) fail("socks5: no acceptable auth method")
  if (greeting[1] === 2) {
    if (!auth) fail("socks5: auth required")
    socket.write(auth!)
    const reply = await reader.take(2)
    if (reply[1] !== 0) fail("socks5: auth failed")
  }

  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  const address = ipv4
    ? Buffer.concat([Buffer.from([1]), Buffer.from(host.split(".").map(Number))])
    : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host, "utf8")])
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 0xff])]))

  const head = await reader.take(4)
  if (head[0] !== 5 || head[1] !== 0) fail(`socks5: connect failed (${head[1]})`)
  if (head[3] === 1) await reader.take(4 + 2)
  else if (head[3] === 4) await reader.take(16 + 2)
  else if (head[3] === 3) {
    const [size] = await reader.take(1)
    await reader.take(size + 2)
  } else fail("socks5: bad address type")

  const leftover = reader.detach()
  if (leftover.length) socket.unshift(leftover)
  return socket
}

async function httpProxyConnect(upstream: Upstream, host: string, port: number, timeout: number): Promise<net.Socket> {
  const socket = await directConnect(upstream.host, upstream.port, timeout)
  const reader = new Reader(socket)
  const auth = upstream.user
    ? `Proxy-Authorization: Basic ${Buffer.from(`${upstream.user}:${upstream.pass || ""}`).toString("base64")}\r\n`
    : ""
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`)

  let head = ""
  while (!head.includes("\r\n\r\n")) {
    if (head.length > 16384) {
      socket.destroy()
      throw new Error("http proxy: header too large")
    }
    head += (await reader.take(1)).toString("latin1")
  }
  const leftover = reader.detach()
  if (!/^HTTP\/1\.[01] 200/.test(head)) {
    socket.destroy()
    throw new Error(`http proxy: ${host}:${port} -> ${head.split("\r\n")[0]}`)
  }
  if (leftover.length) socket.unshift(leftover)
  return socket
}

function splitHostPort(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    return { host: trimmed.slice(1, end), port: Number(trimmed.slice(end + 2)) || 443 }
  }
  const index = trimmed.lastIndexOf(":")
  if (index === -1) return { host: trimmed, port: 443 }
  return { host: trimmed.slice(0, index), port: Number(trimmed.slice(index + 1)) || 443 }
}

function rebuildHead(head: string, method: string, target: string, hostHeader: string) {
  const lines = head
    .split("\r\n")
    .slice(1)
    .filter((line) => line.length > 0 && !/^(host|proxy-connection|proxy-authorization|connection):/i.test(line))
  lines.unshift(`Host: ${hostHeader}`, "Connection: keep-alive")
  return `${method} ${target} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`
}

function bridge(client: net.Socket, upstream: net.Socket) {
  client.pipe(upstream)
  upstream.pipe(client)
  const close = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on("close", close)
  upstream.on("close", close)
  client.on("error", close)
  upstream.on("error", close)
}

function readHead(socket: net.Socket, limit: number, timeout: number) {
  return new Promise<{ head: string; leftover: Buffer }>((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = () => {
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
      clearTimeout(timer)
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > limit) {
        cleanup()
        socket.destroy()
        reject(new Error("request header too large"))
        return
      }
      const index = buffer.indexOf("\r\n\r\n")
      if (index === -1) return
      cleanup()
      resolve({ head: buffer.subarray(0, index + 4).toString("latin1"), leftover: buffer.subarray(index + 4) })
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new Error("connection closed before request"))
    }
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new Error("timeout reading request"))
    }, timeout)
    socket.on("data", onData)
    socket.on("error", onError)
    socket.on("close", onClose)
  })
}

function readAll(socket: net.Socket, timeout: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const cleanup = () => {
      socket.off("data", onData)
      socket.off("end", onEnd)
      socket.off("close", onEnd)
      socket.off("error", onError)
      clearTimeout(timer)
    }
    const onData = (chunk: Buffer) => chunks.push(chunk)
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new Error("timeout reading response"))
    }, timeout)
    socket.on("data", onData)
    socket.on("end", onEnd)
    socket.on("close", onEnd)
    socket.on("error", onError)
  })
}

function bodyOf(raw: Buffer) {
  const text = raw.toString("latin1")
  const index = text.indexOf("\r\n\r\n")
  if (index === -1) return ""
  const head = text.slice(0, index)
  let body = raw.subarray(index + 4)
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    const parts: Buffer[] = []
    let rest = body
    while (rest.length) {
      const lineEnd = rest.indexOf("\r\n")
      if (lineEnd === -1) break
      const size = parseInt(rest.subarray(0, lineEnd).toString("latin1").split(";")[0], 16)
      if (!size) break
      parts.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size))
      rest = rest.subarray(lineEnd + 4 + size)
    }
    body = Buffer.concat(parts)
  } else {
    const match = /content-length:\s*(\d+)/i.exec(head)
    if (match) body = body.subarray(0, Number(match[1]))
  }
  return body.toString("utf8")
}

function uptime(ms: number) {
  if (!ms) return "-"
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

class Vpn {
  private options: VpnOptions
  private servers: ServerConfig[]
  host: string
  port: number
  private timeout: number
  private rotateMs: number
  private healthUrl: string
  private noProxy: string[]
  enabled: boolean
  private savedEnv: Record<string, string | undefined> | null = null
  private server: net.Server | null = null
  private command: ChildProcess | null = null
  private activeConfig: ServerConfig | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private rotating = false
  private index = -1
  private upstream: Upstream | null = null
  private activeName = "direct"
  private activeSince = 0
  private exitIp = ""
  private lastError = ""

  private log: Logger

  constructor(options: VpnOptions, log: Logger) {
    this.options = options
    this.log = log
    this.servers = (options.servers || []).filter((entry) => entry.enabled !== false)
    this.host = options.listenHost || "127.0.0.1"
    this.port = options.listenPort || 7899
    this.timeout = options.connectTimeoutMs || 15000
    this.rotateMs = Math.max(1, options.rotateMinutes ?? 60) * 60000
    this.healthUrl = options.healthCheckUrl || "https://api.ipify.org"
    this.noProxy = options.noProxy?.length ? options.noProxy : DEFAULT_NO_PROXY
    this.enabled = options.enabled ?? true
    const flag = process.env.OPENCODE_VPN
    if (flag !== undefined) this.enabled = !/^(0|false|no|off)$/i.test(flag)
  }

  async start() {
    if (!this.enabled) {
      this.log("info", "vpn disabled")
      return
    }
    if (!this.servers.length) {
      this.enabled = false
      this.log("warn", `vpn: no local proxy endpoints configured in ${CONFIG_FILE}, plugin idle`)
      return
    }
    await this.bind()
    if (!this.enabled) return
    this.applyProcessEnv()
    void this.rotate()
  }

  async stop() {
    this.enabled = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.stopActive()
    this.restoreProcessEnv()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  status() {
    const lines = [
      `vpn: ${this.enabled ? "on" : "off"}`,
      `proxy: http://${this.host}:${this.port}`,
      `server: ${this.activeName}${this.upstream ? ` (${this.upstream.kind})` : ""}`,
      `exit ip: ${this.exitIp || "unknown"}`,
      `active for: ${this.activeSince ? uptime(Date.now() - this.activeSince) : "-"}`,
      `rotate every: ${Math.round(this.rotateMs / 60000)} min`,
      `pool: ${this.servers.length} server(s)`,
    ]
    if (this.lastError) lines.push(`last error: ${this.lastError}`)
    if (this.servers.length) {
      lines.push("", "servers:")
      this.servers.forEach((server, index) => {
        const mark = index === this.index && this.enabled ? "*" : " "
        lines.push(` ${mark} ${this.nameOf(server, index)} [${this.typeOf(server)}]`)
      })
    }
    return lines.join("\n")
  }

  serversList() {
    if (!this.servers.length) return `no servers configured in ${CONFIG_FILE}`
    return this.servers
      .map((server, index) => {
        const name = this.nameOf(server, index)
        const target =
          server.url ||
          (server.host ? `${server.host}:${server.port || 2080}` : "") ||
          (server.start ? server.start.join(" ") : "?")
        return `${index === this.index ? "*" : " "} ${name} [${this.typeOf(server)}] ${target}`
      })
      .join("\n")
  }

  async enable() {
    if (this.enabled) return "vpn already on"
    this.enabled = true
    if (!this.server) await this.bind()
    if (!this.server) return this.status()
    this.applyProcessEnv()
    await this.rotate()
    return this.status()
  }

  async disable() {
    this.enabled = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.stopActive()
    this.restoreProcessEnv()
    this.upstream = null
    this.activeName = "direct"
    this.exitIp = ""
    this.activeSince = 0
    return "vpn off (traffic goes direct)"
  }

  async rotate(): Promise<string> {
    if (!this.enabled) return "vpn disabled"
    if (this.rotating) return "rotation already running"
    if (!this.servers.length) return "no servers configured"
    this.rotating = true
    try {
      for (let step = 0; step < this.servers.length; step++) {
        const index = (this.index + 1 + step) % this.servers.length
        if (await this.activate(index)) {
          this.schedule()
          return `vpn: ${this.activeName} exit=${this.exitIp || "unknown"}`
        }
      }
      if (this.options.strict) {
        this.upstream = { name: "blocked", kind: "blocked", host: "", port: 0 }
        this.activeName = "blocked"
        return `vpn: no healthy server, traffic blocked (${this.lastError})`
      }
      this.schedule(Math.min(this.rotateMs, 120000))
      return `vpn: no healthy server, keeping ${this.activeName} (${this.lastError})`
    } finally {
      this.rotating = false
    }
  }

  async use(name: string) {
    if (!this.enabled) return "vpn disabled"
    const index = this.servers.findIndex((server, position) => this.nameOf(server, position) === name)
    if (index === -1) return `unknown server: ${name}`
    const ok = await this.activate(index)
    if (ok) this.schedule()
    return ok ? `vpn: ${this.activeName} exit=${this.exitIp || "unknown"}` : `vpn: ${name} failed: ${this.lastError}`
  }

  private schedule(delayMs = this.rotateMs) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.enabled || !this.servers.length) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.rotate()
    }, delayMs)
  }

  private listen(server: net.Server, port: number) {
    return new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening)
        resolve(err)
      }
      const onListening = () => {
        server.off("error", onError)
        const address = server.address()
        if (address && typeof address === "object") this.port = address.port
        resolve(null)
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(port, this.host)
    })
  }

  private async bind(): Promise<void> {
    const server = net.createServer((socket) => {
      this.log("debug", `vpn: client ${socket.remoteAddress}:${socket.remotePort}`)
      void this.handle(socket)
    })

    const configured = this.port
    const first = await this.listen(server, configured)
    if (!first) {
      this.server = server
      server.on("error", (err) => this.log("warn", `vpn: proxy error: ${err.message}`))
      this.log("info", `vpn proxy listening on ${this.host}:${this.port}`)
      return
    }
    if (first.code !== "EADDRINUSE") {
      this.enabled = false
      this.log("error", `vpn: proxy failed: ${first.message}`)
      return
    }

    this.log("warn", `vpn: port ${configured} is busy (other app or instance), picking a free port`)
    const retry = await this.listen(server, 0)
    if (retry) {
      this.enabled = false
      this.log("error", `vpn: proxy failed: ${retry.message}`)
      return
    }
    this.server = server
    server.on("error", (err) => this.log("warn", `vpn: proxy error: ${err.message}`))
    this.log("info", `vpn proxy listening on ${this.host}:${this.port}`)
  }

  private applyProcessEnv() {
    if (this.options.exportEnv === false) return
    const proxy = `http://${this.host}:${this.port}`
    const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"]
    if (!this.savedEnv) {
      this.savedEnv = {}
      for (const key of keys) this.savedEnv[key] = process.env[key]
    }
    for (const key of keys.slice(0, 6)) process.env[key] = proxy
    process.env.NO_PROXY = this.noProxy.join(",")
    process.env.no_proxy = this.noProxy.join(",")
  }

  private restoreProcessEnv() {
    const saved = this.savedEnv
    this.savedEnv = null
    if (!saved) return
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  private typeOf(config: ServerConfig): ServerType {
    if (config.type) return config.type
    if (config.start?.length) return "command"
    if (config.url) return /^socks5/i.test(config.url) ? "socks5" : "http"
    return "socks5"
  }

  private nameOf(config: ServerConfig, index: number) {
    const type = this.typeOf(config)
    const target = config.url || (config.host ? `${config.host}:${config.port || 2080}` : config.start?.[0] || "")
    return config.name || `${type}:${target || index}`
  }

  private upstreamOf(config: ServerConfig, name: string): Upstream {
    const type = this.typeOf(config)
    if (type === "direct") return { name, kind: "direct", host: "", port: 0 }
    const fallback = config.waitPort || 2080
    const raw = config.url || `${type === "socks5" ? "socks5" : "http"}://${config.host || "127.0.0.1"}:${config.port || fallback}`
    const url = new URL(raw)
    return {
      name,
      kind: /^socks5/i.test(url.protocol) ? "socks5" : "http",
      host: url.hostname,
      port: Number(url.port || (type === "socks5" ? 1080 : 3128)),
      user: url.username ? decodeURIComponent(url.username) : undefined,
      pass: url.password ? decodeURIComponent(url.password) : undefined,
    }
  }

  private async stopActive() {
    const child = this.command
    this.command = null
    if (child) {
      try {
        child.stdin?.destroy()
        child.kill()
      } catch {}
    }
    const config = this.activeConfig
    this.activeConfig = null
    if (config?.stop?.length) await this.runCommand(config.stop, 15000).catch(() => {})
  }

  private runCommand(argv: string[], timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
      if (!argv.length) return resolve()
      const child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: "ignore" })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {}
        reject(new Error(`command timeout: ${path.basename(argv[0])}`))
      }, timeoutMs)
      child.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on("exit", (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`command exited ${code}: ${path.basename(argv[0])}`))
      })
    })
  }

  private async startCommand(config: ServerConfig, name: string): Promise<ChildProcess> {
    if (!config.start?.length) throw new Error(`${name}: start command is required`)
    const [binary, ...args] = config.start
    const child = spawn(binary, args, { windowsHide: true, stdio: "ignore" })
    let failure: Error | null = null
    child.on("error", (err) => {
      failure = err
    })
    if (config.waitPort) {
      await this.waitPort(config.waitHost || "127.0.0.1", config.waitPort, config.waitMs || this.timeout)
    } else {
      await sleep(1500)
    }
    if (failure) {
      child.kill()
      throw failure
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`${name}: command exited ${child.exitCode}`)
    }
    return child
  }

  private async waitPort(host: string, port: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const socket = await directConnect(host, port, 1000)
        socket.destroy()
        return
      } catch {
        await sleep(300)
      }
    }
    throw new Error(`port ${host}:${port} did not open in time`)
  }

  private async activate(index: number): Promise<boolean> {
    const config = this.servers[index]
    const name = this.nameOf(config, index)
    const type = this.typeOf(config)
    let child: ChildProcess | null = null
    await this.stopActive()
    try {
      if (type === "command") {
        child = await this.startCommand(config, name)
      }
      const candidate = this.upstreamOf(config, name)
      const previous = this.upstream
      this.upstream = candidate
      let ip = ""
      try {
        ip = await this.probe()
      } catch (err) {
        this.upstream = previous
        throw err
      }

      this.command = child
      this.activeConfig = config
      child = null
      this.index = index
      this.exitIp = ip
      this.activeName = name
      this.activeSince = Date.now()
      this.lastError = ""
      this.log("info", `vpn active: ${name} (${candidate.kind}) exit=${ip || "unknown"}`)
      return true
    } catch (err) {
      try {
        child?.kill()
      } catch {}
      if (config.stop?.length) await this.runCommand(config.stop, 15000).catch(() => {})
      this.lastError = err instanceof Error ? err.message : String(err)
      this.log("warn", `vpn server failed: ${name}: ${this.lastError}`)
      return false
    }
  }

  private async dial(host: string, port: number): Promise<net.Socket> {
    if (!this.enabled) return directConnect(host, port, this.timeout)
    const upstream = this.upstream
    if (!upstream || upstream.kind === "direct") return directConnect(host, port, this.timeout)
    if (upstream.kind === "blocked") throw new Error("vpn: no healthy server")
    if (upstream.kind === "socks5") return socks5Connect(upstream, host, port, this.timeout)
    return httpProxyConnect(upstream, host, port, this.timeout)
  }

  private async handle(client: net.Socket) {
    client.on("error", () => {})
    let parsed: { head: string; leftover: Buffer }
    try {
      parsed = await readHead(client, 64 * 1024, this.timeout)
    } catch {
      client.destroy()
      return
    }

    const first = parsed.head.split("\r\n")[0] || ""
    this.log("debug", `vpn: ${first}`)
    const connect = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]\s*$/i.exec(first)
    try {
      if (connect) {
        const target = splitHostPort(connect[1])
        const upstream = await this.dial(target.host, target.port)
        this.log("debug", `vpn: tunnel ${target.host}:${target.port}`)
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (parsed.leftover.length) upstream.write(parsed.leftover)
        bridge(client, upstream)
        return
      }

      const request = /^([A-Z]+)\s+(\S+)\s+HTTP\/1\.[01]\s*$/i.exec(first)
      if (!request) throw new Error("unsupported request")
      const method = request[1]
      const target = request[2]
      let host: string
      let port: number
      let requestPath: string
      let hostHeader: string
      let secure = false

      if (target.startsWith(PREFIX)) {
        const rest = target.slice(PREFIX.length)
        const slash = rest.indexOf("/")
        const encoded = slash === -1 ? rest : rest.slice(0, slash)
        const suffix = slash === -1 ? "/" : rest.slice(slash)
        const origin = new URL(Buffer.from(encoded, "base64url").toString("utf8"))
        host = origin.hostname
        secure = origin.protocol === "https:"
        port = Number(origin.port || (secure ? 443 : 80))
        requestPath = suffix
        hostHeader = origin.host
      } else if (/^http:\/\//i.test(target)) {
        const url = new URL(target)
        host = url.hostname
        port = Number(url.port || 80)
        requestPath = `${url.pathname}${url.search}`
        hostHeader = url.host
      } else {
        throw new Error("proxy requires an absolute URI")
      }

      let upstream = await this.dial(host, port)
      if (secure) upstream = await secureConnect(upstream, host, this.timeout)
      upstream.write(rebuildHead(parsed.head, method, requestPath, hostHeader))
      if (parsed.leftover.length) upstream.write(parsed.leftover)
      bridge(client, upstream)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      try {
        client.end(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
        )
      } catch {}
    }
  }

  private async probe(): Promise<string> {
    const url = new URL(this.healthUrl)
    const secure = url.protocol === "https:"
    const port = Number(url.port || (secure ? 443 : 80))
    const socket = await directConnect(this.host, this.port, this.timeout)
    const reader = new Reader(socket)
    let leftover: Buffer = Buffer.alloc(0)
    let head = ""
    try {
      socket.write(`CONNECT ${url.hostname}:${port} HTTP/1.1\r\nHost: ${url.hostname}:${port}\r\n\r\n`)
      while (!head.includes("\r\n\r\n")) {
        if (head.length > 8192) throw new Error("proxy header too large")
        head += (await reader.take(1)).toString("latin1")
      }
    } finally {
      leftover = reader.detach()
    }

    if (!/^HTTP\/1\.[01] 200/.test(head)) {
      let reason = leftover.toString("utf8").trim()
      if (!reason) reason = (await readAll(socket, 3000).catch(() => Buffer.alloc(0))).toString("utf8").trim()
      socket.destroy()
      throw new Error(reason || head.split("\r\n")[0])
    }

    let channel: net.Socket = socket
    if (secure) channel = await secureConnect(socket, url.hostname, this.timeout)
    if (leftover.length) channel.unshift(leftover)
    channel.write(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: opencode-vpn\r\nAccept: text/plain\r\nConnection: close\r\n\r\n`,
    )
    const raw = await readAll(channel, this.timeout).catch((err) => {
      channel.destroy()
      throw err
    })
    const body = bodyOf(raw).trim()
    if (!body) throw new Error("empty health check response")
    return body.slice(0, 64)
  }
}

function rewriteProviders(config: ConfigLike, port: number, log: Logger, exclude: string[] = []) {
  const providers = config.provider
  if (!providers) return
  const skip = new Set(exclude.map((id) => id.toLowerCase()))
  const prefix = `http://127.0.0.1:${port}${PREFIX}`
  for (const [id, provider] of Object.entries(providers)) {
    if (skip.has(id.toLowerCase())) continue
    const options = provider?.options
    const base = options?.baseURL
    if (!options || typeof base !== "string" || base.startsWith(prefix)) continue
    let url: URL
    try {
      url = new URL(base)
    } catch {
      continue
    }
    if (isLocalHost(url.hostname)) continue
    const suffix = url.pathname.replace(/\/+$/, "")
    options.baseURL = `${prefix}${Buffer.from(url.origin, "utf8").toString("base64url")}${suffix}`
    log("info", `vpn: provider ${id} -> ${url.origin}`)
  }
}

export const VpnPlugin: Plugin = async ({ client }) => {
  const log: Logger = (level, message, extra) => {
    void Promise.resolve(client.app.log({ body: { service: "vpn", level, message, extra } })).catch(() => {})
  }
  const options = readOptions()
  const vpn = new Vpn(options, log)
  await vpn.start()

  return {
    config: async (config) => {
      if (!vpn.enabled || options.rewriteProviders === false) return
      rewriteProviders(config as unknown as ConfigLike, vpn.port, log, options.excludeProviders)
    },

    "shell.env": async (_input, output) => {
      if (!vpn.enabled || options.exportEnv === false) return
      const proxy = `http://${vpn.host}:${vpn.port}`
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
        output.env[key] = proxy
      }
      const noProxy = (options.noProxy?.length ? options.noProxy : DEFAULT_NO_PROXY).join(",")
      output.env.NO_PROXY = noProxy
      output.env.no_proxy = noProxy
    },

    tool: {
      vpn: tool({
        description:
          "Control the opencode VPN: status, rotate to the next server immediately, switch to a named server, or turn the tunnel on/off.",
        args: {
          action: tool.schema
            .enum(["status", "rotate", "on", "off", "servers"])
            .optional()
            .describe("Action to perform, default status"),
          server: tool.schema.string().optional().describe("Server name for the rotate action"),
        },
        async execute(args) {
          if (args.server) return vpn.use(args.server)
          switch (args.action || "status") {
            case "rotate":
              return vpn.rotate()
            case "on":
              return vpn.enable()
            case "off":
              return vpn.disable()
            case "servers":
              return vpn.serversList()
            default:
              return vpn.status()
          }
        },
      }),
    },

    dispose: async () => {
      await vpn.stop()
    },
  }
}

export default VpnPlugin
