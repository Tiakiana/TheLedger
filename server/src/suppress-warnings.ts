// node:sqlite prints an ExperimentalWarning on Node 22. It is stable enough for our use
// (it is the same SQLite engine), so silence only that specific warning.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof args[0] === 'string' ? args[0] : (args[0] as { type?: string } | undefined)?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  return (original as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;
export {};
