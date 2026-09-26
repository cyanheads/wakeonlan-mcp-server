<div align="center">
  <h1>@cyanheads/wakeonlan-mcp-server</h1>
  <p><b>Wake LAN machines with Wake-on-LAN magic packets from host profiles, then confirm they came up via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/wakeonlan-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/wakeonlan-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/wakeonlan-mcp-server/releases/latest/download/wakeonlan-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=wakeonlan-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd2FrZW9ubGFuLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22wakeonlan-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fwakeonlan-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Wake-on-LAN for the machines on your local network, addressed by the aliases in your host profiles. Wake a sleeping desktop, GPU box, NAS, or lab machine, wait until it answers on a TCP port such as SSH, check whether a host is up without waking it, and work through a wake that didn't take. Runs as a stdio process or a local Streamable HTTP server on a machine attached to the same LAN as the hosts it wakes.

### Tools

| Tool | Description |
|:---|:---|
| `wol_wake_host` | Send magic packets to a configured host, then wait for its TCP check port to answer |
| `wol_check_host` | Probe a configured host's check port once, without sending a magic packet |
| `wol_list_hosts` | List the host profiles and whether this machine is attached to each host's subnet |
| `wol_list_reference` | Wake-on-LAN reference by topic: packet format, target setup, power states, troubleshooting, profile format, sender traps |

## Capability reference

### `wol_wake_host` <sub>tool</sub>

- `alias` (from `wol_list_hosts`, case-insensitive) plus optional `wait_for_s`, 0–55 seconds, default 30; `0` sends and returns without checking. Sends 3 packets 500 ms apart, probing the check port once before sending and every 2 s after the first packet
- `state` is `already_awake`, `awake` (with `time_to_answer_ms`, an upper bound at the 2 s poll interval), `not_reachable`, or `unverified` (`unverified_reason`: `wait_disabled` or `no_address`); the last two carry a `guidance` next step
- Fails as `unknown_host`, `off_segment` (nothing sent: this machine has no interface on the host's subnet), retryable `wake_in_progress` (nothing sent: another call is already waking that host, and one wake per host runs at a time), or retryable `socket_error`, whose `data` carries the failed `stage` and `packets_sent`

---

### `wol_check_host` <sub>tool</sub>

- `alias` only: one TCP connect to the profile's `address` and `check_port` (22 unless the profile sets another), 1.5 s timeout, no magic packet. The port is not an input, so the tool can't scan arbitrary ports
- `outcome` is `open`, `refused` (the machine answered, nothing listens on that port), or `no_answer`; `reachable` is true only for `open`, and `latency_ms` is present for `open` and `refused`
- Fails as `unknown_host`, or `no_address` when the profile has no address to probe

---

### `wol_list_hosts` <sub>tool</sub>

- No input. Returns every profile in config order: `alias`, `description`, `mac`, `address`, `check_port`, `wol_port`, `broadcast` with `broadcast_source` (`configured`, `derived`, or `unresolved`), and `secureon_set` (never the password)
- `on_segment`, with the sending `interface` and `local_address` when true, is resolved against this machine's interfaces on every call; nothing is sent or probed, so it says nothing about whether a host is up
- `config_source` (`file`, `inline`, or `none`) and `config_path` name where the profiles came from

---

### `wol_list_reference` <sub>tool</sub>

- `topic`: `packet-format`, `prerequisites`, `sleep-states`, `troubleshooting`, `host-profiles`, or `sender-environment`
- Static markdown with no network access; every response lists all `topics` for navigation

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Wake-on-LAN-specific:

- Operator-configured targets only: callers pass an alias, never a MAC, IP, broadcast address, or port, so an agent or HTTP caller can wake and probe only the hosts you listed. SecureOn passwords stay in the profile, never returned or logged
- Subnet-directed broadcasts: the broadcast address is derived from a host's IPv4 address and the matching local interface when the profile omits it, and a host on no local subnet is refused before anything is sent instead of being routed away silently
- Wakes are confirmed by a TCP connect to a per-host `check_port` (SSH by default; RDP or SMB for Windows), not ICMP
- The LAN layer is Node's own `node:dgram`, `node:net`, and `node:os`, with no third-party networking dependency

Agent-friendly output:

- Results, not errors, for every wait outcome: `state` plus a `guidance` next step naming the tool or reference topic to call
- Typed failures with recovery hints: `unknown_host` lists up to 20 configured aliases, `off_segment` names the local subnets it compared, and on macOS `socket_error` points at the Local Network permission
- `refused` vs `no_answer`: a machine that is on but not listening on its check port reads differently from one that never answered, so a wrong `check_port` doesn't look like a failed wake

## Getting started

Add the following to your MCP client configuration file, pointing `WOL_HOSTS_FILE` at your [hosts file](#host-profiles).

```json
{
  "mcpServers": {
    "wakeonlan-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/wakeonlan-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "WOL_HOSTS_FILE": "~/.config/wakeonlan/hosts.json"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "wakeonlan-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/wakeonlan-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "WOL_HOSTS_FILE": "~/.config/wakeonlan/hosts.json"
      }
    }
  }
}
```

The Claude Desktop `.mcpb` bundle (the install badge above) asks for a hosts file or inline hosts JSON when you install it.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 WOL_HOSTS_FILE=~/.config/wakeonlan/hosts.json bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A machine attached to the same LAN segment as the hosts it wakes. Run the server on that machine's OS, or in [Docker](#docker) with host networking on Linux: a container on a default bridge network, Docker Desktop on macOS or Windows, or WSL2 in its default NAT mode can't put a broadcast on the LAN.
- Targets with Wake-on-LAN enabled in firmware and armed by the OS. `wol_list_reference` with topic `prerequisites` has the Windows, Linux, and macOS settings.

### macOS: Local Network permission

On macOS 15 and later, sending a UDP broadcast or connecting to a LAN address needs Local Network access, and macOS grants it to the app that launched the server rather than to `node`:

| Launched from | Who holds the permission |
|:---|:---|
| Claude Desktop (the `.mcpb` bundle or a JSON config) | Claude Desktop. macOS asks once, and the grant covers every server it launches. |
| Apple's Terminal, or an SSH session | Allowed automatically, with no prompt. |
| A third-party terminal or editor (iTerm2, Ghostty, VS Code, Cursor, …) | That app, which gets the prompt. |
| A `launchd` daemon, or a process running as root | Allowed automatically. |
| A `launchd` agent | Blocked until granted. Run an always-on server as a daemon instead. |

Grant or check it under **System Settings > Privacy & Security > Local Network**. The first send can fail while the alert is pending, so `wol_wake_host` may return `socket_error`; retry after allowing. If that list shows a `node` entry rather than your client app, enable the `node` entry. A denied permission also makes `wol_check_host` read `no_answer`. Windows and Linux have no per-app gate. `wol_list_reference` with topic `sender-environment` covers the rest, including the macOS 15.5+ subnet exemption.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/wakeonlan-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd wakeonlan-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set WOL_HOSTS_FILE or WOL_HOSTS
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `WOL_HOSTS_FILE` | Absolute path to the JSON hosts file; a leading `~/` expands to the home directory. Mutually exclusive with `WOL_HOSTS`. | none |
| `WOL_HOSTS` | The same JSON array inline, for single-host setups or clients where a file is awkward. Mutually exclusive with `WOL_HOSTS_FILE`. | none |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address. Anything but loopback requires `MCP_AUTH_MODE` `jwt` or `oauth`. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_ALLOWED_ORIGINS` | Comma-separated browser origins allowed on the HTTP endpoint. `*` is refused without `jwt` or `oauth`. | loopback origins |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Host profiles

Profiles are a JSON array, read once at startup from `WOL_HOSTS_FILE` or `WOL_HOSTS`. Set one of the two: both set is a startup error, and neither set starts the server with no hosts, which `wol_list_hosts` explains. `WOL_HOSTS_FILE` must be absolute (after `~/` expansion), because a stdio server runs in the MCP client's working directory, and must name a regular file of at most 1 MiB: a directory, a pipe, or a device such as `/dev/stdin` is a startup error. Editing the profiles takes a restart.

```json
[
  {
    "alias": "gpu-box",
    "description": "Desktop with the training GPU; SSH on 22.",
    "mac": "00:00:5e:00:53:01",
    "address": "192.0.2.50"
  },
  {
    "alias": "nas",
    "mac": "00-00-5E-00-53-02",
    "address": "nas.home.arpa",
    "broadcast": "192.0.2.255",
    "check_port": 445,
    "secureon": "00:00:5e:00:53:ff"
  }
]
```

| Field | Required | Default | Rules |
|:---|:---|:---|:---|
| `alias` | yes | | 1–64 characters: a letter or digit, then letters, digits, `.`, `_`, or `-`. Unique, ignoring case. |
| `mac` | yes | | Colon, dash, Cisco dotted (`0000.5e00.5301`), or bare hex form. Group (multicast) and all-zero MACs are rejected. |
| `address` | no | | IPv4 or IPv6 literal, or a DNS hostname. The probe target: without it a wake can't be confirmed and `wol_check_host` refuses the host. |
| `broadcast` | unless `address` is IPv4 | derived | The subnet's directed broadcast. `255.255.255.255`, `0.0.0.0`, and `224.0.0.0/4` are rejected. |
| `wol_port` | no | `9` | UDP destination port, 1–65535. |
| `check_port` | no | `22` | TCP port probed to confirm the host is up, 1–65535. Windows hosts usually need `3389` (RDP) or `445` (SMB). |
| `secureon` | no | | 6-byte SecureOn password in MAC format. Never shown or logged. |
| `description` | no | | Operator note, up to 500 characters, returned by `wol_list_hosts`. |

An empty string leaves an optional text field (`address`, `broadcast`, `secureon`, `description`) unset. The server refuses to start, naming the entry and field, on an unknown key, an invalid value, a duplicate alias, or a profile with neither `broadcast` nor an IPv4 `address`. Whether this machine sits on a host's subnet is checked per call, not at startup, since interfaces change. `wol_list_reference` with topic `host-profiles` has an example per OS.

### HTTP exposure

A startup guard refuses any HTTP deployment that would let an unauthenticated caller reach the tools from beyond this machine, or from a web page through your browser. Stdio is unaffected.

| `MCP_HTTP_HOST` | Unauthenticated (`MCP_AUTH_MODE=none`) | `jwt` or `oauth` |
|:---|:---|:---|
| Loopback: `localhost`, `127.0.0.0/8`, `::1` | Serves, unless `MCP_ALLOWED_ORIGINS` contains `*` | Serves |
| Anything else (`0.0.0.0`, a LAN address, …) | Refuses to start | Serves |

`DEV_MCP_AUTH_BYPASS` counts as unauthenticated. With `MCP_ALLOWED_ORIGINS` unset, requests from non-loopback browser origins are rejected, so a web page can't drive a loopback endpoint through DNS rebinding; `*` turns that check off, which is why it needs auth. Host profiles are server-wide: every authenticated caller can wake the same hosts.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

The image is Linux-only. It can wake hosts only when run with `--network host` (or on a macvlan network) on a Linux machine attached to their LAN, such as a Raspberry Pi, NAS, or home server that already runs Docker. On a default bridge network the container sees only Docker's private subnet, so `wol_wake_host` fails with `off_segment` before sending anything. Docker Desktop on macOS and Windows runs containers in a VM, so its broadcasts can't reach the LAN in any network mode.

Build the image from a clone of this repository:

```sh
docker build -t wakeonlan-mcp-server .
```

Then add it to your MCP client configuration on that machine. The [hosts file](#host-profiles) is mounted read-only from an absolute host path, and `WOL_HOSTS_FILE` names where it sits inside the container:

```json
{
  "mcpServers": {
    "wakeonlan-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--network", "host",
        "-v", "/path/to/hosts.json:/etc/wakeonlan/hosts.json:ro",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "WOL_HOSTS_FILE=/etc/wakeonlan/hosts.json",
        "wakeonlan-mcp-server"
      ]
    }
  }
}
```

The container runs as the image's `bun` user (uid 1000), which must be able to read the hosts file. Without `MCP_TRANSPORT_TYPE=stdio` the image serves Streamable HTTP on port 3010, bound to loopback, which under host networking is the host's own; any other bind needs `MCP_AUTH_MODE` `jwt` or `oauth` (see [HTTP exposure](#http-exposure)). Logs go to `/var/log/wakeonlan-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the four tools, runs the HTTP exposure guard, and loads the host profiles. |
| `src/config` | `WOL_HOSTS_FILE` / `WOL_HOSTS` parsing and the HTTP exposure guard. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), the shared `alias` input, and the static reference topics. |
| `src/services/hosts` | Host-profile loading, validation, MAC parsing, and alias lookup. |
| `src/services/lan` | Magic-packet construction, subnet resolution, the UDP send, and TCP probes. |
| `tests/` | Unit, integration, and fuzz tests against faked sockets, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; nothing persists, so `ctx.state` goes unused
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Every OS boundary (sockets, interfaces, clock, platform, filesystem) is an injected seam: tests never open a real socket, and live checks run on loopback only

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
