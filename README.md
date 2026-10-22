# opencode-vpn

opencode plugin that sends everything opencode does through a local VPN/proxy chain and switches the egress server on a timer.

Everything runs on the local machine: the plugin starts a local proxy, dials the configured local proxy endpoints (or launches a local client with a command), and rotates between them. No remote server is configured or modified by the plugin.

## Features

- Local chained proxy on `127.0.0.1:7899` (HTTP CONNECT, plain HTTP, and a reverse path used by rewritten provider URLs).
- `config` hook rewrites every non-local provider `baseURL` so model API traffic goes through the local proxy.
- `shell.env` hook exports `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` to every tool subprocess.
- The same variables are set on `process.env`, so runtimes that honor them (e.g. Bun) also route through the proxy.
- Hourly rotation (configurable) with an egress-IP health check; a failed server is skipped and the next one is tried. If nothing is healthy the plugin retries every 2 minutes and keeps working direct (or blocks traffic with `strict`).
- Endpoint types: `socks5`, `http`, `direct`, and `command` (start a local proxy client, wait for its port, use it).
- `vpn` tool for status, manual rotation, named server switch, on/off.

## Install

```powershell
# 1. plugin
mkdir "$env:USERPROFILE\.config\opencode\plugins" -Force
copy plugin\vpn.ts "$env:USERPROFILE\.config\opencode\plugins\vpn.ts"

# 2. config
copy vpn.example.json "$env:USERPROFILE\.config\opencode\vpn.json"
# edit the servers list

# 3. restart opencode
```

Plugins in `~/.config/opencode/plugins/*.ts` are auto-discovered, so no `opencode.json` changes are needed. Config and plugins are read at startup only.

Optional: launch opencode through `opencode-vpn.cmd` (Windows) so that proxy variables are present in the environment before opencode starts. This also covers traffic that bypasses provider `baseURL` rewriting (auth flows, catalogs, npm, share).

## Configuration

`~/.config/opencode/vpn.json` (path can be overridden with `OPENCODE_VPN_CONFIG`):

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `OPENCODE_VPN=0` disables at runtime. |
| `listenHost` | `127.0.0.1` | Local proxy bind address. |
| `listenPort` | `7899` | Local proxy port. Keep in sync with the launcher. |
| `rotateMinutes` | `60` | Rotation interval. |
| `connectTimeoutMs` | `15000` | Per-connection timeout. |
| `healthCheckUrl` | `https://api.ipify.org` | Egress IP check through the proxy chain. |
| `rewriteProviders` | `true` | Rewrite non-local provider `baseURL` values. |
| `exportEnv` | `true` | Export proxy variables to tool subprocesses. |
| `strict` | `false` | `true` blocks traffic when no endpoint is healthy instead of going direct. |
| `noProxy` | loopback + RFC1918 | Hosts/patterns that bypass the proxy. |
| `servers` | `[]` | Pool of endpoints. |

Server entries:

```jsonc
// local SOCKS5 (e.g. a VPN client's local port)
{ "name": "local-socks", "type": "socks5", "url": "socks5://127.0.0.1:10808" }

// local HTTP proxy, credentials optional: http://user:pass@127.0.0.1:8080
{ "name": "local-http", "type": "http", "url": "http://127.0.0.1:10809" }

// launch a local proxy client per profile, then use its port
{
  "name": "xray-us",
  "type": "command",
  "start": ["C:\\Program Files\\Xray\\xray.exe", "run", "-c", "C:\\vpn\\us.json"],
  "stop": [],
  "waitPort": 2082,
  "waitHost": "127.0.0.1",
  "waitMs": 10000,
  "url": "socks5://127.0.0.1:2082"
}

// bypass
{ "name": "direct", "type": "direct" }
```

Set `"enabled": false` on an entry to keep it in the file but out of the pool. With an empty pool the plugin stays idle and opencode works normally.

Local/private `baseURL`s are never rewritten: `localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `*.local`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`.

## Tool

```
vpn                     -> status
vpn action=rotate       -> switch to the next endpoint now
vpn action=servers      -> list the pool
vpn action=on|off       -> toggle the tunnel
vpn server=xray-us      -> activate a named endpoint
```

## How routing works

1. Plugin starts `http://127.0.0.1:7899` (chained CONNECT/SOCKS5 client).
2. `config` rewrites provider `baseURL` to `http://127.0.0.1:7899/p/<base64-origin><path>`; the proxy decodes the origin, opens TLS to it and forwards the request through the active endpoint.
3. `shell.env` and `process.env` point proxy-aware tools at the same local port.
4. Every `rotateMinutes` the next endpoint is started/dialed, checked with an HTTPS request to `healthCheckUrl`, and activated only if it returns an egress IP. Old `command` endpoints are stopped.

## Notes

- Rotation changes the egress IP only when the pool has more than one working endpoint.
- `strict: true` is recommended only when the endpoint is expected to be always available; otherwise a broken endpoint would block opencode.
- Keep `vpn.json` out of version control if your endpoints contain credentials. It is in `.gitignore`.
- Plugin needs a runtime that supports `node:net`, `node:tls` and `node:child_process` (opencode's Bun runtime does).

## License

MIT
