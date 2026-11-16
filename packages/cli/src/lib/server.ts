/** The one place the CLI reaches into `@openboard-dev/server`. */
export {
  checkCodeLinks,
  DEFAULT_PORT,
  findProjectRoot,
  findRunningServer,
  type OpenBoardServer,
  type ProjectPaths,
  projectPaths,
  type ServerInfo,
  type ServerOptions,
  startServer,
} from '@openboard-dev/server';
