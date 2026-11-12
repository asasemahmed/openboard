import { type CliIo, println } from '../lib/io.js';

export interface McpOptions {
  root?: string;
}

/** Serve the project's boards to an MCP client over stdio. */
export async function mcpCommand(io: CliIo, _options: McpOptions = {}): Promise<number> {
  println(io.stderr, 'The MCP server is not available in this build yet.');
  return 1;
}
