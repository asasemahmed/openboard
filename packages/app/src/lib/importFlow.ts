/**
 * The import dialog as a reducer: the person gives text (pasted, picked or
 * dropped), the format is detected (they may override it), the server checks
 * it without changing anything (a dry run), and only then is it imported.
 * Errors keep the importer's warnings so nothing fails blankly.
 */
import type { ImportIntoResult, ImportRequest } from '@openboard/core';

export type ImportFormat = 'mermaid' | 'jsoncanvas';
export const IMPORT_FORMATS: ReadonlyArray<{ id: ImportFormat; name: string }> = [
  { id: 'mermaid', name: 'Mermaid flowchart' },
  { id: 'jsoncanvas', name: 'JSON Canvas' },
];

export interface ImportCounts {
  nodes: number;
  edges: number;
}

export type ImportStep = 'edit' | 'checking' | 'preview' | 'importing' | 'done';

export interface ImportState {
  step: ImportStep;
  text: string;
  filename: string;
  /** What the text looks like, or null when it says nothing. */
  detected: ImportFormat | null;
  /** The person's choice, overriding detection. */
  override: ImportFormat | null;
  /** Put the imported nodes inside this frame. */
  frame: string | null;
  preview: { counts: ImportCounts; warnings: string[] } | null;
  result: { counts: ImportCounts; warnings: string[]; nodeIds: string[]; proposed: boolean } | null;
  error: { message: string; warnings: string[] } | null;
}

export type ImportEvent =
  | { type: 'text'; text: string; filename?: string; detected: ImportFormat | null }
  | { type: 'format'; format: ImportFormat | null }
  | { type: 'frame'; frame: string | null }
  | { type: 'check' }
  | { type: 'checked'; result: ImportIntoResult }
  | { type: 'confirm' }
  | { type: 'imported'; result: ImportIntoResult }
  | { type: 'failed'; message: string; warnings?: string[] };

export function initialImport(
  opts: {
    text?: string;
    filename?: string;
    frame?: string | null;
    detected?: ImportFormat | null;
  } = {},
): ImportState {
  return {
    step: 'edit',
    text: opts.text ?? '',
    filename: opts.filename ?? '',
    detected: opts.detected ?? null,
    override: null,
    frame: opts.frame ?? null,
    preview: null,
    result: null,
    error: null,
  };
}

/** The format that will be used. */
export function chosenFormat(state: ImportState): ImportFormat | null {
  return state.override ?? state.detected;
}

/** Map a detected format name to one this dialog imports. */
export function importable(format: string | undefined): ImportFormat | null {
  return format === 'mermaid' || format === 'jsoncanvas' ? format : null;
}

/** What a result adds, from its applied ops (an import only adds). */
export function countsOf(result: ImportIntoResult): ImportCounts {
  const applied = result.applied;
  if (applied) return { nodes: applied.addedNodes.length, edges: applied.addedEdges.length };
  // A proposed import lists nothing as applied; its refs still name every new node.
  return { nodes: Object.keys(result.refs ?? {}).length, edges: 0 };
}

export function importReducer(state: ImportState, event: ImportEvent): ImportState {
  switch (event.type) {
    case 'text':
      return {
        ...initialImport({
          text: event.text,
          filename: event.filename ?? state.filename,
          frame: state.frame,
        }),
        detected: event.detected,
        override: state.override,
      };
    case 'format':
      return { ...state, override: event.format, step: 'edit', preview: null, error: null };
    case 'frame':
      return { ...state, frame: event.frame, step: 'edit', preview: null, error: null };
    case 'check':
      if (state.step !== 'edit' || state.text.trim() === '') return state;
      if (!chosenFormat(state))
        return {
          ...state,
          error: {
            message: 'The format could not be told from the text. Pick Mermaid or JSON Canvas.',
            warnings: [],
          },
        };
      return { ...state, step: 'checking', error: null, preview: null };
    case 'checked': {
      if (state.step !== 'checking') return state;
      const counts = countsOf(event.result);
      if (event.result.status === 'invalid')
        return {
          ...state,
          step: 'edit',
          error: {
            message: event.result.errors?.[0]?.message ?? 'The board would not accept this import.',
            warnings: event.result.warnings,
          },
        };
      if (counts.nodes === 0)
        return {
          ...state,
          step: 'edit',
          error: {
            message: 'Nothing in this text can be imported.',
            warnings: event.result.warnings,
          },
        };
      return { ...state, step: 'preview', preview: { counts, warnings: event.result.warnings } };
    }
    case 'confirm':
      return state.step === 'preview' ? { ...state, step: 'importing' } : state;
    case 'imported':
      if (state.step !== 'importing') return state;
      if (event.result.status === 'invalid')
        return {
          ...state,
          step: 'preview',
          error: {
            message: event.result.errors?.[0]?.message ?? 'The import was refused.',
            warnings: event.result.warnings,
          },
        };
      return {
        ...state,
        step: 'done',
        error: null,
        result: {
          counts: countsOf(event.result),
          warnings: event.result.warnings,
          nodeIds: [
            ...(event.result.applied?.addedNodes ?? []),
            ...(event.result.applied ? [] : Object.values(event.result.refs ?? {})),
          ],
          proposed: event.result.status === 'proposed',
        },
      };
    case 'failed':
      if (state.step !== 'checking' && state.step !== 'importing') return state;
      return {
        ...state,
        step: state.step === 'checking' ? 'edit' : 'preview',
        error: { message: event.message, warnings: event.warnings ?? [] },
      };
  }
}

/** The request for a dry run or the real import. */
export function importRequest(state: ImportState, dryRun: boolean): ImportRequest {
  const format = chosenFormat(state);
  const request: ImportRequest = { text: state.text, dryRun };
  if (format) request.format = format;
  if (state.filename) request.filename = state.filename.slice(0, 255);
  if (state.frame) request.frame = state.frame;
  return request;
}

/** Warnings an error from the server carried in `details`, if any. */
export function warningsOf(details: unknown): string[] {
  if (Array.isArray(details)) return details.filter((d): d is string => typeof d === 'string');
  if (typeof details === 'object' && details !== null) {
    const w = (details as { warnings?: unknown }).warnings;
    if (Array.isArray(w)) return w.filter((d): d is string => typeof d === 'string');
  }
  return [];
}

/** Files the canvas takes for import when dropped on it. */
export function droppableImport(name: string): boolean {
  return /\.(mmd|mermaid|canvas)$/i.test(name);
}
