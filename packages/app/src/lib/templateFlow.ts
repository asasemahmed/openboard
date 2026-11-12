/**
 * Inserting a template, as a reducer: pick one from the list, optionally name
 * it and choose a frame, check what it adds (the server's dry run), then
 * apply. A result that waits for review or fails keeps its message.
 */
import type { ApplyResult, TemplateSummary, TypeIcon } from '@openboard/core';

export type TemplateStep = 'loading' | 'choose' | 'checking' | 'preview' | 'applying' | 'done';

export interface TemplateState {
  step: TemplateStep;
  templates: TemplateSummary[];
  chosen: string | null;
  title: string;
  frame: string | null;
  /** What the dry run says it adds; `review` when it will wait for someone to accept it. */
  preview: { nodes: number; edges: number; review: string | null } | null;
  result: { nodeIds: string[]; proposed: boolean } | null;
  error: string | null;
}

export type TemplateEvent =
  | { type: 'loaded'; templates: TemplateSummary[] }
  | { type: 'choose'; id: string }
  | { type: 'title'; title: string }
  | { type: 'frame'; frame: string | null }
  | { type: 'check' }
  | { type: 'checked'; result: ApplyResult }
  | { type: 'apply' }
  | { type: 'applied'; result: ApplyResult }
  | { type: 'failed'; message: string };

export function initialTemplate(frame: string | null = null): TemplateState {
  return {
    step: 'loading',
    templates: [],
    chosen: null,
    title: '',
    frame,
    preview: null,
    result: null,
    error: null,
  };
}

function counts(state: TemplateState, result: ApplyResult): NonNullable<TemplateState['preview']> {
  const a = result.applied;
  const summary = state.templates.find((t) => t.id === state.chosen);
  return {
    nodes: a ? a.addedNodes.length : (summary?.nodeCount ?? 0),
    edges: a ? a.addedEdges.length : (summary?.edgeCount ?? 0),
    review: result.review?.why ?? null,
  };
}

const back = (s: TemplateState): TemplateState => ({
  ...s,
  step: 'choose',
  preview: null,
  error: null,
});

export function templateReducer(state: TemplateState, event: TemplateEvent): TemplateState {
  switch (event.type) {
    case 'loaded':
      return { ...state, step: 'choose', templates: event.templates };
    case 'choose':
      return { ...back(state), chosen: event.id };
    case 'title':
      return { ...back(state), title: event.title };
    case 'frame':
      return { ...back(state), frame: event.frame };
    case 'check':
      return state.step === 'choose' && state.chosen
        ? { ...state, step: 'checking', error: null }
        : state;
    case 'checked':
      if (state.step !== 'checking') return state;
      if (event.result.status === 'invalid')
        return {
          ...state,
          step: 'choose',
          error: event.result.errors?.[0]?.message ?? 'The template does not fit this board.',
        };
      return { ...state, step: 'preview', preview: counts(state, event.result) };
    case 'apply':
      return state.step === 'preview' ? { ...state, step: 'applying' } : state;
    case 'applied':
      if (state.step !== 'applying') return state;
      if (event.result.status === 'invalid')
        return {
          ...state,
          step: 'preview',
          error: event.result.errors?.[0]?.message ?? 'The template was refused.',
        };
      return {
        ...state,
        step: 'done',
        result: {
          nodeIds: event.result.applied?.addedNodes ?? Object.values(event.result.refs ?? {}),
          proposed: event.result.status === 'proposed',
        },
      };
    case 'failed':
      if (state.step === 'loading') return { ...state, step: 'choose', error: event.message };
      if (state.step === 'checking') return { ...state, step: 'choose', error: event.message };
      if (state.step === 'applying') return { ...state, step: 'preview', error: event.message };
      return state;
  }
}

/** The request for the chosen template. */
export function templateRequest(state: TemplateState, dryRun: boolean) {
  const request: { template: string; dryRun: boolean; title?: string; frame?: string } = {
    template: state.chosen ?? '',
    dryRun,
  };
  if (state.title.trim()) request.title = state.title.trim().slice(0, 200);
  if (state.frame) request.frame = state.frame;
  return request;
}

/** The templates a fresh board offers as one-click starts, most useful first. */
export const STARTER_TEMPLATES = ['feature-plan', 'kanban', 'architecture-map'] as const;

export function starters(templates: readonly TemplateSummary[]): TemplateSummary[] {
  const out: TemplateSummary[] = [];
  for (const id of STARTER_TEMPLATES) {
    const t = templates.find((x) => x.id === id);
    if (t) out.push(t);
  }
  for (const t of templates) if (out.length < 3 && !out.includes(t)) out.push(t);
  return out.slice(0, 3);
}

const TEMPLATE_ICONS: Record<string, TypeIcon> = {
  'architecture-map': 'server',
  'feature-plan': 'flag',
  'release-plan': 'calendar',
  'incident-review': 'alert',
  'decision-record': 'check',
  'research-map': 'beaker',
  kanban: 'chart',
  'agent-team': 'bot',
};

/** An icon for a template card: the built-in ones have their own, others a file. */
export function templateIcon(id: string): TypeIcon {
  return TEMPLATE_ICONS[id] ?? 'file';
}

/** "12 nodes, 9 connections". */
export function templateCounts(t: Pick<TemplateSummary, 'nodeCount' | 'edgeCount'>): string {
  const n = `${t.nodeCount} node${t.nodeCount === 1 ? '' : 's'}`;
  return t.edgeCount > 0 ? `${n}, ${t.edgeCount} connection${t.edgeCount === 1 ? '' : 's'}` : n;
}
