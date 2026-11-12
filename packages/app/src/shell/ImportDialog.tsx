/**
 * Import a Mermaid flowchart or a JSON Canvas into this board: paste it, pick
 * a file or drop one, check what it would add (the server reads it without
 * changing anything), then import. Everything lands through the normal
 * validated apply path, attributed to this person.
 */
import { detectFormat } from '@openboard/core';
import { useReactFlow } from '@xyflow/react';
import { type DragEvent, useEffect, useId, useReducer, useRef } from 'react';
import { reducedMotion } from '../canvas/actions.js';
import { ApiError, calmMessage } from '../lib/api.js';
import {
  chosenFormat,
  IMPORT_FORMATS,
  type ImportFormat,
  type ImportState,
  importable,
  importReducer,
  importRequest,
  initialImport,
  warningsOf,
} from '../lib/importFlow.js';
import { useSession } from '../state/context.js';
import { useStoreValue, useValue } from '../state/emitter.js';
import type { BoardSession } from '../state/session.js';
import { toasts } from '../state/toasts.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';

const MAX_BYTES = 1_500_000;

function detect(filename: string, text: string): ImportFormat | null {
  return importable(detectFormat(filename, text));
}

/** The frame to import into by default: the one selected frame, if exactly one is. */
function selectedFrame(session: BoardSession): string | null {
  const ids = session.store.selection.nodeIds;
  if (ids.length !== 1) return null;
  const node = session.store.node(ids[0] as string);
  return node?.type === 'frame' ? node.id : null;
}

export function ImportDialog() {
  const session = useSession();
  const request = useValue(session.ui.importDialog);
  if (!request) return null;
  return (
    <ImportForm key={`${request.filename ?? ''}:${request.text?.length ?? 0}`} initial={request} />
  );
}

function ImportForm({ initial }: { initial: { text?: string; filename?: string } }) {
  const session = useSession();
  const { ui, store } = session;
  const flow = useReactFlow();
  const [state, dispatch] = useReducer(
    importReducer,
    undefined,
    (): ImportState =>
      initialImport({
        text: initial.text ?? '',
        filename: initial.filename ?? '',
        frame: selectedFrame(session),
        detected: initial.text ? detect(initial.filename ?? '', initial.text) : null,
      }),
  );
  const frames = useStoreValue(store, () =>
    store.nodes
      .filter((n) => n.type === 'frame' && !n.data.ghost)
      .map((n) => `${n.id}\u0000${n.data.node.title}`)
      .join('\n'),
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = { text: useId(), format: useId(), frame: useId() };
  const close = () => ui.importDialog.set(null);

  const setText = (text: string, filename = state.filename) =>
    dispatch({ type: 'text', text, filename, detected: detect(filename, text) });

  const readFile = async (file: File) => {
    if (file.size > MAX_BYTES) {
      dispatch({ type: 'text', text: '', filename: file.name, detected: null });
      toasts.show('That file is too large to import (1.5 MB at most).', { tone: 'error' });
      return;
    }
    setText(await file.text(), file.name);
  };

  // Ask the server what the import would do, and then do it.
  useEffect(() => {
    if (state.step !== 'checking' && state.step !== 'importing') return;
    let alive = true;
    const dryRun = state.step === 'checking';
    session.api
      .importInto(session.boardId, importRequest(state, dryRun))
      .then((result) => {
        if (!alive) return;
        dispatch(dryRun ? { type: 'checked', result } : { type: 'imported', result });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        const warnings = error instanceof ApiError ? warningsOf(error.details) : [];
        dispatch({ type: 'failed', message: calmMessage(error), warnings });
      });
    return () => {
      alive = false;
    };
    // The request is built from the state at the moment the step changed.
  }, [state.step]);

  // Point at what arrived: it is this person's own change, so nothing else highlights it.
  useEffect(() => {
    if (state.step !== 'done' || !state.result) return;
    const nodeIds = state.result.nodeIds;
    const timer = setTimeout(() => {
      const present = nodeIds.filter((id) => store.node(id));
      session.activity.flash(
        present.map((id) => ({ kind: 'node' as const, id, verb: 'added' as const })),
        session.actor().id,
        { replace: false },
      );
      if (present.length > 0)
        void flow.fitView({
          nodes: present.map((id) => ({ id })),
          duration: reducedMotion() ? 0 : 320,
          padding: 0.25,
          maxZoom: 1,
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [state.step, state.result, store, session, flow]);

  const onDrop = (event: DragEvent) => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    event.preventDefault();
    void readFile(file);
  };

  const format = chosenFormat(state);
  const busy = state.step === 'checking' || state.step === 'importing';

  return (
    <Dialog open onClose={close} title="Import into this board" size="md">
      {state.step === 'done' && state.result ? (
        <div className="import-done" role="status">
          <p>
            {state.result.proposed
              ? `Sent for review: ${state.result.counts.nodes} nodes wait for someone to accept them.`
              : `Imported ${state.result.counts.nodes} node${state.result.counts.nodes === 1 ? '' : 's'} and ${state.result.counts.edges} connection${state.result.counts.edges === 1 ? '' : 's'}.`}
          </p>
          <Warnings warnings={state.result.warnings} />
          <div className="dialog-actions">
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="import-form" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <p className="dialog-description">
            Paste a Mermaid flowchart or a JSON Canvas, or pick a file. Subgraphs and groups become
            frames.
          </p>
          <div className="field">
            <div className="import-label-row">
              <label htmlFor={ids.text} className="field-label">
                Text
              </label>
              <Button
                size="sm"
                variant="ghost"
                icon="file"
                onClick={() => fileRef.current?.click()}
              >
                Choose a file…
              </Button>
              <input
                ref={fileRef}
                type="file"
                className="visually-hidden"
                tabIndex={-1}
                accept=".mmd,.mermaid,.canvas,.json,.txt,.md"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                  event.target.value = '';
                }}
              />
            </div>
            <textarea
              id={ids.text}
              className="input import-text"
              rows={9}
              spellCheck={false}
              value={state.text}
              placeholder={'flowchart TD\n  A[Plan] --> B[Build]'}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
            />
            {state.filename && <p className="field-hint">From {state.filename}</p>}
          </div>
          <div className="import-options">
            <div className="field">
              <label htmlFor={ids.format} className="field-label">
                Format
              </label>
              <select
                id={ids.format}
                className="input input-sm"
                value={state.override ?? ''}
                disabled={busy}
                onChange={(event) =>
                  dispatch({
                    type: 'format',
                    format: (event.target.value || null) as ImportFormat | null,
                  })
                }
              >
                <option value="">
                  {state.detected
                    ? `Detected: ${IMPORT_FORMATS.find((f) => f.id === state.detected)?.name}`
                    : 'Detect from the text'}
                </option>
                {IMPORT_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={ids.frame} className="field-label">
                Put it in
              </label>
              <select
                id={ids.frame}
                className="input input-sm"
                value={state.frame ?? ''}
                disabled={busy}
                onChange={(event) => dispatch({ type: 'frame', frame: event.target.value || null })}
              >
                <option value="">The board itself</option>
                {frames
                  .split('\n')
                  .filter(Boolean)
                  .map((entry) => {
                    const [id = '', title = ''] = entry.split('\u0000');
                    return (
                      <option key={id} value={id}>
                        Frame “{title}”
                      </option>
                    );
                  })}
              </select>
            </div>
          </div>
          {state.preview && (
            <div className="import-preview" role="status">
              <p>
                This adds <strong>{state.preview.counts.nodes}</strong> node
                {state.preview.counts.nodes === 1 ? '' : 's'} and{' '}
                <strong>{state.preview.counts.edges}</strong> connection
                {state.preview.counts.edges === 1 ? '' : 's'}
                {state.frame ? ' inside the frame' : ''}. Nothing has changed yet.
              </p>
              <Warnings warnings={state.preview.warnings} />
            </div>
          )}
          {state.error && (
            <div className="import-error" role="alert">
              <p>{state.error.message}</p>
              <Warnings warnings={state.error.warnings} />
            </div>
          )}
          <div className="dialog-actions">
            <Button onClick={close}>Cancel</Button>
            {state.step === 'preview' || state.step === 'importing' ? (
              <Button
                variant="primary"
                disabled={state.step === 'importing'}
                onClick={() => dispatch({ type: 'confirm' })}
              >
                {state.step === 'importing' ? 'Importing…' : 'Import'}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={busy || state.text.trim() === '' || (!format && state.text.length === 0)}
                onClick={() => dispatch({ type: 'check' })}
              >
                {state.step === 'checking' ? 'Checking…' : 'Check'}
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Warnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="import-warnings">
      {warnings.slice(0, 20).map((w, i) => (
        <li key={`${i}-${w}`}>{w}</li>
      ))}
      {warnings.length > 20 && <li>…and {warnings.length - 20} more.</li>}
    </ul>
  );
}
