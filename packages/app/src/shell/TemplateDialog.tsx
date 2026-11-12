/**
 * "Insert template…": pick a template, optionally name it and put it in a
 * frame, see what it adds (the server checks it without changing anything),
 * then insert it. What arrived is brought into view.
 */
import { useEffect, useId, useReducer } from 'react';
import { useActions } from '../canvas/actions.js';
import { calmMessage } from '../lib/api.js';
import {
  initialTemplate,
  type TemplateState,
  templateReducer,
  templateRequest,
} from '../lib/templateFlow.js';
import { useSession } from '../state/context.js';
import { useStoreValue, useValue } from '../state/emitter.js';
import { loadTemplates } from '../state/templates.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { TemplateGallery } from './TemplateGallery.js';

export function TemplateDialog() {
  const { ui } = useSession();
  const request = useValue(ui.templateDialog);
  if (!request) return null;
  return (
    <TemplateForm
      frame={request.frame}
      {...(request.template ? { template: request.template } : {})}
    />
  );
}

function TemplateForm({ frame, template }: { frame: string | null; template?: string }) {
  const session = useSession();
  const { ui, store } = session;
  const actions = useActions();
  const [state, dispatch] = useReducer(
    templateReducer,
    undefined,
    (): TemplateState => ({ ...initialTemplate(frame), chosen: template ?? null }),
  );
  const ids = { title: useId(), frame: useId() };
  const close = () => ui.templateDialog.set(null);
  const frames = useStoreValue(store, () =>
    store.nodes
      .filter((n) => n.type === 'frame' && !n.data.ghost)
      .map((n) => `${n.id}\u0000${n.data.node.title}`)
      .join('\n'),
  );

  useEffect(() => {
    let alive = true;
    loadTemplates().then(
      (templates) => alive && dispatch({ type: 'loaded', templates }),
      (error: unknown) => alive && dispatch({ type: 'failed', message: calmMessage(error) }),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (state.step !== 'checking' && state.step !== 'applying') return;
    let alive = true;
    const dryRun = state.step === 'checking';
    session.api
      .applyTemplate(session.boardId, templateRequest(state, dryRun))
      .then((result) => {
        if (alive) dispatch(dryRun ? { type: 'checked', result } : { type: 'applied', result });
      })
      .catch((error: unknown) => {
        if (alive) dispatch({ type: 'failed', message: calmMessage(error) });
      });
    return () => {
      alive = false;
    };
    // The request is built from the state at the moment the step changed.
  }, [state.step]);

  useEffect(() => {
    if (state.step === 'done' && state.result && !state.result.proposed)
      void actions.reveal(state.result.nodeIds);
  }, [state.step, state.result, actions]);

  const chosen = state.templates.find((t) => t.id === state.chosen);
  const busy = state.step === 'checking' || state.step === 'applying';
  const frameTitle = (id: string) =>
    frames
      .split('\n')
      .find((e) => e.startsWith(`${id}\u0000`))
      ?.split('\u0000')[1];

  if (state.step === 'done' && state.result) {
    return (
      <Dialog open onClose={close} title="Insert template" size="md">
        <div className="import-done" role="status">
          <p>
            {state.result.proposed
              ? `Sent for review: “${chosen?.name ?? 'The template'}” waits for someone to accept it.`
              : `Inserted “${chosen?.name ?? 'the template'}”: ${state.result.nodeIds.length} node${state.result.nodeIds.length === 1 ? '' : 's'}.`}
          </p>
          <div className="dialog-actions">
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={close} title="Insert template" size="lg">
      <div className="template-form">
        {state.step === 'loading' ? (
          <p className="muted">Loading templates…</p>
        ) : (
          <TemplateGallery
            label="Template"
            templates={state.templates}
            value={state.chosen}
            disabled={busy}
            onChange={(id) => id && dispatch({ type: 'choose', id })}
          />
        )}
        <div className="import-options">
          <div className="field">
            <label htmlFor={ids.title} className="field-label">
              Title <span className="muted">(optional)</span>
            </label>
            <input
              id={ids.title}
              className="input input-sm"
              value={state.title}
              maxLength={200}
              placeholder={chosen?.name ?? ''}
              disabled={busy}
              onChange={(event) => dispatch({ type: 'title', title: event.target.value })}
            />
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
              This adds <strong>{state.preview.nodes}</strong> node
              {state.preview.nodes === 1 ? '' : 's'} and <strong>{state.preview.edges}</strong>{' '}
              connection{state.preview.edges === 1 ? '' : 's'}
              {state.frame ? ` inside the frame “${frameTitle(state.frame) ?? state.frame}”` : ''}.
              Nothing has changed yet.
            </p>
            {state.preview.review && (
              <p className="muted">It will wait for review: {state.preview.review}</p>
            )}
          </div>
        )}
        {state.error && (
          <div className="import-error" role="alert">
            <p>{state.error}</p>
          </div>
        )}
        <div className="dialog-actions">
          <Button onClick={close}>Cancel</Button>
          {state.step === 'preview' || state.step === 'applying' ? (
            <Button
              variant="primary"
              disabled={state.step === 'applying'}
              onClick={() => dispatch({ type: 'apply' })}
            >
              {state.step === 'applying' ? 'Inserting…' : 'Insert'}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || !state.chosen}
              onClick={() => dispatch({ type: 'check' })}
            >
              {state.step === 'checking' ? 'Checking…' : 'Check'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
