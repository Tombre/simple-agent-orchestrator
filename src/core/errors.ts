export class HandlerTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Handler attempt timed out after ${timeoutMs}ms`);
    this.name = "HandlerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
