/**
 * The `openboard` command line: argument parsing only. Each command's work
 * lives in `commands/`, so it can be called and tested without a process.
 */
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { boardsCommand, newBoardCommand } from './commands/boards.js';
import { linksCommand, revisionsCommand } from './commands/code.js';
import { AGENTS, connectCommand } from './commands/connect.js';
import { diffCommand } from './commands/diff.js';
import { doctorCommand } from './commands/doctor.js';
import { exportCommand } from './commands/export.js';
import {
  gitRemoveCommand,
  gitSetupCommand,
  gitStatusCommand,
  mergeDriverCommand,
  textconvCommand,
} from './commands/git.js';
import { importCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import { activityCommand, snapshotCommand } from './commands/live.js';
import { mcpCommand } from './commands/mcp.js';
import { policyCommand, policySetCommand, policyUnsetCommand } from './commands/policy.js';
import { decideCommand, historyCommand, proposalsCommand, undoCommand } from './commands/review.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { FORMAT_NAMES } from './exporters.js';
import { runHook } from './hook.js';
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
  $ openboard proposals                what agents are waiting to have reviewed
  $ openboard policy set review_all    hold every agent change for review
  $ openboard activity                 what agents are doing right now
  $ openboard import flow.mmd          add a Mermaid flowchart to the main board
  $ openboard diff --format markdown   what changed on the boards since HEAD
  $ openboard git setup --diff         merge and diff board files by meaning in git
`;

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new InvalidArgumentError('must be a whole number from 1 to 200');
  }
  return limit;
}

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
    .description('write a board as JSON, Markdown, Mermaid, JSON Canvas, SVG or text')
    .argument('[board]', 'board id (default: the only board, or "main")')
    .addOption(rootOption())
    .addOption(
      new Option('-f, --format <format>', 'output format (default: from --out, else json)').choices(
        FORMAT_NAMES,
      ),
    )
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .addOption(
      new Option('--theme <theme>', 'svg colours (default: light)').choices(['light', 'dark']),
    )
    .action(
      action(
        (
          board: string | undefined,
          opts: { root?: string; format?: string; out?: string; theme?: 'light' | 'dark' },
        ) => exportCommand(io, board, opts),
      ),
    );

  program
    .command('import')
    .description('add a Mermaid flowchart or a JSON Canvas to a board')
    .argument('<file>', 'the file to import, or - for standard input')
    .argument('[board]', 'board id (default: the only board, or "main")')
    .addOption(rootOption())
    .addOption(
      new Option('--format <format>', 'input format (default: recognized from the file)').choices([
        'mermaid',
        'canvas',
      ]),
    )
    .option('--frame <id>', 'put everything that has no frame of its own into this frame')
    .option('--new <name>', 'create a board with this name and import into it')
    .option('--dry-run', 'check the import and say what it would add; change nothing')
    .action(
      action(
        (
          file: string,
          board: string | undefined,
          opts: { root?: string; format?: string; frame?: string; new?: string; dryRun?: boolean },
        ) => importCommand(io, file, board, opts),
      ),
    );

  program
    .command('diff')
    .description(
      'what changed on a board between two git revisions; exits 0 when equal, 1 when different, 2 on error',
    )
    .argument('[board]', 'board id (default: every board)')
    .addOption(rootOption())
    .option('--from <rev>', 'revision to compare from (default: HEAD)')
    .option('--to <rev>', 'revision to compare to (default: the working tree)')
    .addOption(
      new Option('-f, --format <format>', 'output format (default: text)').choices([
        'text',
        'markdown',
        'svg',
        'json',
      ]),
    )
    .addOption(
      new Option('--theme <theme>', 'svg colours (default: light)').choices(['light', 'dark']),
    )
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .action(
      action(
        (
          board: string | undefined,
          opts: {
            root?: string;
            from?: string;
            to?: string;
            format?: 'text' | 'markdown' | 'svg' | 'json';
            theme?: 'light' | 'dark';
            out?: string;
          },
        ) => diffCommand(io, board, opts),
      ),
    );

  const gitCommand = program
    .command('git')
    .description('set up git to merge and diff board files by meaning')
    .enablePositionalOptions();
  gitCommand
    .command('setup')
    .description(
      'add the merge driver to .gitattributes and the git configuration (safe to run again)',
    )
    .addOption(rootOption())
    .option('--global', 'write the git settings to your global configuration')
    .option('--diff', 'also make git diff and git log -p show board files as readable text')
    .action(
      action((opts: { root?: string; global?: boolean; diff?: boolean }) =>
        gitSetupCommand(io, opts),
      ),
    );
  gitCommand
    .command('status')
    .description('show whether the merge driver and readable diffs are set up')
    .addOption(rootOption())
    .option('--json', 'print JSON')
    .action(action((opts: { root?: string; json?: boolean }) => gitStatusCommand(io, opts)));
  gitCommand
    .command('remove')
    .description('undo exactly what setup added')
    .addOption(rootOption())
    .option('--global', 'remove the git settings from your global configuration')
    .action(action((opts: { root?: string; global?: boolean }) => gitRemoveCommand(io, opts)));

  program
    .command('merge-driver')
    .description(
      'merge three versions of a board file (git calls this; see openboard git setup). The result is always a valid board: conflicts are resolved, reported on stderr and in .openboard/.local/last-merge.txt, and the exit code is 0 unless --strict',
    )
    .argument('<base>', 'the common ancestor (%O); missing or empty when there is none')
    .argument('<ours>', 'our version (%A); the merged board is written here')
    .argument('<theirs>', 'their version (%B)')
    .argument('[path]', 'the path of the board in the repository (%P)')
    .option('--strict', 'exit 1 when a conflict was resolved, so git stops and marks the file')
    .addOption(
      new Option('--prefer <side>', 'which side wins a conflict (default: ours)').choices([
        'ours',
        'theirs',
      ]),
    )
    .action(
      action(
        (
          base: string,
          ours: string,
          theirs: string,
          file: string | undefined,
          opts: { strict?: boolean; prefer?: 'ours' | 'theirs' },
        ) => mergeDriverCommand(io, base, ours, theirs, file, opts),
      ),
    );

  program
    .command('textconv')
    .description(
      'print a board file as readable text, for git diff (see openboard git setup --diff)',
    )
    .argument('<file>', 'a board file')
    .action(action((file: string) => textconvCommand(io, file)));

  program
    .command('links')
    .description(
      "list the board's code links whose code changed or is gone, or refresh nodes checked against the code (needs the running server)",
    )
    .usage('[board] [--all] | refresh <nodeId...> [board] | refresh --all [board]')
    .argument(
      '[args...]',
      '[board], or refresh and the node ids (a last argument naming a board is the board)',
    )
    .addOption(rootOption())
    .option('--all', 'list every link; with refresh, refresh every node')
    .option('--json', 'print JSON')
    .action(
      action((args: string[], opts: { root?: string; all?: boolean; json?: boolean }) =>
        linksCommand(io, args, opts),
      ),
    );

  program
    .command('revisions')
    .description('the git history of a board file, newest first')
    .argument('[board]', 'board id (default: the only board, or "main")')
    .addOption(rootOption())
    .option('--limit <n>', 'how many revisions, 1 to 200 (default: 20)', parseLimit)
    .option('--json', 'print JSON')
    .action(
      action((board: string | undefined, opts: { root?: string; limit?: number; json?: boolean }) =>
        revisionsCommand(io, board, opts),
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

  const policy = program
    .command('policy')
    .description("show or change the project's review policy for agents")
    // `--root` after `set` or `unset` belongs to them; before, to `policy`.
    .enablePositionalOptions()
    .addOption(rootOption())
    .option('--json', 'print JSON')
    .action(action((opts: { root?: string; json?: boolean }) => policyCommand(io, opts)));
  policy
    .command('set')
    .description("set the default mode, or one agent's mode with --agent")
    .argument('<mode>', 'auto, review_destructive, review_all or locked')
    .addOption(rootOption())
    .option('--agent <id>', 'set the mode of this agent only')
    .action(
      action((mode: string, opts: { root?: string; agent?: string }) =>
        policySetCommand(io, mode, { ...opts, root: opts.root ?? policy.opts().root }),
      ),
    );
  policy
    .command('unset')
    .description("remove an agent's own mode, so it uses the default again")
    .addOption(rootOption())
    .requiredOption('--agent <id>', 'the agent')
    .action(
      action((opts: { root?: string; agent?: string }) =>
        policyUnsetCommand(io, { ...opts, root: opts.root ?? policy.opts().root }),
      ),
    );

  program
    .command('proposals')
    .description('list agent changes waiting for review (needs the running server)')
    .argument('[board]', 'board id (default: the only board, or "main")')
    .addOption(rootOption())
    .option('--all', 'also list decided and withdrawn proposals')
    .option('--json', 'print JSON')
    .action(
      action((board: string | undefined, opts: { root?: string; all?: boolean; json?: boolean }) =>
        proposalsCommand(io, board, opts),
      ),
    );

  for (const verb of ['accept', 'reject'] as const) {
    program
      .command(verb)
      .description(`${verb} a proposal, in whole or in part (needs the running server)`)
      .argument('<proposalId>', 'the proposal, as `openboard proposals` lists it')
      .argument('[board]', 'board id (default: the only board, or "main")')
      .addOption(rootOption())
      .option('--items <list>', `item numbers to ${verb}, like 0,2 (default: every pending item)`)
      .option('--note <text>', 'a note for the agent; it reaches the agent in its inbox')
      .option('--json', 'print the proposal as JSON')
      .action(
        action(
          (
            proposalId: string,
            board: string | undefined,
            opts: { root?: string; items?: string; note?: string; json?: boolean },
          ) => decideCommand(io, verb, proposalId, board, opts),
        ),
      );
  }

  program
    .command('history')
    .description('list recent batches of changes, newest first (needs the running server)')
    .argument('[board]', 'board id (default: the only board, or "main")')
    .addOption(rootOption())
    .option('--limit <n>', 'how many batches, 1 to 200 (default: 20)', parseLimit)
    .option('--actor <id>', 'only batches by this actor')
    .option('--json', 'print JSON')
    .action(
      action(
        (
          board: string | undefined,
          opts: { root?: string; limit?: number; actor?: string; json?: boolean },
        ) => historyCommand(io, board, opts),
      ),
    );

  program
    .command('undo')
    .description(
      "undo a batch, or an actor's last (or every) batch; never overwrites later changes (needs the running server)",
    )
    .usage('<batchId> [board] | --actor <id> [--all] [board]')
    .argument('[args...]', '<batchId> [board], or with --actor just [board]')
    .addOption(rootOption())
    .option('--actor <id>', "undo this actor's most recent batch")
    .option('--all', 'with --actor: undo all of its batches that are still in place')
    .option('--json', 'print JSON')
    .action(
      action(
        (args: string[], opts: { root?: string; actor?: string; all?: boolean; json?: boolean }) =>
          undoCommand(io, args, opts),
      ),
    );

  program
    .command('hook')
    .description(
      "report an agent's hook event (JSON on stdin) to the running server; silent, always exits 0",
    )
    .addOption(
      new Option(
        '--format <format>',
        'event format (default: recognized from the JSON; generic is an ActivityEvent)',
      ).choices(['claude-code', 'cursor', 'generic']),
    )
    .action(
      action(async (opts: { format?: string }) => {
        // Normally handled in bin.ts before this parser loads; kept here for --help and tests.
        const args = opts.format ? ['--format', opts.format] : [];
        await runHook(args, { stdin: process.stdin, env: io.env, cwd: io.cwd });
        return 0;
      }),
    );

  program
    .command('activity')
    .description('show what agents are doing: the session tree (needs the running server)')
    .addOption(rootOption())
    .option('--all', 'also list sessions that have ended')
    .option('--json', 'print JSON')
    .action(
      action((opts: { root?: string; all?: boolean; json?: boolean }) => activityCommand(io, opts)),
    );

  program
    .command('snapshot')
    .description('write a board as it was at an earlier cursor (needs the running server)')
    .argument('<cursor>', 'the cursor, as history and changes show it')
    .argument('[board]', 'board id (default: the only board, or "main")')
    .addOption(rootOption())
    .addOption(
      new Option('-f, --format <format>', 'output format (default: from --out, else json)').choices(
        FORMAT_NAMES,
      ),
    )
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .action(
      action(
        (
          cursor: string,
          board: string | undefined,
          opts: { root?: string; format?: string; out?: string },
        ) => snapshotCommand(io, cursor, board, opts),
      ),
    );

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
