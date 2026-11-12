/** The one place the CLI reaches into `@openboard/server`. */
export {
  DEFAULT_PORT,
  findProjectRoot,
  findRunningServer,
  type OpenBoardServer,
  type ProjectPaths,
  projectPaths,
  type ServerInfo,
  type ServerOptions,
  startServer,
} from '@openboard/server';
