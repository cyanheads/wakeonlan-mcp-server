# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-10-09

Moves to mcp-ts-core 0.13.14 and publishes the first Docker image to GHCR: a Linux, multi-arch image for host or macvlan networking. Tool error results now carry their request ID, a null optional argument counts as absent, and the registry's HTTP install entry starts the server over HTTP.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-09-26

First public release: wake operator-configured LAN hosts by alias with Wake-on-LAN magic packets and confirm they came up over a TCP check port, through four wol_* tools.
