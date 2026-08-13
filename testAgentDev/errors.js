export function serializeError(error) {
  if (!error) {
    return null;
  }
  if (!(error instanceof Error)) {
    return { name: 'NonErrorFailure', message: String(error), stack: String(error) };
  }
  const serialized = {
    name: error.name,
    message: error.message,
    stack: error.stack || `${error.name}: ${error.message}`
  };
  if (['string', 'number'].includes(typeof error.code)) {
    serialized.code = error.code;
  }
  if (error.cause) {
    serialized.cause = serializeError(error.cause);
  }
  if (error instanceof AggregateError) {
    serialized.errors = [...error.errors].map(serializeError);
  }
  return serialized;
}

export class HarnessError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'HarnessError';
    if (details !== undefined) {
      this.details = details;
    }
  }
}
