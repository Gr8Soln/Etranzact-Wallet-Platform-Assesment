import { AsyncLocalStorage } from 'async_hooks';

interface CorrelationContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function runWithCorrelationId(correlationId: string, fn: () => void): void {
  storage.run({ correlationId }, fn);
}
