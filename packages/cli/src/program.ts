/**
 * The `openboard` command line: argument parsing only. Each command's work
 * lives in `commands/`, so it can be called and tested without a process.
 */
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { boardsCommand, newBoardCommand } from './commands/boards.js';
import { AGENTS, connectCommand } from './commands/connect.js';
import { doctorCommand } from './commands/doctor.js';
import { exportCommand } from './commands/export.js';
import { initCommand } from './commands/init.js';
import { mcpCommand } from './commands/mcp.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { EXPORTERS } from './exporters.js';
import { CliError, reportError } from './lib/errors.js';
import type { CliIo } from './lib/io.js';
import { cliVersion } from './lib/project.js';

const EXAMPLES = `
Examples:
  $ openboard                          start the server and open the board
  $ openboard connect claude-code      show how to add the boards to Claude Code
  $ openboard mcp                      serve the boards to an agent over stdio
  $ openboard export --format outline  print the shape of the main board
  $ openboard status --json            machine-readable status for scripts
`;

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError('must be a whole number from 0 to 65535');
  }
  return port;
}

const rootOption = () =>
  new Option('--root <dir>', 'project root (default: discovered from the current directory)');

export function createProgram(io: CliIo, setExitCode: (code: number) => void): Command {
  const program = new Command('openboard');

  /** Run a command, turning a thrown error into one line on stderr and an exit code. */
  const action =
    <A extends unknown[]>(fn: (...args: A) => Promise<number>) =>
    async (...args: A) => {
      try {
        setExitCode(await fn(...args));
      } catch (error) {
        setExitCode(reportError(io, error));
      }
    };

  program
    .description('The open canvas for AI agents. Run it in a project to start a board server.')
    .version(cliVersion(), '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .helpCommand(false)
    .addHelpText('after', EXAMPLES)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
      outputError: (text, write) => write(`openboard: ${text.replace(/^error: /, '')}`),
    });

  program
    .command('start', { isDefault: true })
    .description('start the server in the foreground and open the board (the default)')
    .addOption(rootOption())
    .option(
      '-p, --port <n>',
      'preferred port (the next free one is used if it is taken)',
      parsePort,
    )
    .option('--host <host>', 'interface to bind (default: loopback)')
    .option('--board <id>', 'board to open in the browser')
    .option('--no-open', 'do not open a browser')
    .action(
      action(
        (opts: { root?: string; port?: number; host?: string; board?: string; open: boolean }) =>
          startCommand(io, opts),
      ),
    );

  program
    .command('init')
    .description('create .openboard/ with an empty board in the current directory')
    .addOption(
      new Option('--root <dir>', 'directory to initialize').default(
        undefined,
        'the current directory',
      ),
    )
    .action(action((opts: { root?: string }) => initCommand(io, opts)));

  program
    .command('status')
    .description('show whether the server is running, and the boards')
    .addOption(rootOption())
    .option('--json', 'print JSON')
    .action(action((opts: { root?: string; json?: boolean }) => statusCommand(io, opts)));

  program
    .command('stop')
    .description('stop the server running for this project')
    .addOption(rootOption())
    .action(action((opts: { root?: string }) => stopCommand(io, opts)));

  program
    .command('boards')
    .description('list boards')
    .addOption(rootOption())
    .option('--json', 'print JSON')
    .action(action((opts: { root?: string; json?: boolean }) => boardsCommand(io, opts)));

  program
    .command('new')
    .description('create a board')
    .argument('<name>', 'board name')
    .addOption(rootOption())
    .option('--id <id>', 'board id (default: derived from the name)')
    .option('--description <text>', 'board description')
    .option('--json', 'print the new board as JSON')
    .action(
      action(
        (
          name: string,
          opts: { root?: string; id?: string; description?: string; json?: boolean },
        ) => newBoardCommand(io, name, opts),
      ),
    );

  program
    .command('export')
    .description('write a board as JSON or text')
    .argument('[board]', 'board id (default: the only board, or "main")')
    .addOption(rootOption())
    .addOption(
      new Option('-f, --format <format>', 'output format (default: from --out, else json)').choices(
        EXPORTERS.map((exporter) => exporter.name),
      ),
    )
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .action(
      action((board: string | undefined, opts: { root?: string; format?: string; out?: string }) =>
        exportCommand(io, board, opts),
      ),
    );

  program
    .command('doctor')
    .description('check the installation and the project')
    .addOption(rootOption())
    .option('--json', 'print JSON')
    .action(action((opts: { root?: string; json?: boolean }) => doctorCommand(io, opts)));

  program
    .command('mcp')
    .description('serve the boards to an MCP client over stdio (starts the server if needed)')
    .addOption(rootOption())
    .option('--board <id>', 'board used when a tool call names none')
    .action(action((opts: { root?: string; board?: string }) => mcpCommand(io, opts)));

  program
    .command('connect')
    .description('show how to connect an agent to this project (writes nothing)')
    .argument('[agent]', `one of: ${AGENTS.join(', ')} (default: all, briefly)`)
    .addOption(rootOption())
    .option('--json', 'print JSON')
    .action(
      action((agent: string | undefined, opts: { root?: string; json?: boolean }) =>
        connectCommand(io, agent, opts),
      ),
    );

  return program;
}

/** Parse `argv` (without the node and script entries), run the command, and return its exit code. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let exitCode = 0;
  const program = createProgram(io, (code) => {
    exitCode = code;
  });
  // `start` is the default command, so commander would read an unknown command
  // as an excess argument to `start`. Name the real problem instead.
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    const known = program.commands.some((c) => c.name() === first || c.aliases().includes(first));
    if (!known) {
      return reportError(io, new CliError(`unknown command "${first}" (see openboard --help)`));
    }
  }
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    return reportError(io, error);
  }
  return exitCode;
}
