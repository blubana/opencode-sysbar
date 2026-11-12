# opencode-sysbar

A small sidebar plugin for the OpenCode v2 TUI. It adds a **Status** block to the session sidebar:

- current model (and variant)
- token usage for the session (input / output / cache read / reasoning) and cost
- session elapsed time and wall clock
- hardware: CPU usage and load, memory used / total, host name and core count

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
