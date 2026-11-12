/**
 * The `scripted` runner plays a scenario's reference solution: the ideal
 * sequence of tool calls, through the same recording endpoint an agent uses.
 * It proves the scenario is solvable, calibrates the checks (the reference
 * must score 1.0), and gives the board-token cost of a perfect run.
 */
import type { AgentRunner, RunInput, RunOutput } from '../types.js';

export function scriptedRunner(): AgentRunner {
  return {
    name: 'scripted',
    async available() {
      return { ok: true };
    },
    async run(input: RunInput): Promise<RunOutput> {
      const ctx = await input.connect();
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(new Error('the reference run was aborted'));
        if (input.signal.aborted) fail();
        else input.signal.addEventListener('abort', fail, { once: true });
      });
      aborted.catch(() => {});
      try {
        const finalText = await Promise.race([input.scenario.reference(ctx), aborted]);
        return { ok: true, finalText, turns: 1 };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        await ctx.client.close().catch(() => {});
      }
    },
  };
}
