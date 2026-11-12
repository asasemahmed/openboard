/**
 * Templates: reusable starting structures (frames, nodes with short example
 * text, and edges) that are applied to a board as one ordinary batch.
 *
 * A template is pure data behind `build`, which returns operations that use
 * `ref`s, so the same template applies to an empty board, to a busy one, or
 * inside a frame. Built-in templates carry no positions: the layout engine
 * places them like any other batch.
 */
import { z } from 'zod';
import { DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS } from '../api.js';
import type { Op } from '../ops.js';
import { IdSchema, LIMITS } from '../schema.js';
import { estimateTokens } from '../text.js';

export interface TemplateBuildOptions {
  /** Title of the template's outer frame; each template has its own default. */
  title?: string;
}

export interface TemplateDef {
  /** Stable id, such as `feature-plan`: lowercase letters, digits and dashes. */
  id: string;
  name: string;
  /** When to use it. Read by people choosing a template and by agents. */
  description: string;
  tags: string[];
  /** The batch that creates the structure. Must return the same operations for the same options. */
  build(options?: TemplateBuildOptions): Op[];
}

export const TemplateIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, 'a template id is lowercase letters, digits and dashes');

export type TemplateSource = 'builtin' | 'project' | 'plugin';

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: TemplateSource;
  /** The plugin that provides it, for `source: 'plugin'`. */
  plugin?: string;
  nodeCount: number;
  edgeCount: number;
}

export interface TemplatesResult {
  templates: TemplateSummary[];
  text: string;
  tokens: number;
}

export const ApplyTemplateRequestSchema = z.object({
  /** A template id from `templates()`. */
  template: z.string().min(1).max(64),
  /** Put the template's top-level nodes inside this frame. */
  frame: IdSchema.optional(),
  /** Title of the template's outer frame (built-in templates) instead of its default. */
  title: z.string().trim().min(1).max(LIMITS.title).optional(),
  /** Validate and report, but change nothing. */
  dryRun: z.boolean().optional(),
});
export type ApplyTemplateRequest = z.infer<typeof ApplyTemplateRequestSchema>;

/** How many nodes and edges a batch adds. */
export function countAdded(ops: readonly Op[]): { nodeCount: number; edgeCount: number } {
  let nodeCount = 0;
  let edgeCount = 0;
  for (const op of ops) {
    if (op.op === 'add_node') nodeCount++;
    else if (op.op === 'add_edge') edgeCount++;
  }
  return { nodeCount, edgeCount };
}

const SOURCE_TEXT: Record<TemplateSource, string> = {
  builtin: 'built-in',
  project: 'project',
  plugin: 'plugin',
};

/** The template list as compact text, within `maxTokens`. */
export function renderTemplates(
  templates: readonly TemplateSummary[],
  opts: { maxTokens?: number } = {},
): TemplatesResult {
  const budget = Math.min(Math.max(1, opts.maxTokens ?? DEFAULT_MAX_TOKENS), MAX_MAX_TOKENS);
  const line = (t: TemplateSummary) => {
    const from = t.source === 'plugin' ? `plugin ${t.plugin}` : SOURCE_TEXT[t.source];
    const tags = t.tags.length ? `; tags ${t.tags.join(', ')}` : '';
    const what = t.description.replace(/\s+/g, ' ').trim();
    return `${t.id} ${JSON.stringify(t.name)} (${from}; ${t.nodeCount} nodes, ${t.edgeCount} edges${tags}): ${what}`;
  };
  const render = (count: number) => {
    const lines = [
      templates.length === 0
        ? 'No templates.'
        : `${templates.length} template${templates.length === 1 ? '' : 's'}. Apply one with applyTemplate (template: <id>, optionally frame: <frame id>); it lands as one batch, like apply.`,
      ...templates.slice(0, count).map(line),
    ];
    if (count < templates.length) {
      lines.push(
        `[Truncated: ${templates.length - count} more templates not shown (${templates
          .slice(count)
          .map((t) => t.id)
          .join(', ')}).]`,
      );
    }
    return lines.join('\n');
  };
  let count = templates.length;
  let text = render(count);
  while (estimateTokens(text) > budget && count > 0) text = render(--count);
  return { templates: [...templates], text, tokens: estimateTokens(text) };
}
