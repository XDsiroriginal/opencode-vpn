import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-vpn-test-"))
const configPath = path.join(tempDir, "vpn.json")
process.env.OPENCODE_VPN_CONFIG = configPath

const originalEnv = {}
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"]) {
  originalEnv[key] = process.env[key]
}

const { default: plugin } = await import("../plugin/vpn.ts")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}

function writeConfig(options) {
  fs.writeFileSync(configPath, JSON.stringify(options), "utf8")
}

async function startVpn(options) {
  writeConfig(options)
  const logs = []
  const client = { app: { log: async (entry) => logs.push(entry.body) } }
  const hooks = await plugin({ client })
  return { hooks, logs }
}

function proxyPort(statusText) {
  const match = /proxy: http:\/\/[^:]+:(\d+)/.exec(statusText)
  assert.ok(match, `no proxy port in status: ${statusText}`)
  return Number(match[1])
}

async function waitFor(fn, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(intervalMs)
  }
  throw new Error("waitFor timeout")
}

function miniSocks() {
  const stats = { connections: 0 }
  const server = net.createServer((client) => {
    stats.connections++
    client.on("error", () => {})
    client.once("data", () => {
      client.write(Buffer.from([5, 0]))
      client.once("data", (request) => {
        const atyp = request[3]
        let host = ""
        let offset = 4
        if (atyp === 1) {
          host = Array.from(request.subarray(4, 8)).join(".")
          offset = 8
        } else if (atyp === 3) {
          const size = request[4]
          host = request.subarray(5, 5 + size).toString()
          offset = 5 + size
        }
        const port = request.readUInt16BE(offset)
        const upstream = net.connect({ host, port }, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on("error", () => client.destroy())
      })
    })
  })
  return { server, stats }
}

function httpOrigin(body) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" })
    response.end(body)
  })
  return server
}

function requestViaProxy(port, target, hostHeader) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: target, headers: hostHeader ? { Host: hostHeader } : {} },
      (response) => {
        const chunks = []
        response.on("data", (chunk) => chunks.push(chunk))
        response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
      },
    )
    request.on("error", reject)
    request.end()
  })
}

function connectThroughProxy(port, host, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    let buffer = ""
    socket.setTimeout(10000)
    socket.on("timeout", () => {
      socket.destroy()
      reject(new Error("timeout"))
    })
    socket.on("error", reject)
    socket.on("connect", () => socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`))
    const onData = (chunk) => {
      buffer += chunk.toString("latin1")
      if (!buffer.includes("\r\n\r\n")) return
      socket.off("data", onData)
      const status = Number(buffer.split(" ")[1])
      if (status !== 200) {
        socket.destroy()
        reject(new Error(`CONNECT ${status}`))
        return
      }
      const rest = buffer.slice(buffer.indexOf("\r\n\r\n") + 4)
      resolve({ socket, rest: Buffer.from(rest, "latin1") })
    }
    socket.on("data", onData)
  })
}

function echoServer() {
  return net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk))
    socket.on("error", () => {})
  })
}

async function stopAll(...servers) {
  await Promise.all(servers.map((server) => close(server)))
}

test("rewrites remote providers only, honoring exclusions", async () => {
  const port = await freePort()
  const { hooks } = await startVpn({
    listenPort: port,
    exportEnv: false,
    rewriteProviders: true,
    excludeProviders: ["skipme"],
    servers: [{ name: "direct", type: "direct" }],
    healthCheckUrl: "https://api.ipify.org",
  })

  const config = {
    provider: {
      remote: { options: { baseURL: "https://api.example.com/v1/" } },
      root: { options: { baseURL: "https://root.example.com" } },
      local: { options: { baseURL: "http://127.0.0.1:11434/v1" } },
      lan: { options: { baseURL: "http://192.168.1.10:8000/v1" } },
      skipme: { options: { baseURL: "https://skip.example.com/v1" } },
    },
  }

  await hooks.config(config)
  const actualPort = proxyPort(await hooks.tool.vpn.execute({ action: "status" }, {}))

  const remote = config.provider.remote.options.baseURL
  assert.match(remote, new RegExp(`^http://127\\.0\\.0\\.1:${actualPort}/p/`))
  const encoded = /\/p\/([A-Za-z0-9_-]+)/.exec(remote)[1]
  const origin = Buffer.from(encoded, "base64url").toString("utf8")
  assert.equal(origin, "https://api.example.com")
  assert.ok(remote.endsWith("/v1"))

  assert.match(config.provider.root.options.baseURL, /\/p\/[A-Za-z0-9_-]+$/)
  assert.equal(config.provider.local.options.baseURL, "http://127.0.0.1:11434/v1")
  assert.equal(config.provider.lan.options.baseURL, "http://192.168.1.10:8000/v1")
  assert.equal(config.provider.skipme.options.baseURL, "https://skip.example.com/v1")

  const before = config.provider.remote.options.baseURL
  await hooks.config(config)
  assert.equal(config.provider.remote.options.baseURL, before)

  await hooks.dispose()
})

test("forwards CONNECT, absolute HTTP and reverse path through a socks endpoint", async () => {
  const socks = miniSocks()
  const socksPort = await listen(socks.server)
  const origin = httpOrigin("hello-from-origin")
  const originPort = await listen(origin)
  const echo = echoServer()
  const echoPort = await listen(echo)
  const port = await freePort()

  const { hooks } = await startVpn({
    listenPort: port,
    exportEnv: false,
    healthCheckUrl: `http://127.0.0.1:${originPort}/ip`,
    servers: [{ name: "socks-a", type: "socks5", url: `socks5://127.0.0.1:${socksPort}` }],
  })

  const actualPort = await waitFor(async () => {
    const status = await hooks.tool.vpn.execute({ action: "status" }, {})
    return /exit ip: hello-from-origin/.test(status) ? proxyPort(status) : 0
  })

  const plain = await requestViaProxy(actualPort, `http://127.0.0.1:${originPort}/`, `127.0.0.1:${originPort}`)
  assert.equal(plain.status, 200)
  assert.equal(plain.body, "hello-from-origin")

  const encoded = Buffer.from(`http://127.0.0.1:${originPort}`, "utf8").toString("base64url")
  const reverse = await requestViaProxy(actualPort, `/p/${encoded}/`)
  assert.equal(reverse.status, 200)
  assert.equal(reverse.body, "hello-from-origin")

  const tunnel = await connectThroughProxy(actualPort, "127.0.0.1", echoPort)
  tunnel.socket.write("ping")
  const echoed = await new Promise((resolve) => tunnel.socket.once("data", (chunk) => resolve(chunk.toString())))
  assert.equal(echoed, "ping")
  tunnel.socket.destroy()

  assert.ok(socks.stats.connections >= 3, `socks connections: ${socks.stats.connections}`)

  await hooks.dispose()
  await stopAll(socks.server, origin, echo)
})

test("picks a free port when the configured one is taken", async () => {
  const busy = net.createServer()
  const busyPort = await listen(busy)
  const origin = httpOrigin("still-works")
  const originPort = await listen(origin)

  const { hooks } = await startVpn({
    listenPort: busyPort,
    exportEnv: false,
    healthCheckUrl: `https://api.ipify.org`,
    servers: [{ name: "direct", type: "direct" }],
  })

  const status = await hooks.tool.vpn.execute({ action: "status" }, {})
  const actualPort = proxyPort(status)
  assert.notEqual(actualPort, busyPort)

  const response = await requestViaProxy(actualPort, `http://127.0.0.1:${originPort}/`, `127.0.0.1:${originPort}`)
  assert.equal(response.body, "still-works")

  await hooks.dispose()
  await stopAll(busy, origin)
})

test("off restores the environment and on re-applies it", async () => {
  const port = await freePort()
  const { hooks } = await startVpn({
    listenPort: port,
    exportEnv: true,
    healthCheckUrl: "https://api.ipify.org",
    servers: [{ name: "direct", type: "direct" }],
  })

  const actualPort = proxyPort(await hooks.tool.vpn.execute({ action: "status" }, {}))
  assert.equal(process.env.HTTPS_PROXY, `http://127.0.0.1:${actualPort}`)
  assert.equal(process.env.NO_PROXY, "localhost,127.0.0.1,::1,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12")

  await hooks.tool.vpn.execute({ action: "off" }, {})
  for (const [key, value] of Object.entries(originalEnv)) {
    assert.equal(process.env[key], value, `${key} was not restored`)
  }

  await hooks.tool.vpn.execute({ action: "on" }, {})
  assert.equal(process.env.HTTPS_PROXY, `http://127.0.0.1:${actualPort}`)

  await hooks.dispose()
  for (const [key, value] of Object.entries(originalEnv)) {
    assert.equal(process.env[key], value, `${key} was not restored after dispose`)
  }
})

test("stays idle with an empty pool and does not route", async () => {
  const port = await freePort()
  const { hooks } = await startVpn({
    listenPort: port,
    exportEnv: true,
    rewriteProviders: true,
    servers: [],
  })

  const status = await hooks.tool.vpn.execute({ action: "status" }, {})
  assert.match(status, /vpn: off/)

  const config = { provider: { remote: { options: { baseURL: "https://api.example.com/v1" } } } }
  await hooks.config(config)
  assert.equal(config.provider.remote.options.baseURL, "https://api.example.com/v1")
  assert.equal(process.env.HTTPS_PROXY, originalEnv.HTTPS_PROXY)

  await hooks.dispose()
})

test("keeps the proxy on loopback", async () => {
  const port = await freePort()
  const { hooks } = await startVpn({
    listenPort: port,
    exportEnv: false,
    healthCheckUrl: "https://api.ipify.org",
    servers: [{ name: "direct", type: "direct" }],
  })

  const actualPort = proxyPort(await hooks.tool.vpn.execute({ action: "status" }, {}))

  const external = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)[0]

  if (external) {
    const reachable = await new Promise((resolve) => {
      const socket = net.connect({ host: external, port: actualPort })
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 1500)
      socket.on("connect", () => {
        clearTimeout(timer)
        socket.destroy()
        resolve(true)
      })
      socket.on("error", () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    assert.equal(reachable, false, `proxy is reachable on LAN address ${external}`)
  }

  await hooks.dispose()
})

test("falls back to direct when the endpoint is dead and reports the reason", async () => {
  const deadPort = await freePort()
  const port = await freePort()
  const { hooks, logs } = await startVpn({
    listenPort: port,
    exportEnv: false,
    healthCheckUrl: "https://api.ipify.org",
    servers: [{ name: "dead-socks", type: "socks5", url: `socks5://127.0.0.1:${deadPort}` }],
  })

  const status = await waitFor(async () => {
    const text = await hooks.tool.vpn.execute({ action: "status" }, {})
    return /last error:.*ECONNREFUSED/.test(text) ? text : ""
  })
  assert.match(status, /server: direct/)

  const origin = httpOrigin("direct-works")
  const originPort = await listen(origin)
  const response = await requestViaProxy(proxyPort(status), `http://127.0.0.1:${originPort}/`, `127.0.0.1:${originPort}`)
  assert.equal(response.body, "direct-works")

  await hooks.dispose()
  await stopAll(origin)
})

test("starts a local proxy client from a command endpoint", async () => {
  const socksPort = await freePort()
  const origin = httpOrigin("from-command")
  const originPort = await listen(origin)
  const port = await freePort()

  const script = [
    "const net = require('node:net')",
    `const server = net.createServer((client) => {`,
    "  client.on('error', () => {})",
    "  client.once('data', () => {",
    "    client.write(Buffer.from([5, 0]))",
    "    client.once('data', (request) => {",
    "      const atyp = request[3]",
    "      let host = ''",
    "      let offset = 4",
    "      if (atyp === 1) {",
    "        host = Array.from(request.subarray(4, 8)).join('.')",
    "        offset = 8",
    "      } else {",
    "        const size = request[4]",
    "        host = request.subarray(5, 5 + size).toString()",
    "        offset = 5 + size",
    "      }",
    "      const target = request.readUInt16BE(offset)",
    "      const upstream = net.connect({ host, port: target }, () => {",
    "        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))",
    "        upstream.pipe(client)",
    "        client.pipe(upstream)",
    "      })",
    "      upstream.on('error', () => client.destroy())",
    "    })",
    "  })",
    "  client.on('error', () => {})",
    `})`,
    `server.listen(${socksPort}, '127.0.0.1')`,
  ].join("\n")

  const { hooks } = await startVpn({
    listenPort: port,
    exportEnv: false,
    healthCheckUrl: `http://127.0.0.1:${originPort}/ip`,
    servers: [
      {
        name: "spawned",
        type: "command",
        start: [process.execPath, "-e", script],
        waitPort: socksPort,
        waitMs: 10000,
        url: `socks5://127.0.0.1:${socksPort}`,
      },
    ],
  })

  const actualPort = await waitFor(async () => {
    const status = await hooks.tool.vpn.execute({ action: "status" }, {})
    return /exit ip: from-command/.test(status) ? proxyPort(status) : 0
  })

  const response = await requestViaProxy(actualPort, `http://127.0.0.1:${originPort}/`, `127.0.0.1:${originPort}`)
  assert.equal(response.body, "from-command")

  await hooks.dispose()
  await stopAll(origin)

  const probeSocks = () =>
    new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: socksPort })
      socket.on("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.on("error", () => resolve(false))
      setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 500)
    })

  let stillRunning = true
  for (let attempt = 0; attempt < 25 && stillRunning; attempt++) {
    stillRunning = await probeSocks()
    if (stillRunning) await sleep(200)
  }
  assert.equal(stillRunning, false, "spawned endpoint is still running")
})

test("tolerates a UTF-8 BOM in the config file", async () => {
  const port = await freePort()
  fs.writeFileSync(configPath, `\uFEFF${JSON.stringify({ listenPort: port, exportEnv: false, healthCheckUrl: "https://api.ipify.org", servers: [{ name: "direct", type: "direct" }] })}`, "utf8")

  const client = { app: { log: async () => {} } }
  const hooks = await plugin({ client })
  const status = await hooks.tool.vpn.execute({ action: "status" }, {})
  assert.match(status, /vpn: on/)
  assert.match(status, /server: direct/)
  await hooks.dispose()
})

test("dispose removes temporary resources", async () => {
  const port = await freePort()
  const { hooks } = await startVpn({
    listenPort: port,
    exportEnv: true,
    healthCheckUrl: "https://api.ipify.org",
    servers: [{ name: "direct", type: "direct" }],
  })
  const actualPort = proxyPort(await hooks.tool.vpn.execute({ action: "status" }, {}))
  await hooks.dispose()

  const reachable = await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: actualPort })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 1000)
    socket.on("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  assert.equal(reachable, false)
})
