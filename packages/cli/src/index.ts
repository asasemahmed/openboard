export {
  type BoardRow,
  type BoardsOptions,
  boardsCommand,
  type NewBoardOptions,
  newBoardCommand,
} from './commands/boards.js';
export {
  AGENTS,
  type AgentName,
  type AgentSetup,
  agentSetups,
  type ConnectionInfo,
  type ConnectOptions,
  connectCommand,
  getConnectionInfo,
} from './commands/connect.js';
export {
  type Check,
  type CheckStatus,
  type DoctorOptions,
  doctorCommand,
  runChecks,
} from './commands/doctor.js';
export { defaultBoardId, type ExportOptions, exportCommand } from './commands/export.js';
export { type InitOptions, initCommand } from './commands/init.js';
export { type McpOptions, mcpCommand } from './commands/mcp.js';
export { type StartOptions, startCommand } from './commands/start.js';
export {
  getStatus,
  type StatusOptions,
  type StatusReport,
  statusCommand,
} from './commands/status.js';
export { type StopOptions, stopCommand } from './commands/stop.js';
export { EXPORTERS, type Exporter, exporterForFile, findExporter } from './exporters.js';
export { CliError } from './lib/errors.js';
export { type CliIo, type Output, processIo } from './lib/io.js';
export {
  ensureServer,
  type Launch,
  mcpLaunch,
  reconnectingApi,
  shellCommand,
} from './lib/mcp.js';
export { cliActor, cliBinPath, cliVersion, locateApp, resolveRoot } from './lib/project.js';
export { type BoardStore, FileStore, openSession, type Session } from './lib/store.js';
export { createProgram, run } from './program.js';
