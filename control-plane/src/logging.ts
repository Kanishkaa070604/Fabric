export type LogFields = {
  layer?: string;
  component?: string;
  correlation_id?: string;
  tenant_id?: string;
  registration_id?: string;
  agent_id?: string;
  stream_id?: string;
  [key: string]: unknown;
};

function emit(level: string, msg: string, fields: LogFields = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    component: fields.component ?? "control-plane",
    ...fields,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields & { error?: string }) =>
    emit("error", msg, fields),
};
