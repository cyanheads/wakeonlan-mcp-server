/**
 * @fileoverview Static Wake-on-LAN reference notes served by
 * `wol_list_reference`: packet format, target prerequisites, power states,
 * troubleshooting, the host-profile format, and sender-side traps. Every
 * recovery hint and notice on the other tools routes here.
 * @module mcp-server/tools/reference-topics
 */

export const REFERENCE_TOPICS = [
  'packet-format',
  'prerequisites',
  'sleep-states',
  'troubleshooting',
  'host-profiles',
  'sender-environment',
] as const;

export type ReferenceTopic = (typeof REFERENCE_TOPICS)[number];

interface ReferenceEntry {
  content: string;
  title: string;
}

const packetFormat = [
  "A magic packet is 6 bytes of `0xFF` followed by the target's 6-byte MAC address repeated 16 times, 102 bytes in all. A SecureOn password adds 6 more bytes after the last repetition, for 108.",
  '',
  '- The network card scans every frame it receives for that byte sequence, wherever it appears. The UDP port (9 by convention, sometimes 7) matters only to routers and firewalls between sender and target, never to the card.',
  "- This server sends the packet over UDP to the target subnet's directed broadcast (for 192.0.2.0/24 that is 192.0.2.255), from a socket bound to this machine's interface on that subnet. It never uses `255.255.255.255`: Windows sends that out of every interface, and elsewhere the routing table picks one, which can be a VPN tunnel.",
  '- Sending to a broadcast address requires `SO_BROADCAST` on the socket. Without it the send fails with `EACCES` (Linux, macOS) or `WSAEACCES` (Windows) instead of dropping the packet silently. The server sets it once the socket is bound.',
  "- A directed broadcast for a subnet this machine isn't attached to is routed like unicast and disappears. That's why wol_wake_host refuses such a host with `off_segment` before sending anything.",
  '- Each wake sends 3 packets 500 ms apart. UDP has no delivery guarantee, and a repeat costs nothing.',
  '',
  'Sources: AMD, *Magic Packet Technology* white paper; Linux `ip(7)`; macOS `sendto(2)`; Winsock `sendto`.',
].join('\n');

const prerequisites = [
  'A target wakes only when its firmware keeps the network card powered while the machine sleeps or is off, and the OS arms the card for magic packets before it goes down.',
  '',
  '## Firmware (BIOS/UEFI)',
  '',
  '- Enable Wake on LAN. Some boards call it "Power On by PCI-E".',
  '- Disable ErP/EuP Ready and any Deep Sleep option. Both cut standby power to the network card, so the packet arrives at a dead port.',
  '',
  '## Windows',
  '',
  '- Device Manager > the Ethernet adapter > Power Management: enable "Allow this device to wake the computer" and "Only allow a magic packet to wake the computer".',
  '- Same adapter, Advanced tab: enable "Wake on Magic Packet". The name varies by driver.',
  '- Fast Startup changes what Shut down means; see sleep-states.',
  '',
  '## Linux',
  '',
  '- `ethtool <interface>` shows `Wake-on: g` when magic-packet wake is armed.',
  '- `ethtool -s <interface> wol g` arms it, but the setting often resets at reboot. Persist it with a systemd `.link` file (`WakeOnLan=magic`), NetworkManager (`802-3-ethernet.wake-on-lan magic`), or a udev rule that runs the ethtool command.',
  '- For a profile with a `secureon` password, set the same password on the target with `ethtool -s <interface> sopass <password>`, systemd `WakeOnLanPassword=`, or NetworkManager `802-3-ethernet.wake-on-lan-password`.',
  '',
  '## macOS target',
  '',
  '- Enable "Wake for network access" (System Settings > Energy on desktops, Battery on laptops), or run `sudo pmset -a womp 1`.',
  '- This wakes a sleeping Mac. Ethernet is the dependable path.',
  '',
  'Sources: Microsoft KB 2776718 for Fast Startup (the Device Manager setting names are defined by each driver); `ethtool(8)`; `systemd.link(5)`; `nm-settings-nmcli(5)`; `pmset(1)`; Apple Mac User Guide, "Set sleep and wake settings".',
].join('\n');

const sleepStates = [
  'Whether a magic packet can wake a machine depends on the power state it is in.',
  '',
  '| State | What it is | Wakes? |',
  '|:--|:--|:--|',
  '| S0 low-power idle | Modern Standby: screen off, system nominally on | Depends on the driver and firmware |',
  '| S3 | Sleep (suspend to RAM) | Yes. This is the normal Wake-on-LAN case |',
  '| S4 | Hibernate | Windows supports waking from a hibernate the user requested |',
  '| Windows "Shut down" with Fast Startup on | A hybrid S4 in which Windows does not arm the network card | No, though some firmware arms the card anyway |',
  '| S5 | Soft off | Depends on the firmware alone. On Windows it also needs Fast Startup off, firmware Wake on LAN on, and ErP off |',
  '| G3 | Power removed (unplugged, PSU switched off) | Never |',
  '',
  'A Windows target that should wake from shutdown needs Fast Startup turned off (Control Panel > Power Options > "Choose what the power buttons do"). Otherwise, put it to sleep instead of shutting it down.',
  '',
  'Source: Microsoft KB 2776718, "Wake on LAN (WOL) behavior in Windows".',
].join('\n');

const troubleshooting = [
  'Work through these in order.',
  '',
  "1. **The MAC is the wired card's.** A Wi-Fi adapter's MAC won't wake the machine through its Ethernet port. Read the Ethernet adapter's MAC on the target itself.",
  "2. **This machine is on the host's subnet.** wol_list_hosts must show `on_segment: true`; if it doesn't, the server has to run on a machine attached to that LAN.",
  "3. **The target's link light stays on while it is off or asleep.** If the port goes dark, the firmware cut standby power: disable ErP/EuP and Deep Sleep (see prerequisites).",
  '4. **The target is on Ethernet.** Wake over Wi-Fi is limited and depends on the adapter.',
  '5. **The OS armed the network card.** Check the Windows, Linux, or macOS settings in prerequisites.',
  '6. **Windows Fast Startup is off,** if the target was shut down rather than put to sleep (see sleep-states).',
  "7. **`check_port` suits the target's OS.** A `refused` outcome means the machine is awake and nothing listens on that port, or not yet. Windows rarely runs SSH, so try 3389 (RDP) or 445 (SMB).",
  "8. **The address didn't change.** A DHCP reservation keeps the profile's address pointing at the target.",
  '9. **The sender side can send.** See sender-environment for macOS Local Network permission, WSL2, VPNs, and containers.',
].join('\n');

const hostProfiles = [
  'Host profiles are a JSON array, loaded once at startup from one of two environment variables. Set one, not both:',
  '',
  "- `WOL_HOSTS_FILE`: absolute path to a JSON file. A leading `~/` expands to the home directory. Relative paths are rejected, because a stdio server runs in the MCP client's working directory. The path must name a regular file of at most 1 MiB; a directory, a pipe, or a device such as `/dev/stdin` is refused at startup.",
  '- `WOL_HOSTS`: the same JSON inline, for single-host setups or clients where a file is awkward.',
  '',
  'Edits take effect after a server restart. With neither variable set, the server starts with no hosts.',
  '',
  '| Field | Required | Default | Rules |',
  '|:--|:--|:--|:--|',
  '| `alias` | yes | | 1 to 64 characters: a letter or digit, then letters, digits, `.`, `_`, or `-`. Unique, ignoring case. |',
  '| `mac` | yes | | `00:00:5e:00:53:01`, `00-00-5E-00-53-01`, `0000.5e00.5301`, or `00005e005301`. One-digit groups are zero-padded. Group (multicast) and all-zero MACs are rejected. |',
  "| `address` | no | | IPv4 or IPv6 literal, or a DNS hostname. The probe target: without it a wake can't be confirmed. |",
  "| `broadcast` | see rules | derived | The subnet's directed broadcast, such as `192.0.2.255`. `255.255.255.255`, `0.0.0.0`, and `224.0.0.0/4` are rejected. Required unless `address` is an IPv4 literal, in which case it is derived from the matching local interface. |",
  '| `wol_port` | no | 9 | UDP destination port, 1 to 65535. |',
  '| `check_port` | no | 22 | TCP port probed to confirm the host is up. Windows hosts usually need 3389 (RDP) or 445 (SMB). |',
  '| `secureon` | no | | 6-byte SecureOn password in MAC format. Never shown or logged. |',
  '| `description` | no | | Operator note, up to 500 characters. |',
  '',
  "An empty string leaves an optional text field (`address`, `broadcast`, `secureon`, `description`) unset. The server refuses to start, naming the entry and field, on an unknown key (`checkport`, `wolPort`), an invalid value, a duplicate alias, or a profile with neither `broadcast` nor an IPv4 `address`. Whether this machine is on a host's subnet is not checked at startup, since interfaces change; wol_list_hosts reports it on each call.",
  '',
  '## Examples',
  '',
  'Linux desktop with SSH; the broadcast is derived from its IPv4 address:',
  '',
  '```json',
  '[{ "alias": "gpu-box", "mac": "00:00:5e:00:53:01", "address": "192.0.2.50", "description": "Desktop with the training GPU" }]',
  '```',
  '',
  'Windows PC, confirmed over RDP:',
  '',
  '```json',
  '[{ "alias": "gaming-pc", "mac": "00-00-5E-00-53-02", "address": "192.0.2.60", "check_port": 3389 }]',
  '```',
  '',
  'Mac mini with Remote Login (SSH) on:',
  '',
  '```json',
  '[{ "alias": "mac-mini", "mac": "0000.5e00.5303", "address": "192.0.2.70" }]',
  '```',
  '',
  'NAS addressed by hostname, so `broadcast` is required; confirmed over SMB, with a SecureOn password:',
  '',
  '```json',
  '[{ "alias": "nas", "mac": "00:00:5e:00:53:04", "address": "nas.home.arpa", "broadcast": "192.0.2.255", "check_port": 445, "secureon": "00:00:5e:00:53:ff" }]',
  '```',
].join('\n');

const senderEnvironment = [
  "The machine running this server has to put a broadcast on the target's LAN. These environments get in the way.",
  '',
  '## macOS 15 and later: Local Network privacy',
  '',
  'Sending a UDP broadcast, connecting to a local address, and resolving a `.local` name all need Local Network access. macOS grants it to the app responsible for this server, which is the app that launched it, not `node`.',
  '',
  '- **Claude Desktop**, installed from the `.mcpb` or a JSON config: the permission belongs to Claude Desktop. macOS asks once, and the grant covers every server Claude Desktop launches.',
  "- **CLI clients started from Apple's Terminal or over SSH** are allowed automatically, with no prompt.",
  '- **Third-party terminals and editors** (iTerm2, Ghostty, VS Code, Cursor, and others) are ordinary apps, so that app gets the prompt. Approve it under System Settings > Privacy & Security > Local Network.',
  '- The operation that raised the prompt can fail before it is answered, so the first wol_wake_host may return `socket_error`. Allow access, then retry.',
  '- If System Settings > Privacy & Security > Local Network lists `node` rather than the client app, enable that entry.',
  '- A denied permission makes probes read `no_answer`.',
  '- **Always-on Mac:** a `launchd` daemon, or a process running as root, is allowed automatically. A `launchd` agent is blocked until granted, and macOS can tie it to an app only through `SMAppService` or `AssociatedBundleIdentifiers`, so run the server as a daemon. On macOS 15.5 and later an administrator can instead exempt a subnet system-wide with the `com.apple.network.local-network` defaults `AllowedEthernetLocalNetworkAddresses` and `AllowedWiFiLocalNetworkAddresses` (CIDR strings, set with `sudo`, restart required).',
  '',
  'Windows and Linux have no per-app gate.',
  '',
  '## WSL2',
  '',
  "In the default NAT mode the distro sits on its own virtual subnet, so every host reads `off_segment`. Mirrored mode mirrors the Windows interfaces, but broadcast delivery through it isn't documented. Run the server on the Windows host instead.",
  '',
  '## Containers',
  '',
  "A container on a default bridge network sees only Docker's private subnet, so every LAN host reads `off_segment`. On a Linux machine attached to the LAN, run the container with `--network host` (or on a macvlan network) so it uses the LAN interface directly. Docker Desktop on macOS and Windows runs containers in a VM, so its broadcasts never reach the LAN in any network mode; run the server directly on the machine instead.",
  '',
  '## VPNs',
  '',
  'A full-tunnel VPN that captures the LAN route can divert the packet even when wol_list_hosts shows `on_segment: true`. Disconnect it, or enable its local-network access option.',
  '',
  'Sources: Apple TN3179, "Understanding local network privacy"; Microsoft, "Accessing network applications with WSL".',
].join('\n');

export const REFERENCE: Record<ReferenceTopic, ReferenceEntry> = {
  'packet-format': { title: 'Magic packet format', content: packetFormat },
  prerequisites: { title: 'Target prerequisites', content: prerequisites },
  'sleep-states': { title: 'Power states that can wake', content: sleepStates },
  troubleshooting: { title: "Troubleshooting a wake that didn't work", content: troubleshooting },
  'host-profiles': { title: 'Host profile format', content: hostProfiles },
  'sender-environment': { title: 'Sender environment', content: senderEnvironment },
};
