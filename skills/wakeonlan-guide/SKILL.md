---
name: wakeonlan-guide
description: Gates for the wol_* tools. Covers when a wake is warranted versus a status check, how to read refused, no_answer, and not_reachable before calling a machine off or a wake failed, which wake-failure checks need a person at the target, and how a new host gets configured. Use when asked to wake or power on a LAN machine, check whether one is up, diagnose a Wake-on-LAN that did not work, or add a host for wol_wake_host.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

- Wake and verify only, for hosts the operator configured. No tool powers a machine off, puts it to sleep, reboots it, or runs commands on it. Once a machine is up, SSH, RDP, or the user's own tooling does the work; putting it back to sleep is a job on the target itself.
- Packets go out from the machine this server runs on, to that machine's own LAN segment. It cannot wake a host across the internet or on another subnet, and a server inside a default-bridge container or WSL2 in NAT mode sees every host as off-segment.
- No keys or accounts. Profiles come from `WOL_HOSTS_FILE` or `WOL_HOSTS`, read once at startup. No tool adds, edits, or removes a profile.

## Identifiers

- **alias**: the only way to name a target. It comes from wol_list_hosts, or from the `unknown_host` error, which lists up to 20 configured aliases. Matching ignores case.
- **address**: where to connect once the machine is up, from wol_list_hosts (a wake result echoes it as `probe.address`).
- **check_port**: the port the operator chose to prove the host is up (22 unless the profile sets another; Windows hosts often use 3389 or 445). It is not necessarily the service the user wants next.
- **config_source / config_path** (wol_list_hosts): where the profiles live. `file` means the JSON file at `config_path`, `inline` means the `WOL_HOSTS` value in the MCP client's server config, and `none` means neither is set.

## Gates

1. **Wake only when the user wants the machine on.** A wake powers on a physical machine. "Is X on?" or "can I reach X?" is wol_check_host, which sends nothing. Call wol_wake_host when the user asks for the machine to be on, or for work that needs it running.
2. **refused means the machine is on.** A `refused` outcome means something at the address answered on the network and nothing accepted the connection on `check_port`. That holds from wol_check_host and from `probe.last_outcome` under a wake whose `state` is `not_reachable`. Never report the machine as asleep, or the wake as failed, on a refusal. Either the service on `check_port` hasn't started yet (re-check shortly), or `check_port` is wrong for that host, which the operator fixes in the profile. A refusal doesn't end polling: a wake keeps probing every 2 seconds through its wait and then returns `not_reachable`, so with a wrong `check_port` every wake ends that way and waking again fixes nothing.
3. **Sent is not delivered.** `packets_sent: 3` means the local network stack sent the datagrams. UDP carries no acknowledgment, and the count is the same when nothing receives them. Only a probe that reads `open` confirms a host is up; `unverified` means no confirmation was attempted.
4. **One not_reachable is not a failed wake.** With `last_outcome: no_answer` it means the window closed before the host answered, and a cold boot from soft-off can take longer than the 55-second cap. Re-check with wol_check_host a minute or two later, a few times, before concluding anything. Don't loop wol_wake_host as a poll: each wake sends 3 broadcasts and probes `check_port` every 2 seconds, and on an SSH port every probe is a logged pre-auth disconnect that an intrusion filter can count against the server's address.
5. **no_answer doesn't prove the machine is off.** It reads the same when the host is still booting, when a hostname address fails to resolve (a typo, stale DNS, or the `.local` name of a sleeping host), when macOS 15 or later has denied Local Network access to the app that launched this server, and when a full-tunnel VPN has captured the LAN route.
6. **open proves an answer, not identity.** `open`, `awake`, and `already_awake` mean something accepted a connection at `address:check_port`. If DHCP handed that address to another device, or a hostname address now resolves elsewhere, the reading can come from that device. Mention it when the result contradicts what the user expects.

## Workflows

### Wake, then use the machine

1. wol_list_hosts for the alias. A host with `on_segment: false` cannot be woken from this server; don't call wol_wake_host on it, since the fix is where the server runs (wol_list_reference topic `sender-environment`).
2. wol_wake_host with the default window.
3. `awake` or `already_awake`: connect to `address`. If `check_port` is not the port you need (checked on 445, but you need SSH), that service can still be starting; retry the connection briefly before reporting it down.
4. `not_reachable`: apply gates 2 and 4. `unverified` with `no_address`: nothing can confirm this host; say so, and note that adding an address to its profile enables confirmation.

### Diagnose a wake that didn't come up

1. Classify the last result with the gates first. `refused` points at `check_port` or the service, not the wake. `off_segment` and `socket_error` are sender-side and carry their own recovery.
2. Persistent `no_answer` after the re-checks in gate 4: read wol_list_reference topic `troubleshooting`. Of its nine checks, the tools can verify only `on_segment` (wol_list_hosts) and whether the machine answers at all (`refused` versus `no_answer`). Apart from the sender-side notes, the rest need a person at the target: that the profile carries the wired card's MAC, that the link light stays on while the machine is off, that it is on Ethernet, the firmware's ErP and Deep Sleep settings, the OS arming the card, Windows Fast Startup, and the DHCP reservation. Hand those to the user as a checklist, with topics `prerequisites` and `sleep-states`, instead of waking again.

### Add or fix a host

1. Profiles change only where `config_source` points, and only with the user's go-ahead. A change loads when the MCP server restarts, which the user or the client does; no tool can. Until then wol_list_hosts and `unknown_host` show the old set.
2. Collect from the target while it is awake: the wired card's MAC, a stable IPv4 address (a DHCP reservation, written as an IPv4 literal so the broadcast can be derived; a hostname address needs an explicit `broadcast` or the server refuses to start), and a `check_port` something listens on. wol_list_reference topic `host-profiles` has the format.
3. After the restart, while the target is still awake, wol_list_hosts should show `on_segment: true` and wol_check_host should read `open`. That validates the address and `check_port` before the machine ever sleeps; `refused` here means nothing listens on that port, so fix `check_port` or start the service first. Then arm the target per `prerequisites` and `sleep-states`, and only then test a real wake.
