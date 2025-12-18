import { execFileSync, spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, resolve, basename } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

const INTENTS = ["feat", "fix", "debug", "refactor", "test", "doc", "ops", "review", "spike"] as const;
type Intent = (typeof INTENTS)[number];

interface PluginConfig {
  cooldownMs: number;
  debounceMs: number;
  maxSignals: number;
  model: string;
  debug: boolean;
  customInstructions: string;
  useAgentsMd: boolean;
}

interface State {
  lastRename: number;
  lastCheck: number;
  currentName: string;
  signals: string[];
}

interface PluginEvent {
  type: string;
  path?: string;
  command?: string;
  messages?: Array<{ content?: string }>;
  todos?: Array<{ content?: string }>;
}

function loadConfig(): PluginConfig {
  const env = process.env;
  return {
    cooldownMs: Number(env.OPENCODE_ZN_COOLDOWN_MS) || 5 * 60 * 1000,
    debounceMs: Number(env.OPENCODE_ZN_DEBOUNCE_MS) || 5 * 1000,
    maxSignals: Number(env.OPENCODE_ZN_MAX_SIGNALS) || 25,
    model: env.OPENCODE_ZN_MODEL || "gemini-3-flash-preview",
    debug: env.OPENCODE_ZN_DEBUG === "1",
    customInstructions: env.OPENCODE_ZN_INSTRUCTIONS || "",
    useAgentsMd: env.OPENCODE_ZN_USE_AGENTS_MD !== "0",
  };
}

function extractNamingGuidance(agentsMdContent: string): string | null {
  const namingSectionMatch = agentsMdContent.match(
    /##\s*(?:Session\s*)?Naming[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i
  );
  if (namingSectionMatch) {
    return namingSectionMatch[1].trim().slice(0, 400);
  }

  const guidelinesMatch = agentsMdContent.match(
    /##\s*Guidelines[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i
  );
  if (guidelinesMatch) {
    const content = guidelinesMatch[1];
    const namingLines = content
      .split("\n")
      .filter((line) => /naming|session|tag|intent/i.test(line))
      .join("\n");
    if (namingLines.length > 10) {
      return namingLines.trim().slice(0, 400);
    }
  }

  return null;
}

function loadAgentsMdGuidance(cwd: string, log: ReturnType<typeof createLogger>): string | null {
  const resolvedCwd = resolve(cwd);
  const possiblePaths = [
    join(resolvedCwd, "AGENTS.md"),
    join(resolvedCwd, ".github", "AGENTS.md"),
    join(resolvedCwd, "docs", "AGENTS.md"),
  ];

  for (const agentsPath of possiblePaths) {
    try {
      const realPath = resolve(agentsPath);
      if (!realPath.startsWith(resolvedCwd)) {
        log.debug(`Path traversal detected: ${agentsPath}`);
        continue;
      }

      if (existsSync(realPath)) {
        const content = readFileSync(realPath, "utf8");
        const guidance = extractNamingGuidance(content);
        if (guidance) {
          log.debug(`Loaded naming guidance from ${realPath}`);
          return guidance;
        }
        log.debug(`No naming section found in ${realPath}`);
      }
    } catch (e) {
      log.debug(`Failed to read ${agentsPath}: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  return null;
}

function createLogger(debug: boolean) {
  return {
    debug: (msg: string) => debug && console.error(`[zellij-namer] ${msg}`),
    error: (msg: string) => console.error(`[zellij-namer] ERROR: ${msg}`),
  };
}

function isValidPath(p: string): boolean {
  return typeof p === "string" && p.length > 0 && p.length < 4096 && !p.includes("\0");
}

function findZellij(log: ReturnType<typeof createLogger>): string {
  const home = process.env.HOME || "";
  const paths = [
    join(home, ".cargo", "bin", "zellij"),
    "/usr/local/bin/zellij",
    "/usr/bin/zellij",
  ];

  for (const p of paths) {
    if (!isValidPath(p)) continue;
    try {
      if (existsSync(p)) {
        execFileSync(p, ["--version"], { stdio: "ignore", timeout: 1000 });
        log.debug(`Found zellij at: ${p}`);
        return p;
      }
    } catch (e) {
      log.debug(`Zellij not at ${p}: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  try {
    execFileSync("zellij", ["--version"], { stdio: "ignore", timeout: 1000 });
    log.debug("Using zellij from PATH");
    return "zellij";
  } catch {
    log.debug("Zellij not found in PATH");
  }

  return "zellij";
}

function getCurrentSession(zellij: string, log: ReturnType<typeof createLogger>): string | null {
  const envSession = process.env.ZELLIJ_SESSION_NAME;
  if (envSession) {
    log.debug(`Session from env: ${envSession}`);
    return envSession;
  }

  try {
    const output = execFileSync(zellij, ["list-sessions"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, "");
    const match = stripped.match(/^([a-z0-9-]+)\s/m);
    if (match) {
      log.debug(`Session from list: ${match[1]}`);
      return match[1];
    }
  } catch (e) {
    log.debug(`Failed to list sessions: ${e instanceof Error ? e.message : "unknown"}`);
  }

  return null;
}

function sanitize(input: string, maxLen = 20): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "")
    .slice(0, maxLen);
}

function inferIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(test|pytest|jest|spec|vitest)\b/.test(t)) return "test";
  if (/\b(debug|trace|breakpoint|stack|error)\b/.test(t)) return "debug";
  if (/\b(fix|bug|broken|issue|patch)\b/.test(t)) return "fix";
  if (/\b(refactor|cleanup|reorganize|restructure)\b/.test(t)) return "refactor";
  if (/\b(doc|readme|documentation)\b/.test(t)) return "doc";
  if (/\b(review|pr|pull.?request)\b/.test(t)) return "review";
  if (/\b(deploy|docker|k8s|terraform|ci|cd)\b/.test(t)) return "ops";
  if (/\b(spike|explore|investigate|research)\b/.test(t)) return "spike";
  return "feat";
}

function inferTag(text: string): string | null {
  const keywords = ["auth", "api", "db", "ui", "config", "cache", "perf", "security", "test"];
  const t = text.toLowerCase();
  for (const kw of keywords) {
    if (t.includes(kw)) return kw;
  }
  return null;
}

function getProjectName(cwd: string, log: ReturnType<typeof createLogger>): string {
  if (!isValidPath(cwd)) {
    log.debug("Invalid cwd path");
    return "project";
  }

  const resolvedCwd = resolve(cwd);

  try {
    const gitOutput = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolvedCwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const name = basename(gitOutput);
    log.debug(`Project from git: ${name}`);
    return sanitize(name);
  } catch {
    log.debug("Not a git repo or git failed");
  }

  try {
    const pkgPath = join(resolvedCwd, "package.json");
    const realPkgPath = resolve(pkgPath);
    if (!realPkgPath.startsWith(resolvedCwd)) {
      log.debug("Path traversal detected in package.json path");
      return sanitize(basename(resolvedCwd));
    }

    if (existsSync(realPkgPath)) {
      const pkgContent = readFileSync(realPkgPath, "utf8");
      const pkg = JSON.parse(pkgContent);
      if (pkg.name && typeof pkg.name === "string") {
        const name = pkg.name.replace(/^@[^/]+\//, "");
        log.debug(`Project from package.json: ${name}`);
        return sanitize(name);
      }
    }
  } catch (e) {
    log.debug(`Failed to read package.json: ${e instanceof Error ? e.message : "unknown"}`);
  }

  const fallback = basename(resolvedCwd) || "project";
  log.debug(`Project from directory: ${fallback}`);
  return sanitize(fallback);
}

async function generateNameWithAI(
  project: string,
  signals: string[],
  config: PluginConfig,
  agentsMdGuidance: string | null,
  log: ReturnType<typeof createLogger>
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    log.debug("No API key found, skipping AI generation");
    return null;
  }

  try {
    const gemini = new GoogleGenerativeAI(apiKey);
    const model = gemini.getGenerativeModel({ model: config.model });

    const safeSignals = signals.slice(-5).map((s) => s.slice(0, 100));
    
    let prompt = `Generate a short Zellij terminal session name.
Project: ${project}
Recent activity: ${safeSignals.join("; ")}

Rules:
- Format: project-intent or project-intent-tag
- Intent must be one of: feat, fix, debug, refactor, test, doc, ops, review, spike
- Tag is optional, 2-8 chars, describes specific area
- Total max 40 chars, lowercase, only a-z 0-9 and hyphens
- Return ONLY the session name, nothing else`;

    if (agentsMdGuidance) {
      prompt += `\n\nProject naming guidelines from AGENTS.md:\n${agentsMdGuidance}`;
    }

    if (config.customInstructions) {
      prompt += `\n\nUser instructions (take precedence over AGENTS.md):\n${config.customInstructions.slice(0, 500)}`;
    }

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ]);

    const text = result.response.text().trim().toLowerCase();
    const match = text.match(/^[a-z0-9-]{5,40}$/);
    if (match) {
      log.debug(`AI generated name: ${match[0]}`);
      return match[0];
    }
    log.debug(`AI response invalid: ${text.slice(0, 50)}`);
    return null;
  } catch (e) {
    log.debug(`AI generation failed: ${e instanceof Error ? e.message : "unknown"}`);
    return null;
  }
}

function buildName(project: string, intent: Intent, tag?: string | null): string {
  const base = `${project}-${intent}`;
  if (tag && base.length + tag.length + 1 <= 40) {
    return `${base}-${tag}`;
  }
  return base;
}

function renameSession(
  name: string,
  zellij: string,
  session: string | null,
  log: ReturnType<typeof createLogger>
): boolean {
  try {
    const args = session
      ? ["--session", session, "action", "rename-session", name]
      : ["action", "rename-session", name];

    spawn(zellij, args, { detached: true, stdio: "ignore" }).unref();
    log.debug(`Renamed session to: ${name}`);
    return true;
  } catch (e) {
    log.error(`Rename failed: ${e instanceof Error ? e.message : "unknown"}`);
    return false;
  }
}

function isValidEvent(e: unknown): e is PluginEvent {
  return typeof e === "object" && e !== null && "type" in e && typeof (e as PluginEvent).type === "string";
}

function addSignal(state: State, signal: string, maxSignals: number): void {
  const safe = signal.slice(0, 200);
  state.signals.push(safe);
  if (state.signals.length > maxSignals) {
    state.signals = state.signals.slice(-maxSignals);
  }
}

export const ZellijNamer = async ({ directory }: { directory: string }) => {
  const config = loadConfig();
  const log = createLogger(config.debug);

  const state: State = {
    lastRename: 0,
    lastCheck: 0,
    currentName: "",
    signals: [],
  };

  const zellij = findZellij(log);

  let agentsMdGuidance: string | null = null;
  if (config.useAgentsMd) {
    agentsMdGuidance = loadAgentsMdGuidance(directory, log);
  }

  log.debug(`Initialized with config: ${JSON.stringify({ ...config, debug: config.debug })}`);

  async function maybeRename(cwd: string): Promise<void> {
    const now = Date.now();

    if (now - state.lastCheck < config.debounceMs) {
      log.debug("Skipped: debounce");
      return;
    }
    state.lastCheck = now;

    if (now - state.lastRename < config.cooldownMs) {
      log.debug("Skipped: cooldown");
      return;
    }

    const session = getCurrentSession(zellij, log);
    if (!session && !process.env.ZELLIJ) {
      log.debug("Skipped: not in zellij");
      return;
    }

    const project = getProjectName(cwd, log);
    const signalText = state.signals.join(" ");
    const intent = inferIntent(signalText);
    const tag = inferTag(signalText);

    let name = await generateNameWithAI(project, state.signals, config, agentsMdGuidance, log);
    if (!name) {
      name = buildName(project, intent, tag);
    }

    if (name === state.currentName) {
      log.debug("Skipped: name unchanged");
      return;
    }

    if (renameSession(name, zellij, session, log)) {
      state.currentName = name;
      state.lastRename = now;
      state.signals = [];
    }
  }

  return {
    event: async ({ event }: { event: unknown }) => {
      if (!isValidEvent(event)) {
        log.debug("Invalid event received");
        return;
      }

      if (event.type === "session.idle") {
        const msgs = event.messages || [];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg?.content && typeof lastMsg.content === "string") {
          addSignal(state, lastMsg.content, config.maxSignals);
        }
        process.nextTick(() => maybeRename(directory).catch((e) => log.error(e?.message || "unknown")));
      }

      if (event.type === "file.edited" && event.path && typeof event.path === "string") {
        addSignal(state, `file:${event.path}`, config.maxSignals);
      }

      if (event.type === "command.executed" && event.command && typeof event.command === "string") {
        addSignal(state, `cmd:${event.command}`, config.maxSignals);
      }

      if (event.type === "todo.updated") {
        const todos = event.todos || [];
        const first = todos[0];
        if (first?.content && typeof first.content === "string") {
          addSignal(state, `todo:${first.content}`, config.maxSignals);
        }
      }
    },
  };
};
