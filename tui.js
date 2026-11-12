import { Plugin } from "@opencode/plugin/tui";
import { createElement, insert, setProp } from "@opentui/solid";
import { createSignal } from "solid-js";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

// Graphical sidebar for the OpenCode v2 TUI: model, token mix, hardware gauges + history,
// per-core heat strip, and a multi-agent (session family) activity panel.
// Plain JS, no build step, read-only.

const C = {
  ok: "#3fb950", warn: "#d29922", bad: "#f85149",
  in: "#58a6ff", cache: "#39c5cf", out: "#bc8cff", reason: "#e3b341",
  dim: "#8b949e", off: "#30363d",
};
const BLOCKS = "▁▂▃▄▅▆▇█";
const MAX_AGENTS = 8;

const el = (tag, props = {}, children = []) => {
  const node = createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) setProp(node, k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) insert(node, c);
  return node;
};
const txt = (fg, s) => el("text", { fg }, [s]);
const row = (children, extra = {}) => el("box", { width: "100%", flexDirection: "row", ...extra }, children);

const level = (pct) => (pct >= 85 ? C.bad : pct >= 60 ? C.warn : C.ok);
const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n || 0)));
const fmtT = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}m` : m ? `${m}m${String(r).padStart(2, "0")}s` : `${r}s`;
};
const gb = (b) => (b / 1073741824).toFixed(1);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Horizontal gauge: filled part coloured by `color`, rest dim.
function gauge(pct, width, color) {
  const filled = Math.round((clamp(pct, 0, 100) / 100) * width);
  return row([txt(color, "█".repeat(filled)), txt(C.off, "░".repeat(width - filled))]);
}
// Stacked bar from [{v, color}] segments, scaled to `width` cells (largest remainder so it always fills).
function stacked(parts, width) {
  const total = parts.reduce((a, p) => a + p.v, 0);
  if (total <= 0) return row([txt(C.off, "░".repeat(width))]);
  let used = 0;
  const cells = parts.map((p) => {
    const n = Math.floor((p.v / total) * width);
    used += n;
    return { ...p, n, frac: (p.v / total) * width - n };
  });
  for (const c of [...cells].sort((a, b) => b.frac - a.frac)) {
    if (used >= width) break;
    if (c.v > 0) { c.n++; used++; }
  }
  return row(cells.filter((c) => c.n > 0).map((c) => txt(c.color, "█".repeat(c.n))));
}

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

function cpuTimes() {
  return os.cpus().map((c) => {
    let total = 0;
    for (const v of Object.values(c.times)) total += v;
    return { idle: c.times.idle, total };
  });
}

const isBusy = (st) => {
  const v = typeof st === "string" ? st : st?.type ?? st?.status ?? "";
  return /run|busy|retry|work/i.test(String(v));
};

export default Plugin.define({
  id: "local.sysbar",
  setup(context) {
    const started = Date.now();
    const [tick, setTick] = createSignal(0);
    let prev = cpuTimes();
    let cores = prev.map(() => 0);
    let cpuPct = 0;
    let disposed = false;
    let busy = false;

    function sampleHardware() {
      const cur = cpuTimes();
      let di = 0, dt = 0;
      cores = cur.map((c, i) => {
        const p = prev[i] ?? c;
        const t = c.total - p.total, idle = c.idle - p.idle;
        di += idle; dt += t;
        return t > 0 ? Math.round((1 - idle / t) * 100) : 0;
      });
      if (dt > 0) cpuPct = Math.round((1 - di / dt) * 100);
      prev = cur;
      memUsed(); // refresh the cached reading
    }

    // Root session + its children (sub-agents), capped.
    function family(sessionID) {
      if (!sessionID) return [];
      let root = sessionID;
      try { root = context.data.session.root(sessionID) ?? sessionID; } catch {}
      let kids = [];
      try { kids = context.data.session.family(root) ?? []; } catch {}
      return [...new Set([root, ...kids])].slice(0, MAX_AGENTS);
    }

    async function refresh() {
      if (busy || disposed) return;
      busy = true;
      try {
        sampleHardware();
        const route = context.ui.router.current();
        if (route?.type === "session") {
          await Promise.allSettled(family(route.sessionID).map((id) => context.data.session.message.sync(id)));
        }
      } finally {
        busy = false;
        if (!disposed) setTick((t) => t + 1);
      }
    }
    const timer = setInterval(() => { void refresh(); }, 1000);
    void refresh();

    function usage(sessionID) {
      const u = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0, model: undefined, agent: undefined, first: undefined };
      let list = [];
      try { list = context.data.session.message.list(sessionID) ?? []; } catch {}
      for (const raw of list) {
        const m = raw?.data ?? raw;
        const created = m?.time?.created ?? raw?.time_created;
        if (created && (!u.first || created < u.first)) u.first = created;
        if (m?.tokens) {
          u.input += m.tokens.input ?? 0;
          u.output += m.tokens.output ?? 0;
          u.reasoning += m.tokens.reasoning ?? 0;
          u.cacheRead += m.tokens.cache?.read ?? 0;
        }
        u.cost += m?.cost ?? 0;
        if (m?.model?.id) u.model = m.model;
        if (m?.agent) u.agent = m.agent;
      }
      return u;
    }

    const removeSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const root = el("box", { width: "100%", flexDirection: "column" });
        insert(root, () => {
          tick();
          const fg = context.theme?.text?.base;
          const label = (l, r, rc) => row([txt(C.dim, l), el("box", { flexGrow: 1 }), txt(rc ?? fg, r)]);
          const W = 28;

          const ids = family(sessionID);
          const usages = ids.map((id) => ({ id, u: usage(id) }));
          const mine = usages.find((x) => x.id === sessionID)?.u ?? usage(sessionID ?? "");
          const sel = (() => { try { return context.ui.model.current(); } catch { return undefined; } })();
          const model = mine.model ?? sel;
          const modelName = model?.id ? `${model.id}${model.variant && model.variant !== "none" ? " · " + model.variant : ""}` : "—";
          const begin = mine.first ?? started;

          const memTotal = os.totalmem(), memUsedB = memUsed();
          const memPct = Math.round((memUsedB / memTotal) * 100);

          const out = [
            txt(fg, "▼ Status"),
            label("Model", modelName),
            label("Time", `${fmtT(Date.now() - begin)} · ${new Date().toLocaleTimeString("en-GB")}`),
            txt(fg, " "),
            // --- hardware ---
            label("CPU", `${cpuPct}%`, level(cpuPct)),
            gauge(cpuPct, W, level(cpuPct)),
            row(cores.slice(0, W).map((p) => txt(level(p), BLOCKS[clamp(Math.round((p / 100) * 7), 0, 7)]))),
            label("Memory", `${gb(memUsedB)}/${gb(memTotal)}G ${memPct}%`, level(memPct)),
            gauge(memPct, W, level(memPct)),
            label("Host", `${os.hostname().split(".")[0].replace(/s?-?mac.*$/i, "") || os.hostname().slice(0, 8)} · ${os.cpus().length}c · ${os.loadavg()[0].toFixed(1)}`),
            txt(fg, " "),
            // --- tokens ---
            label("Tokens", `${fmtN(mine.input)} in · ${fmtN(mine.output)} out`),
            stacked([
              { v: mine.input, color: C.in },
              { v: mine.cacheRead, color: C.cache },
              { v: mine.output, color: C.out },
              { v: mine.reasoning, color: C.reason },
            ], W),
            row([
              txt(C.in, "■ in "), txt(C.cache, "■ cache "), txt(C.out, "■ out "), mine.reasoning ? txt(C.reason, "■ think") : null,
            ]),
            mine.cost ? label("Cost", "$" + mine.cost.toFixed(4)) : null,
          ];

          // --- agents (session family) ---
          if (usages.length > 1 || usages.some((x) => x.u.agent)) {
            const grand = usages.reduce((a, x) => a + x.u.input + x.u.output + x.u.reasoning, 0) || 1;
            out.push(txt(fg, " "));
            const running = usages.filter((x) => { try { return isBusy(context.data.session.status(x.id)); } catch { return false; } }).length;
            out.push(label(`Agents (${usages.length})`, running ? `${running} running` : "idle", running ? C.ok : C.dim));
            for (const { id, u } of usages) {
              let b = false;
              try { b = isBusy(context.data.session.status(id)); } catch {}
              let info; try { info = context.data.session.get(id); } catch {}
              const name = String(u.agent ?? info?.agent ?? info?.title ?? (id === ids[0] ? "main" : "sub-agent")).slice(0, 14);
              const share = (u.input + u.output + u.reasoning) / grand;
              const dot = b ? (Math.floor(Date.now() / 500) % 2 ? "●" : "◉") : "○";
              out.push(row([txt(b ? C.ok : C.dim, dot + " "), txt(fg, name), el("box", { flexGrow: 1 }), txt(C.dim, `${fmtN(u.input + u.output)} · ${Math.round(share * 100)}%`)]));
              const mm = u.model ?? info?.model;
              const mid = typeof mm === "string" ? mm : mm?.id;
              const mvar = typeof mm === "object" && mm?.variant && mm.variant !== "none" ? " · " + mm.variant : "";
              const mprov = typeof mm === "object" && mm?.providerID ? mm.providerID + "/" : "";
              const full = mid ? mprov + mid + mvar : "model: pending";
              const short = full.length > W - 2 ? (mid + mvar) : full;
              out.push(txt(C.dim, "  " + (short.length > W - 2 ? short.slice(0, W - 3) + "…" : short)));
              out.push(gauge(share * 100, W, b ? C.ok : C.in));
            }
          }
          return el("box", { width: "100%", flexDirection: "column", marginTop: 1 }, out);
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
