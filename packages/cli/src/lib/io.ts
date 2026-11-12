/**
 * Everything a command needs from its process, passed in so tests can capture
 * output and choose the working directory without touching the real process.
 */
export interface Output {
  write(text: string): unknown;
  /** True when this stream is an interactive terminal. */
  isTTY?: boolean;
}

export interface CliIo {
  stdout: Output;
  stderr: Output;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Opens a URL in the user's browser. Defaults to the system browser. */
  openUrl?: (url: string) => Promise<void>;
  /**
   * Resolves when the process is asked to shut down (SIGINT or SIGTERM).
   * Defaults to listening for those signals.
   */
  shutdown?: () => Promise<string>;
}

export function processIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    env: process.env,
  };
}

/** Write one line (a newline is added). */
export function println(out: Output, line = ''): void {
  out.write(`${line}\n`);
}

export function isDebug(io: Pick<CliIo, 'env'>): boolean {
  const value = io.env.OPENBOARD_DEBUG;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}
