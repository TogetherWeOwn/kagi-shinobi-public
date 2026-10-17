// Structured JSON logging for Workers observability.
// Anything logged here shows up in `wrangler tail` and the observability tab.

type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const payload = { level, msg, ...(fields ?? {}) };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logInfo = (msg: string, fields?: Record<string, unknown>) =>
  emit("info", msg, fields);
export const logWarn = (msg: string, fields?: Record<string, unknown>) =>
  emit("warn", msg, fields);
export const logError = (msg: string, fields?: Record<string, unknown>) =>
  emit("error", msg, fields);
