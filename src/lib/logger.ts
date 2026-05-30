// Logger estruturado mínimo (JSON), sem dependência externa.
// Em produção, plugue um transporte (Datadog, Axiom, etc.) ou troque por pino.
// O objetivo aqui é: saída parseável + correlação por requestId, em vez de
// console.error solto que vira ruído não-pesquisável no hot path.

type Level = "info" | "warn" | "error";

interface LogFields {
  [key: string]: unknown;
}

function emit(level: Level, message: string, fields: LogFields = {}) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  // stdout/stderr conforme o nível; a Vercel coleta ambos.
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) =>
    emit("error", message, fields),
};

/**
 * Serializa um erro de forma segura para log, sem vazar objetos gigantes
 * nem PII. Captura apenas name + message + stack.
 */
export function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      stack: err.stack,
    };
  }
  return { errorMessage: String(err) };
}
