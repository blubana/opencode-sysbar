import { Plugin } from "@opencode/plugin/tui";
import { createElement, insert, setProp } from "@opentui/solid";
import { createSignal } from "solid-js";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

// Minimal sidebar: current model, session token usage, hardware load, elapsed time.
// Plain JS (no build step). Refreshes once per second; nothing is written anywhere.

const el = (tag, props = {}, children = []) => {
  const node = createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) setProp(node, k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) insert(node, c);
  return node;
};

const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n || 0));
const fmtT = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + "h " : "") + (h || m ? String(m).padStart(h ? 2 : 1, "0") + "m " : "") + String(r).padStart(2, "0") + "s";
};
const gb = (b) => (b / 1073741824).toFixed(1);

// os.freemem() ignores reclaimable cache on macOS/Linux and reads ~100% used; use the OS notion of "available".
let memCache = { at: 0, used: 0 };
function memUsed() {
  const now = Date.now();
  if (now - memCache.at < 3000) return memCache.used;
  let used = os.totalmem() - os.freemem();
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 1500 });
      const page = Number((out.match(/page size of (\d+)/) || [])[1]) || 16384;
      const g = (k) => Number((out.match(new RegExp(k + ":\\s+(\\d+)")) || [])[1]) || 0;
      used = (g("Pages active") + g("Pages wired down") + g("Pages occupied by compressor")) * page;
    } else if (process.platform === "linux") {
      const m = fs.readFileSync("/proc/meminfo", "utf8");
      const kb = (k) => Number((m.match(new RegExp(k + ":\\s+(\\d+)")) || [])[1]) || 0;
      used = os.totalmem() - kb("MemAvailable") * 1024;
    }
  } catch {}
  memCache = { at: now, used };
  return used;
}

function cpuSnapshot() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

export default Plugin.define({
  id: "local.sysbar",
  setup(context) {
    const started = Date.now();
    const [tick, setTick] = createSignal(0);
    let prevCpu = cpuSnapshot();
    let cpuPct = 0;
    let disposed = false;
    let busy = false;
    const sessionStart = new Map();

    async function refresh() {
      if (busy || disposed) return;
      busy = true;
      try {
        const cur = cpuSnapshot();
        const dt = cur.total - prevCpu.total;
        if (dt > 0) cpuPct = Math.round((1 - (cur.idle - prevCpu.idle) / dt) * 100);
        prevCpu = cur;
        const route = context.ui.router.current();
        if (route?.type === "session") {
          try { await context.data.session.message.sync(route.sessionID); } catch {}
        }
      } finally {
        busy = false;
        if (!disposed) setTick((t) => t + 1);
      }
    }
    const timer = setInterval(() => { void refresh(); }, 1000);
    void refresh();

    function usage(sessionID) {
      let input = 0, output = 0, reasoning = 0, cacheRead = 0, cost = 0, model, first;
      let list = [];
      try { list = context.data.session.message.list(sessionID) ?? []; } catch {}
      for (const raw of list) {
        const m = raw?.data ?? raw;
        const created = m?.time?.created ?? raw?.time_created;
        if (created && (!first || created < first)) first = created;
        if (m?.tokens) {
          input += m.tokens.input ?? 0;
          output += m.tokens.output ?? 0;
          reasoning += m.tokens.reasoning ?? 0;
          cacheRead += m.tokens.cache?.read ?? 0;
        }
        cost += m?.cost ?? 0;
        if (m?.model?.id) model = m.model;
      }
      return { input, output, reasoning, cacheRead, cost, model, first };
    }

    const removeSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const root = el("box", { width: "100%", flexDirection: "column" });
        insert(root, () => {
          tick();
          const fg = context.theme?.text?.base;
          const dim = context.theme?.text?.muted ?? fg;
          const row = (label, value) => el("box", { width: "100%", flexDirection: "row", justifyContent: "space-between" }, [
            el("text", { fg: dim }, [label]),
            el("text", { fg }, [value]),
          ]);
          const u = sessionID ? usage(sessionID) : {};
          const sel = (() => { try { return context.ui.model.current(); } catch { return undefined; } })();
          const model = u.model ?? sel;
          const modelName = model?.id ? `${model.id}${model.variant && model.variant !== "none" ? " · " + model.variant : ""}` : "—";
          const begin = u.first ?? started;
          const load = os.loadavg()[0].toFixed(2);
          const used = memUsed();
          return el("box", { width: "100%", flexDirection: "column", marginTop: 1 }, [
            el("text", { fg }, ["▼ Status"]),
            row("Model", modelName),
            row("Tokens in/out", `${fmtN(u.input)} / ${fmtN(u.output)}`),
            row("Cache read", fmtN(u.cacheRead)),
            u.reasoning ? row("Reasoning", fmtN(u.reasoning)) : null,
            u.cost ? row("Cost", "$" + u.cost.toFixed(4)) : null,
            row("Session time", fmtT(Date.now() - begin)),
            row("CPU", `${cpuPct}% · load ${load}`),
            row("Memory", `${gb(used)} / ${gb(os.totalmem())} GB`),
            row("Host", `${os.hostname().split(".")[0]} · ${os.cpus().length}c`),
            row("Clock", new Date().toLocaleTimeString("en-GB")),
          ]);
        });
        return root;
      },
    });

    return () => {
      disposed = true;
      clearInterval(timer);
      try { removeSlot?.(); } catch {}
    };
  },
});
