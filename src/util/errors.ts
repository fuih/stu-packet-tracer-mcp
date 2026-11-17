/**
 * Standardized error class and factory for stu-packet-tracer-mcp.
 *
 * Every user-facing error should be an actionable English sentence explaining
 * what failed, why (if known), and what to do next.
 */

export class PtError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "PtError";
    this.code = code;
    this.hint = hint;
  }

  format(): string {
    const base = `[${this.code}] ${this.message}`;
    return this.hint ? `${base}\nHint: ${this.hint}` : base;
  }
}

export function ptError(code: string, message: string, hint?: string): PtError {
  return new PtError(code, message, hint);
}
