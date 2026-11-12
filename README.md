# opencode-sysbar

A small sidebar plugin for the OpenCode v2 TUI. It adds a **Status** block to the session sidebar:

- current model (and variant), session elapsed time and wall clock
- **CPU and memory gauges** (green / yellow / red by load) with a 30-second history sparkline, plus a per-core heat strip
- **token mix bar**: input / cache read / output / reasoning as one stacked bar, with cost
- **multi-agent panel**: every session in the current family (orchestrator and its sub-agents) with a running/idle dot and a bar showing its share of the tokens
- host name, core count, load average

Plain JavaScript, no build step, read-only (it never writes files or sends data anywhere).

## Install

1. Copy this folder somewhere, e.g. `~/.config/opencode/sysbar`.
2. Add its absolute path to `plugins` in `~/.config/opencode/cli.json`:

   ```json
   { "plugins": ["/home/you/.config/opencode/sysbar"] }
   ```

3. Restart OpenCode (`opencode service restart`, then reopen the TUI).

## Notes

- Memory "used" on macOS comes from `vm_stat` (active + wired + compressed) and on Linux from `/proc/meminfo` (`MemAvailable`), because `os.freemem()` ignores reclaimable cache and reads close to 100%.
- Built against OpenCode 2.2.x (`Plugin.define`, `ui.slot({ append: "sidebar.content" })`). The plugin API is young; field names for messages (`tokens`, `model`, `cost`) are read defensively.

## License

MIT
