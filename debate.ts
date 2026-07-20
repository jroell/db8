#!/usr/bin/env bun
/**
 * AGORA · adversarial reasoning arena
 * ------------------------------------------------------------------
 * Claude Code and OpenAI Codex debate any topic you give them, round
 * by round, refereed by a two-judge AI panel that scores every round
 * and ends the debate only when it is convinced beyond persuasion.
 *
 * Single-file Bun script. Dependencies auto-install on first run via
 * Bun's versioned import specifiers (your editor may underline the
 * import lines; `bun` resolves them natively, no npm install needed).
 *
 * Run:            bun debate.ts
 * One-shot:       bun debate.ts --topic "Is nuclear power the answer?" --rounds 4
 * No internet:    bun debate.ts --no-web
 * UI dry run:     DEBATE_MOCK=1 bun debate.ts --topic "tabs vs spaces" --auto
 *
 * Requires the `claude` and `codex` CLIs installed and logged in.
 */

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/* ================================================================== *
 * §0 SELF-BOOTSTRAP · install UI deps beside this file on first run
 * ================================================================== */

const DEP_PINS: Record<string, string> = {
  chalk: "^5.6.0",
  "@clack/prompts": "^0.11.0",
  boxen: "^8.0.1",
  "cli-table3": "^0.6.5",
  "wrap-ansi": "^9.0.0",
};

async function loadDeps(): Promise<Record<string, any>> {
  const names = Object.keys(DEP_PINS);
  const importAll = () => Promise.all(names.map((n) => import(n)));
  try {
    const mods = await importAll();
    return Object.fromEntries(names.map((n, i) => [n, mods[i]]));
  } catch {
    if (process.env.DEBATE_BOOTSTRAPPED === "1") {
      console.error("dependencies still unresolvable after install; try deleting node_modules next to debate.ts and re-running.");
      process.exit(1);
    }
    process.stdout.write("first run · installing UI dependencies next to debate.ts …\n");
    const dir = import.meta.dir;
    const pkgPath = path.join(dir, "package.json");
    const wantedDeps = { ...DEP_PINS, "bun-types": "^1.3.0" };
    // A local package.json keeps `bun install` anchored HERE, never in a parent project.
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({ name: "agora-debate", private: true, dependencies: wantedDeps }, null, 2) + "\n");
    } else {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      pkg.dependencies = { ...pkg.dependencies, ...wantedDeps };
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
    const tsconfigPath = path.join(dir, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) {
      fs.writeFileSync(tsconfigPath, JSON.stringify({
        compilerOptions: { lib: ["ESNext"], target: "ESNext", module: "ESNext", moduleResolution: "bundler", types: ["bun-types"], noEmit: true },
      }, null, 2) + "\n");
    }
    const res = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "inherit", stderr: "inherit" });
    if (res.exitCode !== 0) {
      console.error(`could not install dependencies (network?). Try: cd ${dir} && bun install`);
      process.exit(1);
    }
    // Re-exec: the current process has already cached the failed resolutions.
    const rerun = Bun.spawnSync([process.execPath, "run", Bun.main, ...Bun.argv.slice(2)], {
      cwd: process.cwd(), env: { ...process.env, DEBATE_BOOTSTRAPPED: "1" },
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    process.exit(rerun.exitCode ?? 0);
  }
}

const _deps = await loadDeps();
const chalk = _deps["chalk"].default;
const clack = _deps["@clack/prompts"];
const boxen = _deps["boxen"].default;
const Table = _deps["cli-table3"].default;
const wrapAnsi = _deps["wrap-ansi"].default;

/* ================================================================== *
 * §1 THEME · Dracula
 * ================================================================== */

const P = {
  bg: "#282a36", cur: "#44475a", fg: "#f8f8f2", comment: "#6272a4",
  cyan: "#8be9fd", green: "#50fa7b", orange: "#ffb86c", pink: "#ff79c6",
  purple: "#bd93f9", red: "#ff5555", yellow: "#f1fa8c",
};

const c = {
  a: chalk.hex(P.purple),          // Claude debater
  b: chalk.hex(P.green),           // Codex debater
  ja: chalk.hex(P.yellow),         // Claude judge
  jb: chalk.hex(P.orange),         // Codex judge
  user: chalk.hex(P.cyan),
  think: chalk.hex(P.comment).italic,
  dim: chalk.hex(P.comment),
  err: chalk.hex(P.red),
  ok: chalk.hex(P.green),
  pink: chalk.hex(P.pink),
  fg: chalk.hex(P.fg),
  warn: chalk.hex(P.orange),
};

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const cols = () => Math.max(40, Math.min(process.stdout.columns ?? 100, 110));

function gradientText(s: string, stops: string[]): string {
  const chars = [...s];
  const hex2rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgbs = stops.map(hex2rgb);
  return chars
    .map((ch, i) => {
      if (ch === " " || ch === "\n") return ch;
      const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
      const seg = Math.min(Math.floor(t * (rgbs.length - 1)), rgbs.length - 2);
      const lt = t * (rgbs.length - 1) - seg;
      const [r, g, b] = rgbs[seg].map((v, k) => Math.round(v + (rgbs[seg + 1][k] - v) * lt));
      return chalk.rgb(r, g, b)(ch);
    })
    .join("");
}

/* ================================================================== *
 * §2 MARKDOWN → ANSI (hand-rolled, Dracula-tuned)
 * ================================================================== */

function inlineMd(s: string): string {
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, x) => {
    codes.push(chalk.bgHex(P.cur).hex(P.cyan)(` ${x} `));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, (_, x) => chalk.hex(P.orange).bold.italic(x));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, x) => chalk.hex(P.orange).bold(x));
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_, x) => chalk.hex(P.yellow).italic(x));
  s = s.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, (_, x) => chalk.hex(P.yellow).italic(x));
  s = s.replace(/~~([^~]+)~~/g, (_, x) => chalk.strikethrough.hex(P.comment)(x));
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => chalk.hex(P.cyan).underline(t) + c.dim(` (${u})`));
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
  return s;
}

function renderMarkdown(src: string, width: number): string {
  const out: string[] = [];
  const lines = src.replace(/\r/g, "").split("\n");
  let inFence = false;
  let fence: string[] = [];
  let fenceLang = "";
  const wrap = (s: string, indent = 0, hang = indent) => {
    const w = Math.max(20, width - indent);
    const wrapped: string[] = wrapAnsi(s, w, { trim: false }).split("\n");
    return wrapped.map((l: string, i: number) => " ".repeat(i === 0 ? indent : hang) + l);
  };
  const flushFence = () => {
    const inner = Math.max(...fence.map((l) => l.length), 10);
    if (fenceLang) out.push(c.dim(`  ╭ ${fenceLang}`));
    for (const l of fence) out.push("  " + chalk.bgHex(P.cur).hex(P.cyan)(" " + l.padEnd(Math.min(inner, width - 6)) + " "));
    fence = [];
    fenceLang = "";
  };
  for (const raw of lines) {
    const fenceMatch = raw.match(/^\s*```(\w*)\s*$/);
    if (fenceMatch) {
      if (inFence) flushFence();
      else fenceLang = fenceMatch[1];
      inFence = !inFence;
      continue;
    }
    if (inFence) { fence.push(raw); continue; }
    if (/^\s*$/.test(raw)) { out.push(""); continue; }
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,6})\s+(.*)$/))) {
      const level = m[1].length;
      const text = inlineMd(m[2]);
      out.push("");
      if (level === 1) out.push(chalk.hex(P.pink).bold.underline(text.toUpperCase()));
      else if (level === 2) out.push(chalk.hex(P.pink).bold(text));
      else out.push(chalk.hex(P.pink)(text));
      continue;
    }
    if (/^ {0,3}([-_*]){3,}\s*$/.test(raw)) { out.push(c.dim("· ".repeat(Math.floor(width / 4)))); continue; }
    if ((m = raw.match(/^>\s?(.*)$/))) {
      for (const l of wrap(c.think(inlineMd(m[1])), 0)) out.push(c.dim("▎ ") + l);
      continue;
    }
    if ((m = raw.match(/^(\s*)[-*+]\s+(.*)$/))) {
      const ind = m[1].length;
      const body = wrap(inlineMd(m[2]), 0);
      out.push(" ".repeat(ind) + c.pink("•") + " " + body[0].trimStart());
      for (const l of body.slice(1)) out.push(" ".repeat(ind + 2) + l.trimStart());
      continue;
    }
    if ((m = raw.match(/^(\s*)(\d+)\.\s+(.*)$/))) {
      const ind = m[1].length;
      const body = wrap(inlineMd(m[3]), 0);
      out.push(" ".repeat(ind) + c.pink(m[2] + ".") + " " + body[0].trimStart());
      for (const l of body.slice(1)) out.push(" ".repeat(ind + m[2].length + 2) + l.trimStart());
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue;
      out.push("  " + raw.trim().split("|").filter((_x, i, a) => i > 0 && i < a.length - 1)
        .map((cell) => inlineMd(cell.trim())).join(c.dim("  │  ")));
      continue;
    }
    out.push(...wrap(c.fg(inlineMd(raw))));
  }
  if (inFence) flushFence();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

/* ================================================================== *
 * §3 TYPES
 * ================================================================== */

type AgentEvent =
  | { kind: "session"; id: string }
  | { kind: "thinking"; text: string }
  | { kind: "text-delta"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "notice"; text: string };

interface Usage { inTok: number; outTok: number; costUsd?: number }

interface TurnResult {
  text: string;
  thinking: string;
  structured?: unknown;
  usage: Usage;
  durationMs: number;
}

interface TurnOptions { prompt: string; images?: string[]; schema?: object }

interface AgentBackend {
  readonly backend: "claude" | "codex" | "mock";
  sessionId: string | null;
  reset(): void;
  runTurn(o: TurnOptions): AsyncGenerator<AgentEvent, TurnResult>;
}

type Paint = ((s: string) => string) & { bold: (s: string) => string };

interface Participant {
  key: "a" | "b" | "ja" | "jb";
  label: string;        // "CLAUDE"
  role: string;         // "PRO" | "CON" | "THESIS" | "ANTITHESIS" | "JUDGE"
  hex: string;
  paint: Paint;
  agent: AgentBackend;
}

interface Attachment { path: string; kind: "image" | "pdf" | "text" | "other"; text?: string; note?: string }

interface DebateSetup {
  topic: string;
  rawTopic?: string;                  // the user's original wording, when sharpened
  attachments: Attachment[];
  mode: "assigned" | "dialectic";
  stanceA: string; stanceB: string;   // instructions
  roleA: string; roleB: string;       // display labels
}

interface Crux { id: string; description: string; status: string }

interface RoundVerdict {
  judge: "ja" | "jb";
  round: number;
  onTrack: boolean;
  steeringNote: string;
  scores: { a: Record<string, number>; b: Record<string, number> };
  roundWinner: "a" | "b" | "tie";
  cruxes: Crux[];
  nextFocus: { a: string; b: string };
  clarifications: string[];
  verdictReached: boolean;
  confidence: number;
  leaning: "a" | "b" | "undecided";
  commentary: string;
  degraded?: boolean;
}

interface FinalVerdict {
  judge: "ja" | "jb";
  winner: "a" | "b" | "draw";
  confidence: number;
  bestArguments: { a: string[]; b: string[] };
  worstArguments: { a: string[]; b: string[] };
  decidingFactors: string;
  steelman: { a: string; b: string };
  anticipatedAttacks: { a: string[]; b: string[] };
  commentary: string;
  degraded?: boolean;
}

interface Turn {
  speaker: "a" | "b"; round: number;
  kind: "opening" | "rebuttal" | "steelman" | "forfeit";
  text: string; thinking: string; usage: Usage; durationMs: number;
}

interface DebateState {
  setup: DebateSetup;
  startedAt: number;
  round: number;
  turns: Turn[];
  verdicts: RoundVerdict[];
  finals: FinalVerdict[];
  cruxes: Map<string, Map<string, Crux>>;   // judgeKey -> cruxId -> crux
  notes: { round: number; from: string; text: string }[];
  totals: { costUsd: number; inTok: number; outTok: number };
  endReason?: "panel" | "cap" | "user" | "abandoned";
  endDetail?: string;
}

interface Config {
  rounds: number; allowWeb: boolean;
  judgeMode: "panel" | "claude" | "codex";
  modelA: string; effortA: string;          // claude debater ("" model = CLI default)
  modelB: string; effortB: string;          // codex debater
  judgeModelA: string; judgeEffortA: string;
  judgeModelB: string; judgeEffortB: string;
  pause: boolean; sideMode: "auto" | "dialectic"; sharpen: boolean;
  auto: boolean; mock: boolean; debugEvents: boolean; fast: boolean; tty: boolean;
}

class TurnFailure extends Error {
  constructor(msg: string, public stderrTail: string[] = []) { super(msg); }
}
class AbandonDebate extends Error {}

/* ================================================================== *
 * §4 WORKDIR & GLOBALS
 * ================================================================== */

const WORKDIR = import.meta.dir;
const TMP = path.join(WORKDIR, ".debate-tmp");
const TRANSCRIPTS = path.join(WORKDIR, "transcripts");
const AXES = ["logic", "evidence", "rebuttal", "persuasion"] as const;
const RAMP = [2, 1.01, 0.95, 0.85, 0.75, 0.65, 0.55]; // stop threshold by round; index 0 unused

const RUNSTAMP = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const REGISTRY = new Set<{ kill(): void }>();
let ACTIVE_ABORT: AbortController | null = null;
let SIGINT_HIT = 0;

function installSignalHandlers(ui: LiveArea) {
  process.on("SIGINT", () => {
    SIGINT_HIT++;
    if (SIGINT_HIT === 1 && ACTIVE_ABORT) {
      ui.log(c.err("\n ^C · aborting the current turn (press again to quit)"));
      ACTIVE_ABORT.abort();
    } else {
      for (const p of REGISTRY) p.kill();
      process.stdout.write("\x1b[?25h\n");
      process.exit(130);
    }
  });
  process.on("exit", () => {
    for (const p of REGISTRY) p.kill();
    process.stdout.write("\x1b[?25h");
  });
}

/* ================================================================== *
 * §5 LIVE AREA (log scrollback + one ephemeral status line)
 * ================================================================== */

class LiveArea {
  #status = "";
  #timer: ReturnType<typeof setInterval> | null = null;
  #frame = 0;
  readonly tty = process.stdout.isTTY ?? false;

  log(s = "") {
    if (this.tty && this.#status) process.stdout.write("\r\x1b[2K");
    process.stdout.write(s + "\n");
    this.#paint();
  }
  setStatus(plain: string) {
    this.#status = plain;
    if (this.tty && plain && !this.#timer) {
      this.#timer = setInterval(() => { this.#frame++; this.#paint(); }, 90);
    }
    this.#paint();
  }
  clearStatus() {
    this.#status = "";
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    if (this.tty) process.stdout.write("\r\x1b[2K");
  }
  #paint() {
    if (!this.tty || !this.#status) return;
    const budget = (process.stdout.columns ?? 80) - 4;
    const text = this.#status.length > budget ? this.#status.slice(0, budget - 1) + "…" : this.#status;
    process.stdout.write("\r\x1b[2K " + c.pink(SPIN[this.#frame % SPIN.length]) + " " + c.dim(text));
  }
}

class StreamingWrap {
  #buf = "";
  #lines = 0;
  #printedAny = false;
  #pendingBlank = false;
  suppressedAt = 300;
  constructor(private width: number, private style: (s: string) => string,
              private ui: LiveArea, private gutter: string) {}
  get lineCount() { return this.#lines; }
  push(t: string) { this.#buf += t.replace(/\r/g, ""); this.#emit(false); }
  flush() { this.#emit(true); this.#buf = ""; this.#pendingBlank = false; }
  #emit(final: boolean) {
    if (!this.#buf) return;
    const wrapped = wrapAnsi(this.#buf, this.width, { trim: false, hard: true }).split("\n");
    const n = final ? wrapped.length : wrapped.length - 1;
    for (let i = 0; i < n; i++) this.#printLine(wrapped[i]);
    this.#buf = final ? "" : wrapped[wrapped.length - 1] ?? "";
  }
  #printLine(line: string) {
    if (!line.trim()) { this.#pendingBlank = this.#printedAny; return; }
    if (this.#pendingBlank) { this.#out(""); this.#pendingBlank = false; }
    this.#out(line);
  }
  #out(line: string) {
    this.#lines++;
    this.#printedAny = true;
    if (this.#lines === this.suppressedAt) this.ui.log(this.gutter + c.dim("… (thinking continues, kept for the transcript)"));
    if (this.#lines < this.suppressedAt) this.ui.log(this.gutter + this.style(line));
  }
}

/* ================================================================== *
 * §6 SUBPROCESS · line-buffered JSONL
 * ================================================================== */

interface SpawnOpts {
  cwd: string; timeoutMs: number; env?: Record<string, string | undefined>;
  signal?: AbortSignal; debugFile?: string;
}

class JsonlProcess {
  #proc: ReturnType<typeof Bun.spawn>;
  stderrTail: string[] = [];
  timedOut = false;
  aborted = false;
  #killTimer: ReturnType<typeof setTimeout> | null = null;
  #timeoutTimer: ReturnType<typeof setTimeout>;

  constructor(cmd: string[], private opts: SpawnOpts) {
    if (opts.debugFile) fs.appendFileSync(opts.debugFile, JSON.stringify({ type: "_argv", cmd }) + "\n");
    this.#proc = Bun.spawn(cmd, {
      cwd: opts.cwd, env: opts.env ?? process.env,
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    REGISTRY.add(this);
    this.#timeoutTimer = setTimeout(() => { this.timedOut = true; this.kill(); }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", () => { this.aborted = true; this.kill(); });
    this.#drainStderr();
    this.#proc.exited.finally(() => {
      clearTimeout(this.#timeoutTimer);
      if (this.#killTimer) clearTimeout(this.#killTimer);
      REGISTRY.delete(this);
    });
  }

  get exited(): Promise<number> { return this.#proc.exited; }

  kill() {
    try { this.#proc.kill(); } catch {}
    this.#killTimer = setTimeout(() => { try { this.#proc.kill(9); } catch {} }, 2000);
  }

  async #drainStderr() {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of this.#proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const l of parts) if (l.trim()) {
          this.stderrTail.push(l);
          if (this.stderrTail.length > 50) this.stderrTail.shift();
        }
      }
    } catch {}
  }

  async *lines(): AsyncGenerator<unknown> {
    const dec = new TextDecoder();
    let buf = "";
    const debug = this.opts.debugFile ? fs.createWriteStream(this.opts.debugFile, { flags: "a" }) : null;
    try {
      for await (const chunk of this.#proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          debug?.write(line + "\n");
          try { yield JSON.parse(line); } catch {}
        }
      }
      if (buf.trim()) { debug?.write(buf + "\n"); try { yield JSON.parse(buf); } catch {} }
    } finally { debug?.end(); }
  }
}

function pump<T, R>(gen: AsyncGenerator<T, R>): AsyncGenerator<T, R> {
  type Msg = { r?: IteratorResult<T, R>; e?: unknown };
  const items: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
  const push = (m: Msg) => { const w = waiters.shift(); if (w) w(m); else items.push(m); };
  const shift = (): Promise<Msg> =>
    items.length ? Promise.resolve(items.shift()!) : new Promise((r) => waiters.push(r));
  (async () => {
    try {
      while (true) { const r = await gen.next(); push({ r }); if (r.done) return; }
    } catch (e) { push({ e }); }
  })();
  return (async function* () {
    while (true) {
      const m = await shift();
      if (m.e) throw m.e;
      if (m.r!.done) return m.r!.value as R;
      yield m.r!.value as T;
    }
  })() as AsyncGenerator<T, R>;
}

/* ================================================================== *
 * §7 BACKENDS · Claude Code / Codex / Mock
 * ================================================================== */

interface BackendCfg { model?: string; effort?: string; allowWeb: boolean; timeoutMs: number; debugEvents: boolean }

function claudeEnv(): Record<string, string | undefined> {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

function toolDetail(_name: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const pick = input.file_path ?? input.query ?? input.url ?? input.pattern ?? input.command;
  return typeof pick === "string" ? pick.slice(0, 80) : undefined;
}

class ClaudeAgent implements AgentBackend {
  readonly backend = "claude" as const;
  sessionId: string | null = null;
  #turn = 0;
  constructor(private bin: string, private cfg: BackendCfg, private tag: string) {}
  reset() { this.sessionId = null; this.#turn = 0; }

  async *runTurn(o: TurnOptions): AsyncGenerator<AgentEvent, TurnResult> {
    const started = Date.now();
    this.#turn++;
    const allowed = ["Read", "Glob", "Grep", ...(this.cfg.allowWeb ? ["WebSearch", "WebFetch"] : [])];
    const denied = ["Bash", "Write", "Edit", "NotebookEdit", "Task",
      ...(this.cfg.allowWeb ? [] : ["WebSearch", "WebFetch"])];
    const args = [
      "--print", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--setting-sources", "",
      "--allowedTools", allowed.join(","), "--disallowedTools", denied.join(","),
    ];
    if (this.cfg.model) args.push("--model", this.cfg.model);
    if (this.cfg.effort) args.push("--effort", this.cfg.effort);
    if (o.schema) args.push("--json-schema", JSON.stringify(o.schema));
    if (this.sessionId) args.push("--resume", this.sessionId);
    args.push(o.prompt);

    const debugFile = this.cfg.debugEvents ? path.join(TMP, `events-${RUNSTAMP}-${this.tag}-${this.#turn}.jsonl`) : undefined;
    const proc = new JsonlProcess([this.bin, ...args],
      { cwd: WORKDIR, timeoutMs: this.cfg.timeoutMs, env: claudeEnv(), signal: ACTIVE_ABORT?.signal, debugFile });

    let thinking = "", finalText = "", structured: unknown;
    let usage: Usage = { inTok: 0, outTok: 0 };
    let gotResult = false, isError = false, errMsg = "";

    for await (const raw of proc.lines()) {
      const j = raw as Record<string, any>;
      switch (j.type) {
        case "system":
          if (j.subtype === "init" && j.session_id) { this.sessionId = j.session_id; yield { kind: "session", id: j.session_id }; }
          break;
        case "stream_event": {
          const e = j.event;
          if (e?.type === "content_block_delta") {
            if (e.delta?.type === "thinking_delta" && e.delta.thinking) { thinking += e.delta.thinking; yield { kind: "thinking", text: e.delta.thinking }; }
            else if (e.delta?.type === "text_delta" && e.delta.text) yield { kind: "text-delta", text: e.delta.text };
          }
          break;
        }
        case "assistant": {
          for (const b of j.message?.content ?? []) {
            if (b?.type === "tool_use") yield { kind: "tool", name: b.name, detail: toolDetail(b.name, b.input) };
          }
          break;
        }
        case "result": {
          gotResult = true;
          if (j.session_id) this.sessionId = j.session_id;
          if (j.is_error || (j.subtype && j.subtype !== "success")) { isError = true; errMsg = String(j.result ?? j.subtype ?? "unknown error"); }
          finalText = typeof j.result === "string" ? j.result : finalText;
          structured = j.structured_output ?? undefined;
          const u = j.usage ?? {};
          usage = {
            inTok: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            outTok: u.output_tokens ?? 0,
            costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined,
          };
          break;
        }
      }
    }

    const code = await proc.exited;
    if (proc.aborted) throw new TurnFailure("turn aborted");
    if (proc.timedOut) throw new TurnFailure(`claude timed out after ${Math.round(this.cfg.timeoutMs / 1000)}s`, proc.stderrTail);
    if (isError) throw new TurnFailure(`claude error: ${errMsg.slice(0, 300)}`, proc.stderrTail);
    if (code !== 0 || !gotResult) throw new TurnFailure(`claude exited ${code} without a result`, proc.stderrTail);
    return { text: finalText, thinking, structured, usage, durationMs: Date.now() - started };
  }
}

class CodexAgent implements AgentBackend {
  readonly backend = "codex" as const;
  sessionId: string | null = null;
  #turn = 0;
  constructor(private bin: string, private cfg: BackendCfg, private tag: string) {}
  reset() { this.sessionId = null; this.#turn = 0; }

  #schemaFile(schema: object): string {
    const body = JSON.stringify(schema);
    const hash = Bun.hash(body).toString(36);
    const p = path.join(TMP, `schema-${hash}.json`);
    if (!fs.existsSync(p)) fs.writeFileSync(p, body);
    return p;
  }

  async *runTurn(o: TurnOptions): AsyncGenerator<AgentEvent, TurnResult> {
    const started = Date.now();
    this.#turn++;
    const imgArgs = (o.images ?? []).flatMap((i) => ["-i", i]);
    const schemaArgs = o.schema ? ["--output-schema", this.#schemaFile(o.schema)] : [];
    const effortArgs = this.cfg.effort ? ["-c", `model_reasoning_effort="${this.cfg.effort}"`] : [];
    const args = this.sessionId
      ? ["exec", "resume", this.sessionId, "--json", "-c", 'sandbox_mode="read-only"',
         ...(this.cfg.model ? ["-c", `model="${this.cfg.model}"`] : []), ...effortArgs,
         ...(this.cfg.allowWeb ? ["-c", "tools.web_search=true"] : []), ...schemaArgs, ...imgArgs, o.prompt]
      : ["exec", "--json", "--skip-git-repo-check", "-s", "read-only",
         ...(this.cfg.allowWeb ? ["-c", "tools.web_search=true"] : []),
         ...(this.cfg.model ? ["-m", this.cfg.model] : []), ...effortArgs, ...schemaArgs, ...imgArgs, o.prompt];

    const debugFile = this.cfg.debugEvents ? path.join(TMP, `events-${RUNSTAMP}-${this.tag}-${this.#turn}.jsonl`) : undefined;
    const proc = new JsonlProcess([this.bin, ...args],
      { cwd: WORKDIR, timeoutMs: this.cfg.timeoutMs, signal: ACTIVE_ABORT?.signal, debugFile });

    let thinking = "";
    let pendingMsg: string | null = null;   // codex narrates before tool calls; only the LAST agent_message is the answer
    const reasonSeen = new Map<string, number>();
    let usage: Usage = { inTok: 0, outTok: 0 };
    let completed = false, failMsg = "";

    for await (const raw of proc.lines()) {
      const j = raw as Record<string, any>;
      switch (j.type) {
        case "thread.started":
          if (j.thread_id) { this.sessionId = j.thread_id; yield { kind: "session", id: j.thread_id }; }
          break;
        case "item.started":
        case "item.updated":
        case "item.completed": {
          const it = j.item ?? {};
          if (it.type === "reasoning") {
            const text: string = it.text ?? it.summary ?? "";
            const seen = reasonSeen.get(it.id ?? "?") ?? 0;
            if (text.length > seen) {
              const delta = text.slice(seen);
              reasonSeen.set(it.id ?? "?", text.length);
              thinking += delta;
              yield { kind: "thinking", text: delta };
            }
          } else if (it.type === "agent_message" && j.type === "item.completed") {
            if (typeof it.text === "string") {
              if (pendingMsg !== null) {
                // The previous message was a work-in-progress preamble, not the statement.
                thinking += `\n[aside] ${pendingMsg}\n`;
                yield { kind: "notice", text: pendingMsg.replace(/\s+/g, " ").slice(0, 200) };
              }
              pendingMsg = it.text;
            }
          } else if (it.type === "command_execution" && j.type === "item.started") {
            yield { kind: "tool", name: "shell", detail: String(it.command ?? "").slice(0, 80) };
          } else if (it.type === "web_search" && j.type === "item.started") {
            yield { kind: "tool", name: "web_search", detail: String(it.query ?? "").slice(0, 80) };
          } else if (it.type === "error") {
            yield { kind: "notice", text: String(it.message ?? "codex notice").slice(0, 160) };
          }
          break;
        }
        case "turn.completed": {
          completed = true;
          const u = j.usage ?? {};
          usage = { inTok: u.input_tokens ?? 0, outTok: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) };
          break;
        }
        case "turn.failed":
        case "error":
          failMsg = String(j.error?.message ?? j.message ?? "codex turn failed");
          break;
      }
    }

    const code = await proc.exited;
    if (proc.aborted) throw new TurnFailure("turn aborted");
    if (proc.timedOut) throw new TurnFailure(`codex timed out after ${Math.round(this.cfg.timeoutMs / 1000)}s`, proc.stderrTail);
    if (failMsg) throw new TurnFailure(`codex error: ${failMsg.slice(0, 300)}`, proc.stderrTail);
    if (code !== 0 || !completed) throw new TurnFailure(`codex exited ${code} without completing the turn`, proc.stderrTail);
    return { text: pendingMsg ?? "", thinking, usage, durationMs: Date.now() - started };
  }
}

/* ---------- Mock backend (DEBATE_MOCK=1): full UI, zero tokens ---------- */

class MockAgent implements AgentBackend {
  readonly backend = "mock" as const;
  sessionId: string | null = null;
  constructor(private who: "a" | "b" | "ja" | "jb") {}
  reset() { this.sessionId = null; }

  async *runTurn(o: TurnOptions): AsyncGenerator<AgentEvent, TurnResult> {
    const started = Date.now();
    this.sessionId ??= `mock-${this.who}-${Math.random().toString(36).slice(2, 8)}`;
    yield { kind: "session", id: this.sessionId };
    const round = Number(o.prompt.match(/ROUND (\d+)/)?.[1] ?? 1);
    const isFinal = /FINAL VERDICT/.test(o.prompt);
    const chunks = [
      "Weighing the strongest form of the opposing case before committing to a line of attack. ",
      "The evidence base splits into empirical claims and value claims; the empirical ones are testable. ",
      "Choosing the two highest-leverage points and discarding the rest for word economy.",
    ];
    for (const ch of chunks) { await Bun.sleep(60); yield { kind: "thinking", text: ch } }
    if (this.who === "a" || this.who === "b") {
      await Bun.sleep(120);
      const side = this.who === "a" ? "PRO" : "CON";
      const text = [
        `## Round ${round} · ${side} position`,
        ``,
        `The **central question** is not whether trade-offs exist, but who bears them. Three points:`,
        ``,
        `1. The *empirical record* favors this side: measured outcomes moved in the predicted direction.`,
        `2. My opponent's strongest argument (${this.who === "a" ? "cost" : "benefit"} concentration) actually cuts the other way once second-order effects are priced in.`,
        `3. Under uncertainty, the asymmetry of downside risk decides it, see \`expected-value\` reasoning.`,
        ``,
        `> If the panel takes one thing from this round: the burden of proof has shifted.`,
      ].join("\n");
      return { text, thinking: chunks.join(""), usage: { inTok: 1800, outTok: 240, costUsd: this.who === "a" ? 0.031 : undefined }, durationMs: Date.now() - started };
    }
    await Bun.sleep(100);
    const conf = Math.min(0.95, 0.35 + round * (this.who === "ja" ? 0.28 : 0.18));
    const obj = isFinal
      ? {
          winner: this.who === "ja" ? "a" : "b", confidence: conf,
          bestArguments: { a: ["Downside-risk asymmetry framing", "Empirical trend citation"], b: ["Cost-concentration rebuttal", "Incentive-design counterexample"] },
          worstArguments: { a: ["Appeal to consensus in round 2"], b: ["Overclaimed second-order effects"] },
          decidingFactors: "The risk-asymmetry argument survived every rebuttal attempt; nothing new was being added by the final round.",
          steelman: { a: "Even granting measurement noise, the directional evidence plus asymmetric downside justifies action now.", b: "Concentrated, certain costs today outweigh diffuse, speculative benefits tomorrow." },
          anticipatedAttacks: { a: ["Attack the data quality", "Reframe as motte-and-bailey"], b: ["Demand a discount rate", "Force quantification of 'speculative'"] },
          commentary: "A disciplined final exchange. **What convinced me** was consistency under pressure rather than any single point.",
        }
      : {
          onTrack: round !== 2, steeringNote: round === 2 ? "Both debaters are drifting into definitional skirmish; return to the empirical crux." : "",
          scores: { a: { logic: 7 + (round % 2), evidence: 7, rebuttal: 6 + (round % 3), persuasion: 7 }, b: { logic: 7, evidence: 6 + (round % 2), rebuttal: 7, persuasion: 6 + (round % 2) } },
          roundWinner: round % 2 ? "a" : "b",
          cruxes: [
            { id: "risk-asymmetry", description: "Whether downside risks dominate expected value", status: round >= 2 ? "resolved-a" : "open" },
            { id: "cost-distribution", description: "Who bears concentrated transition costs", status: "open" },
          ],
          nextFocus: {
            a: "Quantify the downside-risk asymmetry instead of asserting it.",
            b: "Name who bears the concentrated costs and for how long.",
          },
          clarifications: ["Whether 'measured outcomes' refers to any specific study or is asserted"],
          verdictReached: this.who === "ja" ? round >= 2 : round >= 3,
          confidence: conf, leaning: this.who === "ja" ? "a" : round >= 2 ? "b" : "undecided",
          commentary: `Round ${round}: the *${round % 2 ? "PRO" : "CON"}* side carried the exchange on evidence quality. The open crux remains **cost-distribution**.`,
        };
    return { text: JSON.stringify(obj), thinking: chunks.join(""), structured: obj, usage: { inTok: 900, outTok: 180, costUsd: this.who === "ja" ? 0.012 : undefined }, durationMs: Date.now() - started };
  }
}

/* ================================================================== *
 * §8 JUDGE SCHEMAS & PARSING
 * ================================================================== */

/** OpenAI structured output requires strict schemas: additionalProperties:false on every object node. */
function strict<T>(schema: T): T {
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") node.additionalProperties = false;
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(schema);
  return schema;
}

const scoreCardSchema = {
  type: "object", required: [...AXES],
  properties: Object.fromEntries(AXES.map((k) => [k, { type: "integer", minimum: 0, maximum: 10 }])),
};

const ROUND_SCHEMA = strict({
  type: "object",
  required: ["onTrack", "steeringNote", "scores", "roundWinner", "cruxes", "nextFocus", "clarifications", "verdictReached", "confidence", "leaning", "commentary"],
  properties: {
    onTrack: { type: "boolean" },
    steeringNote: { type: "string" },
    scores: { type: "object", required: ["a", "b"], properties: { a: scoreCardSchema, b: scoreCardSchema } },
    roundWinner: { enum: ["a", "b", "tie"] },
    cruxes: {
      type: "array",
      items: {
        type: "object", required: ["id", "description", "status"],
        properties: { id: { type: "string" }, description: { type: "string" }, status: { enum: ["open", "resolved-a", "resolved-b", "deadlocked"] } },
      },
    },
    nextFocus: { type: "object", required: ["a", "b"], properties: { a: { type: "string" }, b: { type: "string" } } },
    clarifications: { type: "array", items: { type: "string" } },
    verdictReached: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    leaning: { enum: ["a", "b", "undecided"] },
    commentary: { type: "string" },
  },
});

const strArr = { type: "array", items: { type: "string" } };
const FINAL_SCHEMA = strict({
  type: "object",
  required: ["winner", "confidence", "bestArguments", "worstArguments", "decidingFactors", "steelman", "anticipatedAttacks", "commentary"],
  properties: {
    winner: { enum: ["a", "b", "draw"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    bestArguments: { type: "object", required: ["a", "b"], properties: { a: strArr, b: strArr } },
    worstArguments: { type: "object", required: ["a", "b"], properties: { a: strArr, b: strArr } },
    decidingFactors: { type: "string" },
    steelman: { type: "object", required: ["a", "b"], properties: { a: { type: "string" }, b: { type: "string" } } },
    anticipatedAttacks: { type: "object", required: ["a", "b"], properties: { a: strArr, b: strArr } },
    commentary: { type: "string" },
  },
});

function extractJson(text: string): unknown {
  const attempts: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.unshift(fenced[1]);
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) { attempts.push(text.slice(start, i + 1)); break; }
    }
  }
  for (const a of attempts) { try { return JSON.parse(a.trim()); } catch {} }
  return undefined;
}

const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
const clamp10 = (n: unknown) => Math.max(0, Math.min(10, Math.round(Number(n) || 0)));

function coerceRoundVerdict(v: any, judge: "ja" | "jb", round: number): RoundVerdict | null {
  if (!v || typeof v !== "object" || !v.scores?.a || !v.scores?.b) return null;
  if (typeof v.verdictReached !== "boolean" || typeof v.commentary !== "string") return null;
  const sc = (s: any) => Object.fromEntries(AXES.map((k) => [k, clamp10(s?.[k])]));
  return {
    judge, round,
    onTrack: v.onTrack !== false,
    steeringNote: typeof v.steeringNote === "string" ? v.steeringNote : "",
    scores: { a: sc(v.scores.a), b: sc(v.scores.b) },
    roundWinner: ["a", "b", "tie"].includes(v.roundWinner) ? v.roundWinner : "tie",
    cruxes: Array.isArray(v.cruxes)
      ? v.cruxes.filter((x: any) => x && typeof x.id === "string" && typeof x.description === "string")
          .map((x: any) => ({ id: x.id, description: x.description, status: String(x.status ?? "open") }))
      : [],
    nextFocus: {
      a: typeof v.nextFocus?.a === "string" && v.nextFocus.a.trim() ? v.nextFocus.a.trim() : "Advance your strongest remaining argument with new evidence.",
      b: typeof v.nextFocus?.b === "string" && v.nextFocus.b.trim() ? v.nextFocus.b.trim() : "Advance your strongest remaining argument with new evidence.",
    },
    clarifications: Array.isArray(v.clarifications) ? v.clarifications.filter((x: any) => typeof x === "string" && x.trim()) : [],
    verdictReached: v.verdictReached,
    // An undecided judge cannot be highly convinced of a winner; clamp so the
    // stop ramp and the conviction bar cannot read "undecided" as "settled".
    confidence: (["a", "b"].includes(v.leaning) ? clamp01(v.confidence) : Math.min(clamp01(v.confidence), 0.5)),
    leaning: ["a", "b", "undecided"].includes(v.leaning) ? v.leaning : "undecided",
    commentary: v.commentary,
  };
}

function coerceFinalVerdict(v: any, judge: "ja" | "jb"): FinalVerdict | null {
  if (!v || typeof v !== "object" || !["a", "b", "draw"].includes(v.winner)) return null;
  const arr = (x: any) => (Array.isArray(x) ? x.filter((s: any) => typeof s === "string") : []);
  return {
    judge, winner: v.winner, confidence: clamp01(v.confidence),
    bestArguments: { a: arr(v.bestArguments?.a), b: arr(v.bestArguments?.b) },
    worstArguments: { a: arr(v.worstArguments?.a), b: arr(v.worstArguments?.b) },
    decidingFactors: String(v.decidingFactors ?? ""),
    steelman: { a: String(v.steelman?.a ?? ""), b: String(v.steelman?.b ?? "") },
    anticipatedAttacks: { a: arr(v.anticipatedAttacks?.a), b: arr(v.anticipatedAttacks?.b) },
    commentary: String(v.commentary ?? ""),
  };
}

/* ================================================================== *
 * §9 RENDERING · headers, boxes, scoreboards
 * ================================================================== */

const ui = new LiveArea();

function rule(hex = P.comment, ch = "─") { ui.log(chalk.hex(hex)(ch.repeat(cols()))); }

function speakerHeader(p: Participant, roundLabel: string) {
  ui.log();
  const name = ` ${p.paint.bold(`◆ ${p.label}`)}${p.role ? p.paint(` · ${p.role}`) : ""} ${c.dim("· " + roundLabel)}`;
  ui.log(name);
  ui.log(p.paint("─".repeat(Math.min(cols(), 60))));
}

function fmtTok(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

function usageFooter(r: TurnResult, showWords = false) {
  const parts = [`${Math.round(r.durationMs / 1000)}s`, `in ${fmtTok(r.usage.inTok)} / out ${fmtTok(r.usage.outTok)} tok`];
  if (showWords) parts.push(`${r.text.split(/\s+/).filter(Boolean).length} words`);
  if (typeof r.usage.costUsd === "number") parts.push(`$${r.usage.costUsd.toFixed(3)}`);
  ui.log(c.dim(`   ↳ ${parts.join(" · ")}`));
}

function contentBox(p: Participant, title: string, body: string) {
  const width = cols();
  ui.log(boxen(renderMarkdown(body, width - 10), {
    borderStyle: "round", borderColor: p.hex, width,
    padding: { left: 2, right: 2, top: 0, bottom: 0 },
    title: ` ${title} `, titleAlignment: "left",
  }));
}

interface RenderOpts { p: Participant; roundLabel: string; showBody: boolean; verb: string }

async function renderTurnStream(gen: AsyncGenerator<AgentEvent, TurnResult>, o: RenderOpts): Promise<TurnResult> {
  speakerHeader(o.p, o.roundLabel);
  const think = new StreamingWrap(Math.min(cols(), 96) - 4, c.think, ui, c.dim("  ✦ "));
  const started = Date.now();
  let preview = "", tools = 0, lastEvent = Date.now();
  const status = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    const quiet = Date.now() - lastEvent > 90_000 ? ` · quiet ${Math.round((Date.now() - lastEvent) / 1000)}s` : "";
    const tail = preview ? ` · …${preview.slice(-46).replace(/\n/g, " ")}` : "";
    return `${o.p.label.toLowerCase()} ${o.verb} · ${secs}s${tools ? ` · ${tools} tool${tools > 1 ? "s" : ""}` : ""}${quiet}${tail}`;
  };
  ui.setStatus(status());
  const tick = setInterval(() => ui.setStatus(status()), 1000);
  try {
    while (true) {
      const r = await gen.next();
      if (r.done) {
        think.flush();
        ui.clearStatus();
        clearInterval(tick);
        const result = r.value;
        if (o.showBody) {
          contentBox(o.p, `${o.p.label}${o.p.role ? " · " + o.p.role : ""}`, result.text || "(empty statement)");
        }
        usageFooter(result, o.showBody);
        return result;
      }
      lastEvent = Date.now();
      const ev = r.value as AgentEvent;
      if (ev.kind === "thinking") think.push(ev.text);
      else if (ev.kind === "text-delta") { preview += ev.text; if (preview.length > 400) preview = preview.slice(-200); ui.setStatus(status()); }
      else if (ev.kind === "tool") { tools++; think.flush(); ui.log(c.dim(`  ⚙ ${ev.name}${ev.detail ? ": " + ev.detail : ""}`)); }
      else if (ev.kind === "notice") { think.flush(); ui.log(c.dim(`  ◦ ${ev.text}`)); }
    }
  } catch (e) {
    think.flush();
    ui.clearStatus();
    clearInterval(tick);
    throw e;
  }
}

function confBar(conf: number): string {
  const cells = 10;
  const full = Math.round(conf * cells);
  return c.pink("▰".repeat(full)) + c.dim("▱".repeat(cells - full)) + c.dim(` ${(conf * 100).toFixed(0)}%`);
}

function judgeName(j: "ja" | "jb") { return j === "ja" ? "JUDGE 1" : "JUDGE 2"; }
function judgePaint(j: "ja" | "jb") { return j === "ja" ? c.ja : c.jb; }
function judgeHex(j: "ja" | "jb") { return j === "ja" ? P.yellow : P.orange; }

function renderRoundVerdicts(state: DebateState, verdicts: RoundVerdict[], round: number, setup: DebateSetup) {
  ui.log();
  ui.log(" " + c.pink.bold(`⚖ THE PANEL · ROUND ${round}`));
  for (const v of verdicts) {
    const badge = v.verdictReached ? c.pink.bold("BEYOND PERSUASION") : c.dim("still persuadable");
    const lean = v.leaning === "undecided" ? c.dim("undecided") : (v.leaning === "a" ? c.a : c.b)(v.leaning === "a" ? setup.roleA : setup.roleB);
    const degradedNote = v.degraded ? c.err("  · verdict unparseable, neutral scores") : "";
    const meta = `leaning ${lean}  ·  conviction ${confBar(v.confidence)}  ·  ${badge}${degradedNote}`;
    const w = cols() - 12;
    const focus = !v.degraded && !v.verdictReached
      ? "\n" + [
          `${c.a("→ " + setup.roleA)} ${c.dim(wrapAnsi(v.nextFocus.a, w - 8).split("\n").join("\n  "))}`,
          `${c.b("→ " + setup.roleB)} ${c.dim(wrapAnsi(v.nextFocus.b, w - 8).split("\n").join("\n  "))}`,
        ].join("\n")
      : "";
    const body = (v.commentary ? renderMarkdown(v.commentary, cols() - 10) + "\n\n" + meta : meta) + focus;
    ui.log(boxen(body, {
      borderStyle: "round", borderColor: judgeHex(v.judge), width: cols(),
      padding: { left: 2, right: 2, top: 0, bottom: 0 }, title: ` ${judgeName(v.judge)} `, titleAlignment: "left",
    }));
    if (!v.onTrack && v.steeringNote) ui.log(" " + c.warn(`⚑ steering: ${v.steeringNote}`));
  }
  renderScoreboard(state, round, setup);
}

function renderScoreboard(state: DebateState, round: number, setup: DebateSetup) {
  const roundVs = state.verdicts.filter((v) => v.round === round);
  if (!roundVs.length) return;
  const sum = (s: Record<string, number>) => AXES.reduce((t, k) => t + (s[k] ?? 0), 0);
  const cum = (judge: string, side: "a" | "b") =>
    state.verdicts.filter((v) => v.judge === judge).reduce((t, v) => t + sum(v.scores[side]), 0);
  const table = new Table({
    head: ["", setup.roleA, setup.roleB, "round", "cumulative"].map((h) => c.dim(h)),
    style: { head: [], border: [] },
    chars: { top: "─", "top-mid": "┬", "top-left": "╭", "top-right": "╮", bottom: "─", "bottom-mid": "┴", "bottom-left": "╰", "bottom-right": "╯", left: "│", "left-mid": "├", mid: "─", "mid-mid": "┼", right: "│", "right-mid": "┤", middle: "│" },
  });
  for (const v of roundVs) {
    const jp = judgePaint(v.judge);
    const fmt = (s: Record<string, number>) => AXES.map((k) => s[k]).join("·") + " = " + sum(s);
    const winner = v.roundWinner === "tie" ? c.dim("tie") : v.roundWinner === "a" ? c.a(setup.roleA) : c.b(setup.roleB);
    table.push([jp(judgeName(v.judge)), c.a(fmt(v.scores.a)), c.b(fmt(v.scores.b)), winner,
      c.a(String(cum(v.judge, "a"))) + c.dim(" / ") + c.b(String(cum(v.judge, "b")))]);
  }
  ui.log(table.toString().split("\n").map((l: string) => " " + l).join("\n"));
  ui.log(c.dim(`  axes: ${AXES.join(" · ")} (0-10)`));

  const cruxLines: string[] = [];
  for (const [judge, map] of state.cruxes) {
    // cap per judge, not overall, so one prolific judge cannot crowd the other out
    for (const cx of [...map.values()].slice(-6)) {
      const glyph = cx.status === "open" ? c.dim("○") : cx.status === "resolved-a" ? c.a("✔") : cx.status === "resolved-b" ? c.b("✔") : c.err("⚔");
      const desc = cx.description.length > 70 ? cx.description.slice(0, 69).replace(/\s+\S*$/, "") + "…" : cx.description;
      cruxLines.push(`  ${glyph} ${c.fg(cx.id)} ${c.dim(`(${judgePaint(judge as "ja" | "jb")(judge === "ja" ? "judge 1" : "judge 2")}${c.dim(", " + cx.status + ")")}`)} ${c.dim("· " + desc)}`);
    }
  }
  if (cruxLines.length) {
    ui.log(" " + c.pink("CRUXES") + c.dim(" · the load-bearing disagreements"));
    for (const l of cruxLines) ui.log(l);
  }
}

/* ================================================================== *
 * §10 PROMPT BUILDERS
 * ================================================================== */

const EXCERPT_PER_FILE = 40_000;
const EXCERPT_TOTAL = 80_000;

/** Extract text from pdf/text attachments once at intake so every participant sees identical
 *  evidence without spending turn time on extraction. Paths stay available for deeper reading. */
async function extractAttachmentText(atts: Attachment[]): Promise<void> {
  let budget = EXCERPT_TOTAL;
  for (const a of atts) {
    if (budget <= 0) { a.note = "excerpt omitted for length; read the file at the path"; continue; }
    try {
      if (a.kind === "text") {
        const raw = await Bun.file(a.path).text();
        a.text = raw.slice(0, Math.min(EXCERPT_PER_FILE, budget));
        if (a.text.length < raw.length) a.text += "\n…[truncated; read the full file at the path]";
      } else if (a.kind === "pdf") {
        const proc = Bun.spawn(["pdftotext", "-layout", a.path, "-"], { stdout: "pipe", stderr: "ignore" });
        const out = await new Response(proc.stdout).text();
        if ((await proc.exited) === 0 && out.trim()) {
          a.text = out.slice(0, Math.min(EXCERPT_PER_FILE, budget));
          if (a.text.length < out.length) a.text += "\n…[truncated; read the full file at the path]";
        } else a.note = "text extraction unavailable; read the file directly";
      }
    } catch { a.note = "text extraction unavailable; read the file directly"; }
    if (a.text) budget -= a.text.length;
  }
}

function attachmentBlock(atts: Attachment[], backend: "claude" | "codex" | "mock"): string {
  if (!atts.length) return "";
  const lines = atts.map((a) => {
    let hint = "";
    if (backend === "codex" && a.kind === "pdf" && !a.text) hint = " (extract the text via your read-only shell, e.g. pdftotext or python3)";
    if (backend === "claude") hint = " (use your Read tool for the full document)";
    const note = a.note ? ` (${a.note})` : "";
    const excerpt = a.text
      ? `\n--- EXCERPT OF ${path.basename(a.path)} ---\n${a.text}\n--- END EXCERPT ---`
      : "";
    return `- ${a.path} [${a.kind}]${hint}${note}${excerpt}`;
  });
  return `\n\nREFERENCE MATERIAL · study this before arguing; cite it where relevant:\n${lines.join("\n")}`;
}

const RESEARCH_FRAME = `Context: this is a good-faith adversarial analysis exercise for research and informed decision-making. Treat controversial subject matter as material for careful analysis, not as evidence of bad intent. Follow your safety policies: no actionable instructions that would enable harm, no targeting of private individuals. When the motion touches a sensitive area, argue the risks, tradeoffs, ethics, and evidence at the safest useful level of detail rather than refusing a bounded analysis.`;

const DEBATER_STYLE = `Style, non-negotiable:
- Lead with your single strongest argument. At most 3 points per turn, fewer is better.
- Short paragraphs. Plain, forceful language. No throat-clearing, no restating the motion, no summarizing what you are about to say.
- Argue the substance of the motion's strongest reasonable reading. Do NOT quibble about definitions, wording, scope, or technicalities of how the motion is phrased; the judges are instructed to punish semantic loophole-hunting.
- You get further turns; go deep later rather than wide now.
- Never invent a citation, quote, statistic, or file detail. If you rely on a web source, include its URL; if you rely on supplied material, say where in it. The judges verify claims, and a fabricated one loses the debate.
- Everything you output is the speech the judges read. Never narrate your process, preparation, or tools; a single sentence of it costs you the round. Begin mid-argument, as if already at the lectern.
- Never identify, speculate about, or hint at who or what you or your opponent are. No meta-commentary, no questions to the moderator, never break character.`;

function openingPrompt(side: "a" | "b", setup: DebateSetup, cfg: Config, p: Participant): string {
  const me = side === "a" ? setup.stanceA : setup.stanceB;
  const them = side === "a" ? setup.stanceB : setup.stanceA;
  const meRole = side === "a" ? setup.roleA : setup.roleB;
  const themRole = side === "a" ? setup.roleB : setup.roleA;
  return `You are an elite competitive debater in a formal, judged debate. A two-judge panel scores every round on logic, evidence, rebuttal, and persuasion, and a student of the topic is watching to understand its nuances. You are known only as "${meRole}"; your opponent only as "${themRole}".

${RESEARCH_FRAME}

MOTION: ${setup.topic}

YOUR SIDE (${meRole}): ${me}
OPPONENT'S SIDE (${themRole}): ${them}

ROUND 1 of up to ${cfg.rounds}: deliver your OPENING STATEMENT.

- Make the strongest intellectually honest case for your side. No strawmen; engage the opposing view at its best.
- Ground claims in evidence${cfg.allowWeb ? " (you may search the web; include source URLs for factual claims you rely on)" : " (web access is disabled; reason from first principles and any reference material)"}.
- Maximum ${cfg.fast ? 180 : 250} words. A tight 150 beats a flabby 250.

${DEBATER_STYLE}${attachmentBlock(setup.attachments, p.agent.backend)}`;
}

function rebuttalPrompt(side: "a" | "b", round: number, state: DebateState, cfg: Config, _p: Participant,
                        kind: "rebuttal" | "steelman", userNote?: string): string {
  const oppKey = side === "a" ? "b" : "a";
  const oppTurn = [...state.turns].reverse().find((t) => t.speaker === oppKey);
  const judgeNotes = state.verdicts.filter((v) => v.round === round - 1 && v.steeringNote && !v.onTrack)
    .map((v) => `- (Judge ${v.judge === "ja" ? "1" : "2"}) ${v.steeringNote}`).join("\n");
  const focusNotes = state.verdicts.filter((v) => v.round === round - 1 && !v.degraded && v.nextFocus?.[side])
    .map((v) => `- (Judge ${v.judge === "ja" ? "1" : "2"}) ${v.nextFocus[side]}`).join("\n");
  const isLast = round >= cfg.rounds;
  const parts: string[] = [];
  parts.push(`ROUND ${round} of up to ${cfg.rounds}${isLast ? " · FINAL ROUND, close your case" : ""}.`);
  if (kind === "steelman") {
    parts.push(`SPECIAL STEELMAN ROUND, ordered by the moderator: argue your OPPONENT'S side as persuasively and accurately as you can. The judges are scoring how charitably and precisely you can inhabit the opposing position. After this round you will return to your own side.`);
  }
  parts.push(`Your opponent just argued:\n---\n${oppTurn?.text ?? "(the opponent forfeited the previous turn)"}\n---`);
  if (focusNotes) parts.push(`The judges direct YOU specifically to address this round (answer these, do not just re-persuade):\n${focusNotes}`);
  if (judgeNotes) parts.push(`The judges direct both debaters:\n${judgeNotes}`);
  if (userNote) parts.push(`The audience interjects, address this directly this round:\n"${userNote}"`);
  parts.push(kind === "steelman"
    ? `Deliver the steelman now. Maximum ${cfg.fast ? 150 : 200} words.`
    : `Deliver your rebuttal: take their strongest point head-on first, then advance your own case. Concede what deserves concession; the judges reward intellectual honesty. Maximum ${cfg.fast ? 150 : 220} words.`);
  parts.push(DEBATER_STYLE);
  return parts.join("\n\n");
}

function judgeBrief(_judge: "ja" | "jb", setup: DebateSetup, cfg: Config, backend: "claude" | "codex" | "mock"): string {
  return `You are one of two independent judges on the panel of a formal debate. The other judge deliberates separately; you never see their scores. You are rigorous, adversarial to sloppy reasoning, and immune to rhetoric that lacks substance.

${RESEARCH_FRAME}

MOTION: ${setup.topic}

Debater "a" argues ${setup.roleA}: ${setup.stanceA}
Debater "b" argues ${setup.roleB}: ${setup.stanceB}

The debaters are anonymous. You know nothing about them except the words of their statements, and you must not speculate about who or what they are. Judge only what is on the page.

Each round you will receive both statements verbatim. Your duties, every round:
1. onTrack / steeringNote: police drift, definitional games, and repetition. If off track, say exactly how to correct course.
2. scores: score EACH debater 0-10 on ${AXES.join(", ")}. 5 is competent; reserve 9-10 for exceptional work.
   Reward concision, clarity, and direct clash: the strongest argument stated plainly. Punish padding, throat-clearing, and above all DEFINITIONAL LAWYERING: a turn built on wording technicalities, semantic loopholes, or scope-quibbles about how the motion is phrased caps logic and persuasion at 4, no matter how clever.
   Word caps are ${cfg.fast ? 180 : 250} for openings and ${cfg.fast ? 150 : 220} for later turns; each statement arrives with its exact word count. Dock persuasion at least 2 points for a turn that materially exceeds its cap (more than ~15% over), and treat any narration of process, preparation, or tooling inside a statement as padding of the worst kind.
3. cruxes: maintain the list of load-bearing disagreements. Use short kebab-case ids and REUSE the same id across rounds; set status open, resolved-a, resolved-b, or deadlocked.
4. nextFocus: give EACH debater one precise, answerable instruction for the next round: the exact question your ruling most needs answered by that side. Never a generic "be more persuasive"; convert your unresolved doubts into specific tasks.
5. clarifications: the specific ambiguities, unsupported leaps, or unverified claims you probed this round (empty only if you checked the material claims and found none).
6. verdictReached: true ONLY when you are so convinced that no further argument from either side could plausibly change your leaning. Do not set it lightly, and do not withhold it once your mind has genuinely stopped moving.
7. confidence: 0 to 1, the probability that your CURRENT LEANING would survive the strongest remaining counterargument. It is conviction in a winner, not confidence in your analysis. If leaning is "undecided", confidence must be 0.5 or lower.
8. commentary: 60-150 words of sharp prose (markdown allowed) explaining the round: who moved you, which arguments landed or failed, and why. Refer to the debaters only as ${setup.roleA} and ${setup.roleB}.

ALWAYS respond with ONLY a JSON object matching the required schema. No prose outside the JSON.${attachmentBlock(setup.attachments, backend)}

Acknowledge this brief by replying with the single JSON: {"ack": true}`;
}

function judgeRoundPrompt(round: number, state: DebateState, cfg: Config, aText: string, bText: string,
                          kind: string, userNote: string | undefined, deadlockHint: boolean): string {
  const isLast = round >= cfg.rounds;
  const parts = [`ROUND ${round} of up to ${cfg.rounds}.${isLast ? " This was the FINAL round." : round === cfg.rounds - 1 ? " The next round is the last." : ""}`];
  if (kind === "steelman") parts.push("This was a STEELMAN round: each debater argued the OPPOSING side. Score persuasion as the charity and accuracy of the steelman.");
  if (userNote) parts.push(`The audience interjected this round: "${userNote}"`);
  if (deadlockHint) parts.push("The debate appears deadlocked (repeated ties, cruxes unmoved). Unless this round materially moved a crux, strongly consider verdictReached=true.");
  if (round >= 4) parts.push("Novelty check: if this round added no genuinely new argument or evidence, your conviction should be converging.");
  const cap = round === 1 ? (cfg.fast ? 180 : 250) : (cfg.fast ? 150 : 220);
  const wc = (t: string) => t.split(/\s+/).filter(Boolean).length;
  parts.push(`DEBATER "a" (${state.setup.roleA}) · ${wc(aText)} words against a ${cap}-word cap:\n---\n${aText}\n---`);
  parts.push(`DEBATER "b" (${state.setup.roleB}) · ${wc(bText)} words against a ${cap}-word cap:\n---\n${bText}\n---`);
  parts.push("Return ONLY the round-verdict JSON.");
  return parts.join("\n\n");
}

function judgeFinalPrompt(state: DebateState, _cfg: Config): string {
  const reason = state.endReason === "cap" ? "the round cap was reached"
    : state.endReason === "user" ? "the human moderator called for verdicts"
    : "the panel is beyond persuasion";
  return `The debate has ended (${reason}). Deliver your FINAL VERDICT as JSON:
- winner ("a"=${state.setup.roleA}, "b"=${state.setup.roleB}, or "draw") and confidence (0-1)
- bestArguments / worstArguments: the strongest and weakest arguments EACH side made (quote or closely paraphrase)
- decidingFactors: what ultimately convinced you, the reasoning that settled it
- steelman: the single strongest formulation of each side's whole case, in your own words
- anticipatedAttacks: if a human were to defend each side in a live debate, the attacks they should prepare for
- commentary: your closing statement as a judge (markdown allowed); refer to the debaters only as ${state.setup.roleA} and ${state.setup.roleB}

Return ONLY the final-verdict JSON.`;
}

/* ================================================================== *
 * §11 ATTACHMENTS & INTAKE
 * ================================================================== */

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"]);
const TEXT_EXT = new Set([".md", ".txt", ".csv", ".json", ".ts", ".tsx", ".js", ".py", ".html", ".xml", ".yaml", ".yml", ".toml", ".log"]);

function classify(p: string): Attachment["kind"] {
  const ext = path.extname(p).toLowerCase();
  if (IMG_EXT.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (TEXT_EXT.has(ext)) return "text";
  return "other";
}

function detectAttachments(topic: string): { attachments: Attachment[]; missing: string[] } {
  const tokens: string[] = [];
  const re = /"([^"]+)"|'([^']+)'|((?:\\.|\S)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(topic))) tokens.push((m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, "$1"));
  const attachments: Attachment[] = [];
  const missing: string[] = [];
  for (const t of tokens) {
    if (/^https?:\/\//.test(t)) continue;
    if (!(t.includes("/") || t.startsWith("~"))) continue;
    const expanded = path.resolve(t.replace(/^~(?=$|\/)/, os.homedir()));
    try {
      const st = fs.statSync(expanded);
      if (st.isFile()) attachments.push({ path: expanded, kind: classify(expanded) });
      else if (st.isDirectory()) attachments.push({ path: expanded, kind: "other" });
    } catch {
      // Looked like a path (absolute/home/relative prefix, or has a file extension) but does not exist:
      // surface it loudly instead of silently debating without the evidence.
      if (/^(\/|~\/|\.\/)/.test(t) || /\.\w{1,5}$/.test(t)) missing.push(expanded);
    }
  }
  return { attachments, missing };
}

async function clipboardImage(): Promise<Attachment | null> {
  if (process.platform !== "darwin") return null;
  try {
    const probe = Bun.spawnSync(["osascript", "-e", "clipboard info"]);
    if (!new TextDecoder().decode(probe.stdout).includes("PNGf")) return null;
    const dest = path.join(TMP, `clipboard-${Date.now()}.png`);
    const dump = Bun.spawnSync(["osascript",
      "-e", `set f to open for access POSIX file "${dest}" with write permission`,
      "-e", "write (the clipboard as «class PNGf») to f",
      "-e", "close access f"]);
    if (dump.exitCode !== 0 || !fs.existsSync(dest)) return null;
    return { path: dest, kind: "image" };
  } catch { return null; }
}

/** Quick pre-pass: rewrite a raw topic into a crisp, debatable motion (haiku, structured output). */
async function refineMotion(raw: string, bins: Record<string, string>, cfg: Config): Promise<string> {
  if (cfg.mock || !cfg.sharpen) return raw;
  const schema = strict({ type: "object", required: ["motion"], properties: { motion: { type: "string" } } });
  const prompt = `You prepare debate motions. Rewrite the raw topic below into a single, crisp, debatable motion: one declarative sentence someone can argue for or against.
- Preserve the author's intent and subject exactly; do not narrow, broaden, or editorialize.
- Remove ambiguity and vague wording that would invite arguments about definitions instead of substance.
- Do not include file paths (reference material is provided to the debaters separately).
- If the topic is already a crisp motion, return it unchanged.

RAW TOPIC:
"""
${raw}
"""`;
  ui.setStatus("sharpening the motion…");
  try {
    const proc = new JsonlProcess([bins.claude, "--print", "--output-format", "stream-json", "--verbose",
      "--setting-sources", "", "--disallowedTools", "Bash,Write,Edit,NotebookEdit,Task,Read,Glob,Grep,WebSearch,WebFetch",
      "--model", "haiku", "--effort", "low", "--json-schema", JSON.stringify(schema), prompt],
      { cwd: WORKDIR, timeoutMs: 60_000, env: claudeEnv() });
    let motion: string | undefined;
    for await (const line of proc.lines()) {
      const j = line as Record<string, any>;
      if (j.type === "result" && !j.is_error && typeof j.structured_output?.motion === "string") motion = j.structured_output.motion;
    }
    await proc.exited;
    ui.clearStatus();
    if (motion && motion.trim().length > 8) return motion.trim();
  } catch {}
  ui.clearStatus();
  return raw;
}

async function intake(cfg: Config, bins: Record<string, string>, presetTopic?: string): Promise<DebateSetup | "config" | null> {
  let topic = presetTopic;
  if (!topic) {
    const answer = await clack.text({
      message: c.user("What shall they debate?"),
      placeholder: "a motion, a question, file paths as evidence · /config tunes models",
      validate: (v: string | undefined) => (v && v.trim().length > 2 ? undefined : "give the debaters something to fight about"),
    });
    if (clack.isCancel(answer)) return null;
    topic = String(answer).trim();
  }
  if (["exit", "quit", "q"].includes(topic.toLowerCase())) return null;
  if (["/config", "/settings", "config"].includes(topic.toLowerCase())) return "config";
  if (topic.length > 10_000 && cfg.tty && !cfg.auto) {
    const go = await clack.confirm({ message: c.warn(`That topic is ${fmtTok(topic.length)} characters. Continue?`) });
    if (clack.isCancel(go) || !go) return null;
  }

  const { attachments, missing } = detectAttachments(topic);
  for (const p of missing) ui.log(c.err(`  ⚠ evidence not found, NOT attached: ${p}`));
  if (missing.length && cfg.tty && !cfg.auto) {
    const go = await clack.confirm({ message: c.warn(`${missing.length} file path${missing.length > 1 ? "s" : ""} in your topic could not be found. Debate without ${missing.length > 1 ? "them" : "it"}?`) });
    if (clack.isCancel(go) || !go) return null;
  }
  if (!cfg.auto && cfg.tty) {
    const clip = await clipboardImage().then(async (a) => {
      if (!a) return null;
      const yes = await clack.confirm({ message: c.user("There is an image on your clipboard. Attach it as evidence?") });
      return !clack.isCancel(yes) && yes ? a : null;
    });
    if (clip) attachments.push(clip);
  }
  if (attachments.length) {
    if (!cfg.mock) {
      ui.setStatus("reading the evidence…");
      await extractAttachmentText(attachments);
      ui.clearStatus();
    }
    ui.log(c.dim("  evidence locker:"));
    for (const a of attachments) {
      const extracted = a.text ? c.dim(` · ${fmtTok(a.text.length)} chars extracted`) : a.note ? c.warn(` · ${a.note}`) : "";
      ui.log(c.dim(`   📎 ${a.path} `) + c.pink(`[${a.kind}]`) + extracted);
    }
  }

  const rawTopic = topic;
  const motion = await refineMotion(topic, bins, cfg);
  const sharpened = motion !== rawTopic ? rawTopic : undefined;

  if (cfg.sideMode === "dialectic") {
    return {
      topic: motion, rawTopic: sharpened, attachments, mode: "dialectic",
      roleA: "THESIS", roleB: "ANTITHESIS",
      stanceA: "Stake out the strongest, most evidence-backed position on the motion (the thesis) and defend it with a clear, falsifiable claim.",
      stanceB: "Stake out the strongest defensible counter-position or dissenting reading of the motion (the antithesis) and defend it; do not simply negate, offer a rival framing.",
    };
  }
  const aSide: "pro" | "con" = Math.random() < 0.5 ? "pro" : "con";
  const pro = "Argue FOR the motion as stated.";
  const con = "Argue AGAINST the motion as stated.";
  return {
    topic: motion, rawTopic: sharpened, attachments, mode: "assigned",
    roleA: aSide === "pro" ? "PRO" : "CON",
    roleB: aSide === "pro" ? "CON" : "PRO",
    stanceA: aSide === "pro" ? pro : con,
    stanceB: aSide === "pro" ? con : pro,
  };
}

/* ================================================================== *
 * §12 TURN EXECUTION with retry / forfeit
 * ================================================================== */

async function performTurn(p: Participant, o: TurnOptions, r: RenderOpts, cfg: Config,
                           firstGen?: AsyncGenerator<AgentEvent, TurnResult>): Promise<TurnResult | null> {
  let attempt = 0;
  let gen = firstGen ?? p.agent.runTurn(o);
  while (true) {
    attempt++;
    ACTIVE_ABORT ??= new AbortController();
    try {
      const res = await renderTurnStream(gen, r);
      return res;
    } catch (e) {
      const err = e as TurnFailure;
      ui.clearStatus();
      if (err.message === "turn aborted") { ui.log(c.warn("  turn aborted by you")); return null; }
      ui.log(c.err(`  ✗ ${p.label} turn failed: ${err.message}`));
      for (const l of (err.stderrTail ?? []).slice(-3)) ui.log(c.dim(`    ${l.slice(0, cols() - 6)}`));
      if (attempt === 1) {
        ui.log(c.dim("  retrying once…"));
        gen = p.agent.runTurn(o);
        continue;
      }
      if (cfg.auto || !cfg.tty) { ui.log(c.warn(`  ${p.label} forfeits this turn.`)); return null; }
      const choice = await clack.select({
        message: c.err(`${p.label} failed twice. What now?`),
        options: [
          { value: "retry", label: "Retry again" },
          { value: "forfeit", label: "Skip this turn (technical forfeit)" },
          { value: "abandon", label: "Abandon the debate" },
        ],
      });
      if (clack.isCancel(choice) || choice === "abandon") throw new AbandonDebate();
      if (choice === "forfeit") return null;
      gen = p.agent.runTurn(o);
      attempt = 1;
    } finally {
      ACTIVE_ABORT = null;
      SIGINT_HIT = 0;
    }
  }
}

async function judgeTurn(p: Participant, prompt: string, schema: object, r: RenderOpts, cfg: Config,
                         firstGen?: AsyncGenerator<AgentEvent, TurnResult>): Promise<{ res: TurnResult | null; parsed: unknown }> {
  const res = await performTurn(p, { prompt, schema }, r, cfg, firstGen);
  if (!res) return { res: null, parsed: undefined };
  let parsed = res.structured ?? extractJson(res.text);
  if (!parsed) {
    ui.log(c.dim(`  ${p.label} returned malformed JSON; asking once to correct…`));
    const fix = await performTurn(p, { prompt: "Your last reply did not match the required JSON schema. Reply again with ONLY the JSON object, nothing else.", schema }, { ...r, verb: "correcting" }, cfg);
    if (fix) parsed = fix.structured ?? extractJson(fix.text);
    if (fix) addUsage(res.usage, fix.usage);
  }
  return { res, parsed };
}

function addUsage(into: Usage, from: Usage) {
  into.inTok += from.inTok; into.outTok += from.outTok;
  if (from.costUsd) into.costUsd = (into.costUsd ?? 0) + from.costUsd;
}

/* ================================================================== *
 * §13 THE DEBATE ENGINE
 * ================================================================== */

function makeBackend(kind: "claude" | "codex", bins: Record<string, string>, bcfg: BackendCfg, tag: string, mockWho?: "a" | "b" | "ja" | "jb"): AgentBackend {
  if (mockWho) return new MockAgent(mockWho);
  return kind === "claude" ? new ClaudeAgent(bins.claude, bcfg, tag) : new CodexAgent(bins.codex, bcfg, tag);
}

function tally(state: DebateState, r: TurnResult | null) {
  if (!r) return;
  state.totals.inTok += r.usage.inTok;
  state.totals.outTok += r.usage.outTok;
  if (r.usage.costUsd) state.totals.costUsd += r.usage.costUsd;
}

function recordTurn(state: DebateState, speaker: "a" | "b", round: number, kind: Turn["kind"], r: TurnResult | null) {
  state.turns.push({
    speaker, round, kind: r ? kind : "forfeit",
    text: r?.text ?? "(forfeited: technical failure)",
    thinking: r?.thinking ?? "", usage: r?.usage ?? { inTok: 0, outTok: 0 }, durationMs: r?.durationMs ?? 0,
  });
  tally(state, r);
}

async function runDebate(setup: DebateSetup, cfg: Config, bins: Record<string, string>): Promise<void> {
  const debTimeout = cfg.mock ? 30_000 : 600_000;
  const judTimeout = cfg.mock ? 30_000 : 420_000;
  const A: Participant = {
    key: "a", label: setup.roleA, role: "", hex: P.purple, paint: c.a,
    agent: makeBackend("claude", bins, { model: cfg.modelA, effort: cfg.effortA, allowWeb: cfg.allowWeb, timeoutMs: debTimeout, debugEvents: cfg.debugEvents }, "debater-a", cfg.mock ? "a" : undefined),
  };
  const B: Participant = {
    key: "b", label: setup.roleB, role: "", hex: P.green, paint: c.b,
    agent: makeBackend("codex", bins, { model: cfg.modelB, effort: cfg.effortB, allowWeb: cfg.allowWeb, timeoutMs: debTimeout, debugEvents: cfg.debugEvents }, "debater-b", cfg.mock ? "b" : undefined),
  };
  const judges: Participant[] = [];
  if (cfg.judgeMode !== "codex") judges.push({
    key: "ja", label: "JUDGE 1", role: "", hex: P.yellow, paint: c.ja,
    agent: makeBackend("claude", bins, { model: cfg.judgeModelA, effort: cfg.judgeEffortA, allowWeb: false, timeoutMs: judTimeout, debugEvents: cfg.debugEvents }, "judge-claude", cfg.mock ? "ja" : undefined),
  });
  if (cfg.judgeMode !== "claude") judges.push({
    key: "jb", label: "JUDGE 2", role: "", hex: P.orange, paint: c.jb,
    agent: makeBackend("codex", bins, { model: cfg.judgeModelB, effort: cfg.judgeEffortB, allowWeb: false, timeoutMs: judTimeout, debugEvents: cfg.debugEvents }, "judge-codex", cfg.mock ? "jb" : undefined),
  });

  const state: DebateState = {
    setup, startedAt: Date.now(), round: 1, turns: [], verdicts: [], finals: [],
    cruxes: new Map(), notes: [], totals: { costUsd: 0, inTok: 0, outTok: 0 },
  };

  // ---- the card ----
  ui.log();
  ui.log(boxen(c.fg.bold(wrapAnsi(setup.topic, cols() - 12)), {
    borderStyle: "double", borderColor: P.pink, width: cols(),
    padding: { left: 2, right: 2, top: 0, bottom: 0 }, title: " THE MOTION ", titleAlignment: "center",
  }));
  if (setup.rawTopic) ui.log(c.dim(`  ✦ sharpened from: ${setup.rawTopic.replace(/\s+/g, " ").slice(0, cols() - 22)}`));
  ui.log(`  ${c.a.bold("◆ " + setup.roleA)} ${c.dim(`engine A (${cfg.modelA || "cli default"} · ${cfg.effortA}${cfg.fast ? ", fast" : ""}) · hidden from all participants`)}`);
  ui.log(`  ${c.b.bold("◆ " + setup.roleB)} ${c.dim(`engine B (${cfg.modelB || "cli default"} · ${cfg.effortB}) · hidden from all participants`)}`);
  ui.log(`  ${c.pink("⚖")} ${c.dim(`${judges.length === 2 ? "two independent blind judges" : "one blind judge"} · web ${cfg.allowWeb ? "ON" : "OFF"} · cap ${cfg.rounds} rounds · ${judges.length === 2 ? "both" : "the judge"} must be beyond persuasion to end it`)}`);

  // ---- judge briefs (parallel, quiet) ----
  ui.setStatus("briefing the judges…");
  await Promise.all(judges.map(async (j) => {
    try {
      const gen = j.agent.runTurn({ prompt: judgeBrief(j.key as "ja" | "jb", setup, cfg, j.agent.backend), schema: strict({ type: "object", required: ["ack"], properties: { ack: { type: "boolean" } } }) });
      while (!(await gen.next()).done) { /* drain quietly */ }
    } catch { /* brief failures surface on round 1 */ }
  }));
  ui.clearStatus();

  let budgetWarnAt = 1.5;
  let userNote: string | undefined;
  let kind: "rebuttal" | "steelman" = "rebuttal";
  const imagePaths = setup.attachments.filter((a) => a.kind === "image").map((a) => a.path);

  try {
    // ---- round 1: parallel openings ----
    const aOpts: TurnOptions = { prompt: openingPrompt("a", setup, cfg, A) };
    const bOpts: TurnOptions = { prompt: openingPrompt("b", setup, cfg, B), images: imagePaths };
    const bGen = cfg.mock ? undefined : pump(B.agent.runTurn(bOpts));
    const aRes = await performTurn(A, aOpts, { p: A, roundLabel: "ROUND 1 · OPENING", showBody: true, verb: "composing opening" }, cfg);
    recordTurn(state, "a", 1, "opening", aRes);
    const bRes = await performTurn(B, bOpts, { p: B, roundLabel: "ROUND 1 · OPENING", showBody: true, verb: "composing opening" }, cfg, bGen);
    recordTurn(state, "b", 1, "opening", bRes);

    let round = 1;
    while (true) {
      // ---- judge the round ----
      const aText = [...state.turns].reverse().find((t) => t.speaker === "a")!.text;
      const bText = [...state.turns].reverse().find((t) => t.speaker === "b")!.text;
      const deadlock = detectDeadlock(state, round);
      const jPrompt = judgeRoundPrompt(round, state, cfg, aText, bText, kind, userNote, deadlock);
      const roundVerdicts: RoundVerdict[] = [];

      const jGens = judges.map((j, i) => (i > 0 && !cfg.mock) ? pump(j.agent.runTurn({ prompt: jPrompt, schema: ROUND_SCHEMA })) : undefined);
      for (let i = 0; i < judges.length; i++) {
        const j = judges[i];
        const { res, parsed } = await judgeTurn(j, jPrompt, ROUND_SCHEMA,
          { p: j, roundLabel: `ROUND ${round} · DELIBERATION`, showBody: false, verb: "deliberating" }, cfg, jGens[i]);
        tally(state, res);
        const v = coerceRoundVerdict(parsed, j.key as "ja" | "jb", round)
          ?? degradedRoundVerdict(j.key as "ja" | "jb", round, res?.text);
        roundVerdicts.push(v);
        state.verdicts.push(v);
        const jm = state.cruxes.get(j.key) ?? new Map<string, Crux>();
        for (const cx of v.cruxes) jm.set(cx.id, cx);
        state.cruxes.set(j.key, jm);
      }
      renderRoundVerdicts(state, roundVerdicts, round, setup);

      // ---- stop? ----
      // A judge is settled only if it says no argument could move it, or its
      // conviction in an ACTUAL LEANING has crossed the ramp. "Undecided at
      // high confidence" means confidently contested, which must not end a debate.
      const ramp = RAMP[Math.min(round, RAMP.length - 1)];
      const allSettled = roundVerdicts.every((v) =>
        !v.degraded && (v.verdictReached || (v.confidence >= ramp && v.leaning !== "undecided")));
      if (round >= 2 && allSettled) {
        state.endReason = "panel";
        if (!roundVerdicts.every((v) => v.verdictReached)) state.endDetail = "panel conviction crossed the stop threshold";
        break;
      }
      if (round >= cfg.rounds) { state.endReason = "cap"; break; }

      // ---- between rounds ----
      userNote = undefined;
      kind = "rebuttal";
      if (cfg.pause && !cfg.auto && cfg.tty) {
        const action = await clack.select({
          message: c.user(`Round ${round} is scored. Round ${round + 1}?`),
          options: [
            { value: "continue", label: `▶  Continue to round ${round + 1}` },
            { value: "steer", label: "💬 Interject", hint: "inject a question or challenge both debaters must address" },
            { value: "steelman", label: "🔄 Steelman round", hint: "each debater must argue the OTHER side" },
            { value: "verdict", label: "⚖  Go to final verdicts now" },
            { value: "abandon", label: "✕  Abandon debate", hint: "saves a partial transcript" },
          ],
        });
        if (clack.isCancel(action) || action === "abandon") { state.endReason = "abandoned"; break; }
        if (action === "verdict") { state.endReason = "user"; break; }
        if (action === "steelman") kind = "steelman";
        if (action === "steer") {
          const note = await clack.text({ message: c.user("Say it. Both debaters (and the judges) will hear it:") });
          if (!clack.isCancel(note) && String(note).trim()) {
            userNote = String(note).trim();
            state.notes.push({ round: round + 1, from: "you", text: userNote });
          }
        }
      }
      if (!cfg.mock && state.totals.costUsd > budgetWarnAt) {
        if (cfg.pause && cfg.tty && !cfg.auto) {
          const go = await clack.confirm({ message: c.warn(`Running spend is $${state.totals.costUsd.toFixed(2)} (engine A side) plus ${fmtTok(state.totals.inTok + state.totals.outTok)} total tokens. Keep going?`) });
          if (clack.isCancel(go) || !go) { state.endReason = "user"; break; }
        } else {
          ui.log(c.warn(` running spend: $${state.totals.costUsd.toFixed(2)} (engine A side) · ${fmtTok(state.totals.inTok + state.totals.outTok)} total tokens`));
        }
        budgetWarnAt *= 2;
      }

      // ---- next round: sequential rebuttals; alternate who speaks first so the
      // last-word advantage does not sit with one side all debate ----
      round++;
      state.round = round;
      const order: Participant[] = round % 2 === 0 ? [A, B] : [B, A];
      for (const p of order) {
        const opts: TurnOptions = { prompt: rebuttalPrompt(p.key as "a" | "b", round, state, cfg, p, kind, userNote) };
        const res = await performTurn(p, opts, { p, roundLabel: `ROUND ${round} · ${kind.toUpperCase()}`, showBody: true, verb: kind === "steelman" ? "steelmanning" : "rebutting" }, cfg);
        recordTurn(state, p.key as "a" | "b", round, kind, res);
      }
    }
  } catch (e) {
    if (e instanceof AbandonDebate) state.endReason = "abandoned";
    else throw e;
  }

  // ---- final verdicts ----
  if (state.endReason !== "abandoned") {
    ui.log();
    rule(P.pink, "═");
    ui.log(" " + gradientText("FINAL VERDICTS", [P.pink, P.purple, P.cyan]) + c.dim(`  · ${state.endDetail ?? endReasonLabel(state.endReason)}`));
    rule(P.pink, "═");
    const fPrompt = judgeFinalPrompt(state, cfg);
    const fGens = judges.map((j, i) => (i > 0 && !cfg.mock) ? pump(j.agent.runTurn({ prompt: fPrompt, schema: FINAL_SCHEMA })) : undefined);
    for (let i = 0; i < judges.length; i++) {
      const j = judges[i];
      const { res, parsed } = await judgeTurn(j, fPrompt, FINAL_SCHEMA,
        { p: j, roundLabel: "FINAL VERDICT", showBody: false, verb: "writing the verdict" }, cfg, fGens[i]);
      tally(state, res);
      const v = coerceFinalVerdict(parsed, j.key as "ja" | "jb") ?? degradedFinalVerdict(j.key as "ja" | "jb", res?.text);
      state.finals.push(v);
      renderFinalVerdict(v, setup);
    }
    renderPanelDecision(state, setup);
    ui.log(c.dim(`   engine reveal (no participant knew): ${setup.roleA} = ${cfg.modelA || "claude default"} · ${setup.roleB} = ${cfg.modelB || "codex default"} · judge 1 = ${cfg.judgeModelA || "claude default"} · judge 2 = ${cfg.judgeModelB || "codex default"}`));
  }

  // ---- export ----
  const file = exportPrepSheet(state, cfg);
  ui.log();
  ui.log(" " + c.ok("✓") + c.fg(" prep sheet saved · ") + c.user(`file://${file}`));
  const mins = ((Date.now() - state.startedAt) / 60000).toFixed(1);
  const cost = state.totals.costUsd ? ` · $${state.totals.costUsd.toFixed(2)} (engine A side)` : "";
  ui.log(c.dim(`   ${state.turns.length} statements · ${state.verdicts.length} deliberations · ${mins} min · ${fmtTok(state.totals.inTok)} in / ${fmtTok(state.totals.outTok)} out tok${cost}`));
}

function detectDeadlock(state: DebateState, round: number): boolean {
  if (round < 3) return false;
  const last = state.verdicts.filter((v) => v.round === round - 1);
  const prev = state.verdicts.filter((v) => v.round === round - 2);
  const tied = (vs: RoundVerdict[]) => vs.length > 0 && vs.every((v) => v.roundWinner === "tie");
  return tied(last) && tied(prev);
}

function degradedRoundVerdict(judge: "ja" | "jb", round: number, raw?: string): RoundVerdict {
  const five = Object.fromEntries(AXES.map((k) => [k, 5]));
  return {
    judge, round, onTrack: true, steeringNote: "",
    scores: { a: { ...five }, b: { ...five } }, roundWinner: "tie", cruxes: [],
    nextFocus: { a: "Continue your strongest line of argument.", b: "Continue your strongest line of argument." },
    clarifications: [],
    verdictReached: false, confidence: 0, leaning: "undecided",
    commentary: raw ? `(unparseable verdict; raw reply follows)\n\n${raw.slice(0, 600)}` : "(judge unavailable this round)",
    degraded: true,
  };
}

function degradedFinalVerdict(judge: "ja" | "jb", raw?: string): FinalVerdict {
  return {
    judge, winner: "draw", confidence: 0,
    bestArguments: { a: [], b: [] }, worstArguments: { a: [], b: [] },
    decidingFactors: "", steelman: { a: "", b: "" }, anticipatedAttacks: { a: [], b: [] },
    commentary: raw ? `(unparseable verdict; raw reply follows)\n\n${raw.slice(0, 800)}` : "(judge unavailable)",
    degraded: true,
  };
}

function endReasonLabel(r?: DebateState["endReason"]): string {
  return r === "panel" ? "the panel is beyond persuasion"
    : r === "cap" ? "round cap reached"
    : r === "user" ? "called by the moderator" : "debate ended";
}

function renderFinalVerdict(v: FinalVerdict, setup: DebateSetup) {
  const winner = v.winner === "draw" ? c.dim.bold("DRAW")
    : v.winner === "a" ? c.a.bold(`${setup.roleA} WINS`) : c.b.bold(`${setup.roleB} WINS`);
  const w = cols() - 10;
  const sec = (t: string) => c.pink.bold(t);
  const list = (xs: string[], paint: (s: string) => string) => xs.map((x) => `  ${paint("•")} ${wrapAnsi(x, w - 4).split("\n").join("\n    ")}`).join("\n") || c.dim("  (none given)");
  const body = [
    `${winner}   ${c.dim("conviction")} ${confBar(v.confidence)}`,
    "",
    sec("WHAT DECIDED IT"),
    wrapAnsi(c.fg(v.decidingFactors || "(not stated)"), w),
    "",
    sec("BEST ARGUMENTS"),
    c.a(` ${setup.roleA}`), list(v.bestArguments.a, c.a),
    c.b(` ${setup.roleB}`), list(v.bestArguments.b, c.b),
    "",
    sec("WORST ARGUMENTS"),
    c.a(` ${setup.roleA}`), list(v.worstArguments.a, c.a),
    c.b(` ${setup.roleB}`), list(v.worstArguments.b, c.b),
    "",
    sec("CLOSING STATEMENT"),
    renderMarkdown(v.commentary || "(none)", w),
  ].join("\n");
  ui.log(boxen(body, {
    borderStyle: "round", borderColor: judgeHex(v.judge), width: cols(),
    padding: { left: 2, right: 2, top: 0, bottom: 0 }, title: ` ⚖ ${judgeName(v.judge)} `, titleAlignment: "left",
  }));
}

function renderPanelDecision(state: DebateState, setup: DebateSetup) {
  const finals = state.finals.filter((f) => !f.degraded);
  if (!finals.length) { ui.log(); ui.log(" " + c.err("⚖ no usable verdicts; the panel failed to report")); return; }
  const wins = { a: 0, b: 0, draw: 0 };
  for (const f of finals) wins[f.winner]++;
  const partial = finals.length < state.finals.length ? " · one judge unavailable" : "";
  let text: string;
  if (finals.length === 1) {
    const f = finals[0];
    text = (f.winner === "draw" ? "VERDICT · DRAW" : `VERDICT · ${f.winner === "a" ? setup.roleA : setup.roleB} WINS`) + partial;
  } else if (wins.a && wins.b) text = "PANEL SPLIT DECISION · 1 – 1 · the motion is genuinely contested";
  else if (wins.a === finals.length) text = `PANEL UNANIMOUS · ${setup.roleA} WINS`;
  else if (wins.b === finals.length) text = `PANEL UNANIMOUS · ${setup.roleB} WINS`;
  else text = (wins.a ? `PANEL MAJORITY · ${setup.roleA}` : wins.b ? `PANEL MAJORITY · ${setup.roleB}` : "PANEL · DRAW") + partial;
  ui.log();
  ui.log(" " + gradientText(`⚖ ${text}`, [P.pink, P.purple, P.cyan]));
}

/* ================================================================== *
 * §14 PREP SHEET EXPORT
 * ================================================================== */

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "debate";
}

function exportPrepSheet(state: DebateState, cfg: Config): string {
  const { setup } = state;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  fs.mkdirSync(TRANSCRIPTS, { recursive: true });
  const file = path.join(TRANSCRIPTS, `${stamp}-${slugify(setup.topic)}.md`);
  const name = (k: "a" | "b") => (k === "a" ? setup.roleA : setup.roleB);
  const jname = (k: "ja" | "jb") => (k === "ja" ? "Judge 1" : "Judge 2");
  const sum = (s: Record<string, number>) => AXES.reduce((t, x) => t + (s[x] ?? 0), 0);
  const L: string[] = [];
  L.push(`# Debate Prep Sheet`);
  L.push(``);
  L.push(`**Motion:** ${setup.topic}`);
  if (setup.rawTopic && setup.rawTopic !== setup.topic) L.push(``, `*Sharpened from your original topic:* ${setup.rawTopic}`);
  L.push(``);
  L.push(`- ${name("a")} vs ${name("b")} · mode: ${setup.mode}`);
  L.push(`- Engine reveal (hidden from every participant during the debate): ${name("a")} = ${cfg.modelA || "claude default"} (${cfg.effortA}), ${name("b")} = ${cfg.modelB || "codex default"} (${cfg.effortB}); Judge 1 = ${cfg.judgeModelA || "claude default"}, Judge 2 = ${cfg.judgeModelB || "codex default"}`);
  L.push(`- Ended: ${state.endDetail ?? endReasonLabel(state.endReason)} after ${state.round} round(s) · ${new Date(state.startedAt).toString()}`);
  L.push(`- Web research: ${cfg.allowWeb ? "on" : "off"} · totals: ${state.totals.inTok} in / ${state.totals.outTok} out tokens${state.totals.costUsd ? ` · $${state.totals.costUsd.toFixed(2)} (engine A side)` : ""}`);
  if (setup.attachments.length) {
    L.push(`- Evidence: ${setup.attachments.map((a) => `${a.path} [${a.kind}]`).join(", ")}`);
  }
  if (state.finals.length) {
    L.push(``, `## Panel decision`);
    for (const f of state.finals) {
      L.push(``, `### ${jname(f.judge)} · winner: ${f.winner === "draw" ? "draw" : name(f.winner)} (confidence ${(f.confidence * 100).toFixed(0)}%)`);
      L.push(``, `**What decided it:** ${f.decidingFactors}`);
      L.push(``, `**Best arguments · ${name("a")}:**`, ...f.bestArguments.a.map((x) => `- ${x}`));
      L.push(``, `**Best arguments · ${name("b")}:**`, ...f.bestArguments.b.map((x) => `- ${x}`));
      L.push(``, `**Worst arguments · ${name("a")}:**`, ...f.worstArguments.a.map((x) => `- ${x}`));
      L.push(``, `**Worst arguments · ${name("b")}:**`, ...f.worstArguments.b.map((x) => `- ${x}`));
      L.push(``, `**Steelman · ${name("a")}:** ${f.steelman.a}`);
      L.push(``, `**Steelman · ${name("b")}:** ${f.steelman.b}`);
      L.push(``, `**If YOU defend ${name("a")}, prepare for:**`, ...f.anticipatedAttacks.a.map((x) => `- ${x}`));
      L.push(``, `**If YOU defend ${name("b")}, prepare for:**`, ...f.anticipatedAttacks.b.map((x) => `- ${x}`));
      L.push(``, f.commentary);
    }
  }
  if (state.verdicts.length) {
    L.push(``, `## Scorecard by round`, ``);
    L.push(`| Round | Judge | ${name("a")} (${AXES.map((a) => a[0].toUpperCase()).join("·")}) | ${name("b")} | Winner | Conviction | Beyond persuasion |`);
    L.push(`|---|---|---|---|---|---|---|`);
    for (const v of state.verdicts) {
      L.push(`| ${v.round} | ${jname(v.judge)} | ${AXES.map((a) => v.scores.a[a]).join("·")} = ${sum(v.scores.a)} | ${AXES.map((a) => v.scores.b[a]).join("·")} = ${sum(v.scores.b)} | ${v.roundWinner === "tie" ? "tie" : name(v.roundWinner)} | ${(v.confidence * 100).toFixed(0)}% | ${v.verdictReached ? "yes" : "no"} |`);
    }
  }
  const cruxAll = [...state.cruxes.entries()].flatMap(([j, m]) => [...m.values()].map((cx) => ({ j, cx })));
  if (cruxAll.length) {
    L.push(``, `## Cruxes (the load-bearing disagreements)`);
    for (const { j, cx } of cruxAll) L.push(`- \`${cx.id}\` (${jname(j as "ja" | "jb")}, ${cx.status}): ${cx.description}`);
  }
  if (state.notes.length) {
    L.push(``, `## Your interjections`);
    for (const n of state.notes) L.push(`- (before round ${n.round}) ${n.text}`);
  }
  L.push(``, `## Full transcript`);
  for (const t of state.turns) {
    L.push(``, `### Round ${t.round} · ${name(t.speaker)} · ${t.kind}`, ``, t.text);
    if (t.thinking.trim()) L.push(``, `<details><summary>thinking summary</summary>`, ``, t.thinking.trim(), ``, `</details>`);
  }
  for (const v of state.verdicts) {
    L.push(``, `### Round ${v.round} · ${jname(v.judge)} deliberation`, ``, v.commentary);
    if (v.steeringNote) L.push(``, `> steering: ${v.steeringNote}`);
    if (!v.verdictReached && v.nextFocus) L.push(``, `> next focus · ${name("a")}: ${v.nextFocus.a}`, `> next focus · ${name("b")}: ${v.nextFocus.b}`);
    if (v.clarifications?.length) L.push(``, `> probed: ${v.clarifications.join(" · ")}`);
  }
  fs.writeFileSync(file, L.join("\n") + "\n");
  return file;
}

/* ================================================================== *
 * §15 SETTINGS · persistent defaults + TUI config menu
 * ================================================================== */

interface Settings {
  modelA: string; effortA: string;
  modelB: string; effortB: string;
  judgeMode: "panel" | "claude" | "codex";
  judgeModelA: string; judgeEffortA: string;
  judgeModelB: string; judgeEffortB: string;
  web: boolean; rounds: number;
  pause: boolean;                    // pause between rounds for the interject/steelman menu
  sideMode: "auto" | "dialectic";    // auto = PRO/CON coin flip; dialectic = thesis vs antithesis
  sharpen: boolean;                  // pre-pass that rewrites the raw topic into a crisp motion
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

const DEFAULT_SETTINGS: Settings = {
  modelA: "claude-opus-4-8", effortA: "medium",
  modelB: "gpt-5.6-luna", effortB: "medium",
  judgeMode: "panel",
  judgeModelA: "claude-opus-4-8", judgeEffortA: "medium",
  judgeModelB: "gpt-5.6-luna", judgeEffortB: "medium",
  web: true, rounds: 6,
  pause: false, sideMode: "auto", sharpen: true,
};

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "db8");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function loadSettings(): Settings {
  let s: Settings = { ...DEFAULT_SETTINGS };
  try { s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) }; } catch {}
  if (!CLAUDE_EFFORTS.includes(s.effortA)) s.effortA = DEFAULT_SETTINGS.effortA;
  if (!CODEX_EFFORTS.includes(s.effortB)) s.effortB = DEFAULT_SETTINGS.effortB;
  if (!CLAUDE_EFFORTS.includes(s.judgeEffortA)) s.judgeEffortA = DEFAULT_SETTINGS.judgeEffortA;
  if (!CODEX_EFFORTS.includes(s.judgeEffortB)) s.judgeEffortB = DEFAULT_SETTINGS.judgeEffortB;
  if (!["panel", "claude", "codex"].includes(s.judgeMode)) s.judgeMode = "panel";
  s.rounds = Math.max(2, Math.min(12, Number(s.rounds) || 6));
  s.web = s.web !== false;
  s.pause = s.pause === true;
  s.sharpen = s.sharpen !== false;
  if (!["auto", "dialectic"].includes(s.sideMode)) s.sideMode = "auto";
  return s;
}

function saveSettings(s: Settings) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(s, null, 2) + "\n");
}

const CLAUDE_MODELS: [string, string][] = [
  ["claude-opus-4-8", "Opus 4.8 · the heavyweight"],
  ["opus", "opus · latest Opus alias"],
  ["sonnet", "sonnet · fast and sharp"],
  ["haiku", "haiku · cheap sparring partner"],
  ["", "CLI default · whatever your claude config says"],
];
const CODEX_MODELS: [string, string][] = [
  ["gpt-5.6-luna", "gpt-5.6-luna"],
  ["", "CLI default · whatever your codex config says"],
];

async function pickModelAndEffort(kind: "claude" | "codex", label: string,
                                  curModel: string, curEffort: string): Promise<[string, string] | null> {
  const models = kind === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
  const efforts = kind === "claude" ? CLAUDE_EFFORTS : CODEX_EFFORTS;
  const model = await clack.select({
    message: c.user(`${label} · model`),
    initialValue: models.some(([v]) => v === curModel) ? curModel : "__custom",
    options: [
      ...models.map(([value, hint]) => ({ value, label: value || "(cli default)", hint })),
      { value: "__custom", label: "custom…", hint: "type any model id" },
    ],
  });
  if (clack.isCancel(model)) return null;
  let chosen = model as string;
  if (chosen === "__custom") {
    const typed = await clack.text({ message: c.user("model id"), placeholder: curModel, defaultValue: curModel });
    if (clack.isCancel(typed)) return null;
    chosen = String(typed).trim();
  }
  const effort = await clack.select({
    message: c.user(`${label} · reasoning effort`),
    initialValue: efforts.includes(curEffort) ? curEffort : efforts[efforts.length - 1],
    options: efforts.map((e) => ({ value: e, label: e, hint: e === "xhigh" ? "deep deliberation (default)" : undefined })),
  });
  if (clack.isCancel(effort)) return null;
  return [chosen, effort as string];
}

async function settingsMenu(): Promise<boolean> {
  const s = loadSettings();
  const pad = (label: string) => label.padEnd(17);
  ui.log();
  clack.intro(c.pink.bold("db8 settings ") + c.dim("· defaults for every debate"));
  while (true) {
    const fmt = (m: string, e: string) => c.dim(`${m || "(cli default)"} · ${e}`);
    const choice = await clack.select({
      message: c.user("Pick a setting to change"),
      options: [
        { value: "a", label: pad("Claude debater") + fmt(s.modelA, s.effortA) },
        { value: "b", label: pad("Codex debater") + fmt(s.modelB, s.effortB) },
        { value: "ja", label: pad("Claude judge") + fmt(s.judgeModelA, s.judgeEffortA) },
        { value: "jb", label: pad("Codex judge") + fmt(s.judgeModelB, s.judgeEffortB) },
        { value: "judgeMode", label: pad("Judge bench") + c.dim(s.judgeMode === "panel" ? "panel · both judge, both must be beyond persuasion" : `${s.judgeMode} only`) },
        { value: "web", label: pad("Web research") + c.dim(s.web ? "on" : "off") },
        { value: "rounds", label: pad("Round cap") + c.dim(String(s.rounds)) },
        { value: "pause", label: pad("Pause rounds") + c.dim(s.pause ? "on · menu between rounds (interject, steelman, end)" : "off · debates run to completion hands-free") },
        { value: "sideMode", label: pad("Side mode") + c.dim(s.sideMode === "auto" ? "auto · PRO vs CON, coin-flip assignment" : "dialectic · thesis vs antithesis") },
        { value: "sharpen", label: pad("Sharpen motion") + c.dim(s.sharpen ? "on · a quick pre-pass turns your topic into a crisp motion" : "off · topics used verbatim") },
        { value: "reset", label: pad("Reset") + c.dim("back to factory defaults") },
        { value: "save", label: c.ok("Save and exit") },
        { value: "quit", label: c.dim("Exit without saving") },
      ],
    });
    if (clack.isCancel(choice) || choice === "quit") { clack.outro(c.dim("left unchanged")); return false; }
    if (choice === "save") { saveSettings(s); clack.outro(c.ok("saved · ") + c.dim(CONFIG_PATH)); return true; }
    if (choice === "reset") { Object.assign(s, DEFAULT_SETTINGS); continue; }
    if (choice === "a" || choice === "b" || choice === "ja" || choice === "jb") {
      const kind = choice === "a" || choice === "ja" ? "claude" : "codex";
      const labels: Record<string, string> = { a: "Claude debater", b: "Codex debater", ja: "Claude judge", jb: "Codex judge" };
      const cur: [string, string] = choice === "a" ? [s.modelA, s.effortA] : choice === "b" ? [s.modelB, s.effortB]
        : choice === "ja" ? [s.judgeModelA, s.judgeEffortA] : [s.judgeModelB, s.judgeEffortB];
      const picked = await pickModelAndEffort(kind, labels[choice], cur[0], cur[1]);
      if (!picked) continue;
      if (choice === "a") [s.modelA, s.effortA] = picked;
      else if (choice === "b") [s.modelB, s.effortB] = picked;
      else if (choice === "ja") [s.judgeModelA, s.judgeEffortA] = picked;
      else [s.judgeModelB, s.judgeEffortB] = picked;
    } else if (choice === "judgeMode") {
      const m = await clack.select({
        message: c.user("Who judges?"),
        initialValue: s.judgeMode,
        options: [
          { value: "panel", label: "panel", hint: "Claude + Codex both judge; debate ends only when BOTH are beyond persuasion" },
          { value: "claude", label: "claude only" },
          { value: "codex", label: "codex only" },
        ],
      });
      if (!clack.isCancel(m)) s.judgeMode = m as Settings["judgeMode"];
    } else if (choice === "web") {
      const w = await clack.select({
        message: c.user("Web research for the debaters?"),
        initialValue: s.web ? "on" : "off",
        options: [{ value: "on", label: "on", hint: "cite live sources" }, { value: "off", label: "off", hint: "first principles only" }],
      });
      if (!clack.isCancel(w)) s.web = w === "on";
    } else if (choice === "rounds") {
      const r = await clack.text({
        message: c.user("Hard cap on rounds (2-12; judges usually stop earlier)"),
        defaultValue: String(s.rounds), placeholder: String(s.rounds),
        validate: (v: string | undefined) => (v && /^\d+$/.test(v.trim()) && +v >= 2 && +v <= 12 ? undefined : "a number from 2 to 12"),
      });
      if (!clack.isCancel(r)) s.rounds = +String(r).trim();
    } else if (choice === "pause") {
      const p2 = await clack.select({
        message: c.user("Pause between rounds?"),
        initialValue: s.pause ? "on" : "off",
        options: [
          { value: "off", label: "off", hint: "debates run to completion hands-free (default)" },
          { value: "on", label: "on", hint: "menu after each round: interject, steelman round, end early" },
        ],
      });
      if (!clack.isCancel(p2)) s.pause = p2 === "on";
    } else if (choice === "sideMode") {
      const m2 = await clack.select({
        message: c.user("How are sides drawn?"),
        initialValue: s.sideMode,
        options: [
          { value: "auto", label: "auto", hint: "PRO vs CON, coin-flip engine assignment" },
          { value: "dialectic", label: "dialectic", hint: "thesis vs antithesis · best for nuance-hunting" },
        ],
      });
      if (!clack.isCancel(m2)) s.sideMode = m2 as Settings["sideMode"];
    } else if (choice === "sharpen") {
      const sh = await clack.select({
        message: c.user("Sharpen raw topics into crisp motions before the debate?"),
        initialValue: s.sharpen ? "on" : "off",
        options: [
          { value: "on", label: "on", hint: "a fast pre-pass removes ambiguity that invites wording-quibbles" },
          { value: "off", label: "off", hint: "use your topic verbatim" },
        ],
      });
      if (!clack.isCancel(sh)) s.sharpen = sh === "on";
    }
  }
}

/* ================================================================== *
 * §16 CLI · args, preflight, banner, REPL
 * ================================================================== */

const HELP = `
${chalk.hex(P.pink).bold("db8")} ${c.dim("· adversarial reasoning arena · claude × codex, panel-judged")}

${c.fg("USAGE")}
  db8 [flags] ["topic"]
  db8 config           open the settings menu (models, efforts, judges, web, rounds)

${c.fg("DEFAULTS")} ${c.dim("(saved in ~/.config/db8/config.json · change via db8 config or /config)")}
  engine A             claude-opus-4-8 · medium effort
  engine B             gpt-5.6-luna · medium effort
  judges               panel of both · debate ends only when BOTH are beyond persuasion
  blinding             debaters and judges never learn which engine powers anyone;
                       sides are just PRO and CON (engines revealed to YOU afterwards)
  flow                 topics are sharpened into a crisp motion, then the debate
                       runs to completion hands-free (turn pausing on in settings)

${c.fg("FLAGS")} ${c.dim("(one-off overrides; saved settings stay untouched)")}
  --topic "..."        motion for the first debate (or pass as a positional)
  --rounds N           hard cap on rounds (judges usually stop earlier)
  --no-web / --web     forbid or force web research for this run
  --judge MODE         panel | claude | codex
  --model-a M          engine A (claude) model  --effort-a E   low|medium|high|xhigh|max
  --model-b M          engine B (codex) model   --effort-b E   minimal|low|medium|high|xhigh
  --judge-model M      model override for the judge(s); per-judge control lives in db8 config
  --pause              pause between rounds (interject / steelman / end early menu)
  --dialectic          thesis vs antithesis instead of PRO vs CON
  --no-sharpen         use the topic verbatim, skip the motion-sharpening pre-pass
  --fast               cheap sparring: haiku + low effort everywhere, 3 rounds max
  --auto               never prompt at all (also implied when not a TTY)
  --debug-events       tee raw CLI JSONL to .debate-tmp/ for diagnosis
  --no-color           disable colors
  -h, --help           this

${c.fg("IN THE ARENA")}
  · paste file paths (pdf, png, code, anything) straight into the topic:
    both debaters read them as evidence. macOS clipboard images attach too.
  · with --pause (or Pause rounds: on in settings): interject a challenge,
    order a steelman round, or call for the verdict early between rounds.
  · Ctrl-C aborts the current turn; twice quits.
  · every debate exports a prep sheet (transcript, scorecards, steelmen,
    anticipated attacks) to transcripts/ next to the script.

${c.fg("EXAMPLES")}
  db8 "Remote work is a net negative for junior engineers"
  db8 --no-web --rounds 3 "P=NP"
  db8 "Is this design sound? ~/docs/rfc.pdf ~/diagrams/arch.png"
  db8 --fast "quick sparring session"
  DEBATE_MOCK=1 db8 --auto "ui dry run"   ${c.dim("# zero tokens")}
`;

function banner() {
  const art = [
    " █▀▄ ██▄ ▄▀▄",
    " █▄▀ █▄█ ▄█▄",
  ];
  ui.log();
  for (const l of art) ui.log(gradientText(l, [P.pink, P.purple, P.cyan]));
  ui.log(c.dim(" the agora · adversarial reasoning arena · claude × codex · panel-judged"));
  ui.log();
}

async function preflight(cfg: Config): Promise<Record<string, string>> {
  if (cfg.mock) return { claude: "mock", codex: "mock" };
  const bins: Record<string, string> = {};
  const need = [["claude", "npm i -g @anthropic-ai/claude-code (then run `claude` once to log in)"],
                ["codex", "npm i -g @openai/codex (then run `codex` once to log in)"]] as const;
  for (const [bin, install] of need) {
    const p = Bun.which(bin);
    if (!p) {
      ui.log(boxen(c.err(`The ${bin} CLI is not on your PATH.\n`) + c.fg(`install: ${install}`), { borderColor: P.red, borderStyle: "round", padding: { left: 2, right: 2, top: 0, bottom: 0 } }));
      process.exit(1);
    }
    bins[bin] = p;
  }
  try {
    if (!fs.existsSync(path.join(WORKDIR, ".git"))) Bun.spawnSync(["git", "init", "-q"], { cwd: WORKDIR });
  } catch {}
  const version = async (cmd: string[]) => {
    try {
      const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", env: claudeEnv() });
      const t = setTimeout(() => p.kill(), 15000);
      const out = await new Response(p.stdout).text();
      clearTimeout(t);
      return out.trim().split("\n")[0].replace(" (Claude Code)", "").replace("codex-cli ", "");
    } catch { return "?"; }
  };
  const [cv, xv] = await Promise.all([version([bins.claude, "--version"]), version([bins.codex, "--version"])]);
  ui.log(c.dim(` claude ${cv} · codex ${xv} · transcripts → ${TRANSCRIPTS.replace(os.homedir(), "~")}`));
  return bins;
}

function buildCfg(flags: any, tty: boolean): Config {
  const s = loadSettings();
  const cfg: Config = {
    rounds: flags.rounds !== undefined ? Math.max(2, Math.min(12, parseInt(flags.rounds, 10) || s.rounds)) : s.rounds,
    allowWeb: flags["no-web"] ? false : flags.web ? true : s.web,
    judgeMode: (flags.judge ?? s.judgeMode) as Config["judgeMode"],
    modelA: flags["model-a"] ?? s.modelA, effortA: flags["effort-a"] ?? s.effortA,
    modelB: flags["model-b"] ?? s.modelB, effortB: flags["effort-b"] ?? s.effortB,
    judgeModelA: flags["judge-model"] ?? s.judgeModelA, judgeEffortA: s.judgeEffortA,
    judgeModelB: flags["judge-model"] ?? s.judgeModelB, judgeEffortB: s.judgeEffortB,
    pause: flags.pause ? true : s.pause,
    sideMode: flags.dialectic ? "dialectic" : s.sideMode,
    sharpen: flags["no-sharpen"] ? false : s.sharpen,
    auto: flags.auto || !tty || !(process.stdin.isTTY ?? false),
    mock: process.env.DEBATE_MOCK === "1",
    debugEvents: flags["debug-events"], fast: flags.fast, tty,
  };
  if (cfg.fast) {
    if (!flags["model-a"]) cfg.modelA = "haiku";
    if (!flags["effort-a"]) cfg.effortA = "low";
    if (!flags["model-b"]) cfg.modelB = "";
    if (!flags["effort-b"]) cfg.effortB = "low";
    if (!flags["judge-model"]) { cfg.judgeModelA = "haiku"; cfg.judgeModelB = ""; }
    cfg.judgeEffortA = "low";
    cfg.judgeEffortB = "low";
    cfg.rounds = Math.min(cfg.rounds, 3);
  }
  if (!CLAUDE_EFFORTS.includes(cfg.effortA)) { console.error(c.err(`--effort-a must be one of: ${CLAUDE_EFFORTS.join(" | ")}`)); process.exit(2); }
  if (!CODEX_EFFORTS.includes(cfg.effortB)) { console.error(c.err(`--effort-b must be one of: ${CODEX_EFFORTS.join(" | ")}`)); process.exit(2); }
  return cfg;
}

async function main() {
  let flags: any, positionals: string[];
  try {
    ({ values: flags, positionals } = parseArgs({
      args: Bun.argv.slice(2), allowPositionals: true,
      options: {
        topic: { type: "string" }, rounds: { type: "string" },
        "no-web": { type: "boolean", default: false }, web: { type: "boolean", default: false },
        judge: { type: "string" },
        "model-a": { type: "string" }, "effort-a": { type: "string" },
        "model-b": { type: "string" }, "effort-b": { type: "string" },
        "judge-model": { type: "string" },
        auto: { type: "boolean", default: false }, fast: { type: "boolean", default: false },
        pause: { type: "boolean", default: false }, dialectic: { type: "boolean", default: false },
        "no-sharpen": { type: "boolean", default: false },
        "debug-events": { type: "boolean", default: false }, "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    console.error(c.err(`bad flags: ${(e as Error).message}`));
    console.log(HELP);
    process.exit(2);
  }
  if (flags.help) { console.log(HELP); return; }
  if (flags["no-color"]) chalk.level = 0;
  if (flags.judge && !["panel", "claude", "codex"].includes(flags.judge)) { console.error(c.err(`--judge must be panel | claude | codex`)); process.exit(2); }

  const tty = process.stdout.isTTY ?? false;
  let cfg = buildCfg(flags, tty);

  fs.mkdirSync(TMP, { recursive: true });
  installSignalHandlers(ui);
  banner();

  if (positionals[0]?.toLowerCase() === "config") {
    if (!tty) { console.error(c.err("db8 config needs an interactive terminal")); process.exit(2); }
    await settingsMenu();
    return;
  }

  if (cfg.mock) ui.log(c.warn(" MOCK MODE · canned agents, zero tokens"));
  const bins = await preflight(cfg);
  ui.log(c.dim(` engines: A ${cfg.modelA || "cli default"}·${cfg.effortA} × B ${cfg.modelB || "cli default"}·${cfg.effortB} · judges: ${cfg.judgeMode} · all participants blind to engines · "db8 config" or /config to change`));

  let presetTopic: string | undefined = flags.topic ?? (positionals.length ? positionals.join(" ") : undefined);
  if (!presetTopic && cfg.auto) {
    console.error(c.err("No TTY and no --topic given; nothing to debate. See --help."));
    process.exit(2);
  }

  while (true) {
    const setup = await intake(cfg, bins, presetTopic);
    presetTopic = undefined;
    if (setup === "config") {
      const saved = await settingsMenu();
      if (saved) {
        cfg = buildCfg(flags, tty);
        ui.log(c.dim(` engines: A ${cfg.modelA || "cli default"}·${cfg.effortA} × B ${cfg.modelB || "cli default"}·${cfg.effortB} · judges: ${cfg.judgeMode}`));
      }
      continue;
    }
    if (!setup) break;
    try {
      await runDebate(setup, cfg, bins);
    } catch (e) {
      ui.clearStatus();
      ui.log(c.err(` debate crashed: ${(e as Error).message}`));
      if (cfg.debugEvents) ui.log(c.dim(` raw event logs: ${TMP}`));
    }
    if (cfg.auto) break;
    ui.log();
    rule();
  }
  ui.log(c.dim("\n adjourned. ") + gradientText("go argue with a human now.", [P.pink, P.purple, P.cyan]) + "\n");
}

await main();
