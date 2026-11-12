export * from './board.js';
export * from './checks.js';
export { main } from './cli.js';
export { type Endpoint, relayCommand, startEndpoint } from './endpoint.js';
export {
  AGENT_ID,
  BOARD,
  HUMAN,
  measureToolSurface,
  type PreparedProject,
  prepareProject,
  type RunScenarioOptions,
  runScenario,
  type ToolSurface,
} from './harness.js';
export { describeScript, HumanEngine } from './human.js';
export { idOf, idsInText, nodesInText, refsInText } from './reference.js';
export { formatJson, formatMarkdown, formatTable } from './report.js';
export * from './runners/index.js';
export { SCENARIOS, selectScenarios } from './scenarios/index.js';
export * from './score.js';
export { encodeAwarenessMessage, openSelectionPublisher } from './selection.js';
export { type Report, type ReportMeta, runSuite, type SuiteOptions, VERSION } from './suite.js';
export { emptyTrace, Recorder, resultText } from './trace.js';
export { StreamTransport } from './transport.js';
export type * from './types.js';
