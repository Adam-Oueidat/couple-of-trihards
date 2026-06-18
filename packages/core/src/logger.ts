type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function minLevel(): number {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return LEVELS[env] ?? LEVELS.info;
}

export interface LogContext {
  [key: string]: unknown;
}

function formatCtx(ctx?: LogContext): string {
  if (!ctx) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined) continue;
    let s: string;
    if (typeof v === "string") s = v.includes(" ") ? JSON.stringify(v) : v;
    else if (typeof v === "number" || typeof v === "boolean") s = String(v);
    else s = JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function emit(level: Level, tag: string, message: string, ctx?: LogContext): void {
  if (LEVELS[level] < minLevel()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${message}${formatCtx(ctx)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function errorContext(err: unknown): LogContext {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack };
  }
  return { error: String(err) };
}

export interface Logger {
  debug(message: string, ctx?: LogContext): void;
  info(message: string, ctx?: LogContext): void;
  warn(message: string, ctx?: LogContext): void;
  error(message: string, errOrCtx?: unknown): void;
  child(subtag: string): Logger;
}

export function createLogger(tag: string): Logger {
  return {
    debug: (m, c) => emit("debug", tag, m, c),
    info: (m, c) => emit("info", tag, m, c),
    warn: (m, c) => emit("warn", tag, m, c),
    error: (m, ec) => {
      if (ec === undefined) emit("error", tag, m);
      else if (
        ec instanceof Error ||
        (typeof ec === "object" &&
          ec !== null &&
          "message" in ec &&
          "stack" in ec)
      ) {
        emit("error", tag, m, errorContext(ec));
      } else {
        emit("error", tag, m, ec as LogContext);
      }
    },
    child: (sub) => createLogger(`${tag}:${sub}`),
  };
}
