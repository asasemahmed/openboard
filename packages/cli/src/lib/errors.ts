import { OpenBoardError } from '@openboard/core';
import { type CliIo, isDebug, println } from './io.js';

/** An expected failure: printed as one line, without a stack trace. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Print an error as one line on stderr (plus the stack when debugging) and return the exit code. */
export function reportError(io: CliIo, error: unknown): number {
  const message = describeError(error);
  println(io.stderr, `openboard: ${message}`);
  if (isDebug(io) && error instanceof Error && error.stack) println(io.stderr, error.stack);
  return error instanceof CliError ? error.exitCode : 1;
}

function describeError(error: unknown): string {
  if (error instanceof CliError || error instanceof OpenBoardError) return error.message;
  if (isNodeError(error)) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return `permission denied${error.path ? `: ${error.path}` : ''}`;
    }
    if (error.code === 'ENOENT' && error.path) return `no such file or directory: ${error.path}`;
  }
  if (error instanceof Error) return error.message.split('\n')[0] || error.name;
  return String(error);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}
