/**
 * Project settings. For now one section: the review policy, which decides
 * how much each agent may change without someone accepting it first. It is
 * saved in .openboard/config.json, so it applies to every board of the
 * project and is reread each time the dialog opens.
 */
import type { PolicyMode, ProjectConfig } from '@openboard/core';
import { useEffect, useId, useState } from 'react';
import { calmMessage } from '../lib/api.js';
import { EDITORS, type EditorScheme, readEditorScheme, writeEditorScheme } from '../lib/editor.js';
import {
  type AgentChoice,
  configFromForm,
  formChanged,
  MODE_META,
  POLICY_MODES,
  type PolicyForm,
  policyForm,
} from '../lib/policy.js';
import { ReadOnlyNote } from '../panels/ReadOnlyNote.js';
import { useCan } from '../state/access.js';
import { serverInfo } from '../state/boards.js';
import { useSession } from '../state/context.js';
import { useStoreValue, useValue } from '../state/emitter.js';
import { toasts } from '../state/toasts.js';
import { Avatar } from '../ui/Avatar.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; config: ProjectConfig };

export function SettingsDialog() {
  const session = useSession();
  const { ui, store } = session;
  const open = useValue(ui.settings);
  const actors = useStoreValue(store, () => store.meta.actors);
  const agents = Object.values(actors)
    .filter((a) => a.kind === 'agent')
    .sort((a, b) => a.name.localeCompare(b.name));
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultId = useId();
  const canWrite = useCan('config.write');

  // Read the settings fresh on every open, so changes made elsewhere show up.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad({ status: 'loading' });
    setError(null);
    session.api
      .getConfig()
      .then((config) => {
        if (!live) return;
        setLoad({ status: 'ready', config });
        setForm(policyForm(config, agents));
      })
      .catch(
        (err: unknown) =>
          live && setLoad({ status: 'error', message: calmMessage(err, 'settings') }),
      );
    return () => {
      live = false;
    };
  }, [open, session]);

  const close = () => ui.settings.set(false);

  const save = async () => {
    if (load.status !== 'ready' || !form) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await session.api.setConfig(configFromForm(form, load.config));
      setLoad({ status: 'ready', config: saved });
      toasts.show('Review policy saved.');
      close();
    } catch (err) {
      setError(calmMessage(err, 'settings'));
    } finally {
      setSaving(false);
    }
  };

  const setAgent = (id: string, choice: AgentChoice) =>
    setForm((f) => (f ? { ...f, agents: { ...f.agents, [id]: choice } } : f));

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Settings"
      size="md"
      description="These apply to every board in this project and are saved in .openboard/config.json, so commit them with your code."
    >
      <EditorSettings />
      <section className="settings-section" aria-labelledby={`${defaultId}-h`}>
        <h3 id={`${defaultId}-h`}>Review policy</h3>
        <p className="muted small">
          How much an agent may change before a person accepts it. People are never restricted. A
          frame can override this for what is inside it, from its inspector.
        </p>
        {load.status === 'loading' && <p className="muted small">Loading settings…</p>}
        {load.status === 'error' && <p className="inline-error">{load.message}</p>}
        {!canWrite && <ReadOnlyNote action="config.write" />}
        {load.status === 'ready' && form && (
          <fieldset className="inspector-fieldset" disabled={!canWrite}>
            <div className="policy-row policy-row-default">
              <label htmlFor={defaultId} className="policy-who">
                <strong>Default</strong>
                <span className="muted small">For agents without a setting of their own</span>
              </label>
              <ModeSelect
                id={defaultId}
                value={form.default}
                onChange={(mode) => setForm((f) => (f ? { ...f, default: mode as PolicyMode } : f))}
              />
            </div>
            {agents.length === 0 ? (
              <p className="muted small policy-none">
                No agent has worked on this board yet. Each one gets a row here once it has.
              </p>
            ) : (
              agents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  value={form.agents[agent.id] ?? 'default'}
                  fallback={form.default}
                  onChange={(choice) => setAgent(agent.id, choice)}
                />
              ))
            )}
          </fieldset>
        )}
      </section>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button onClick={close}>{canWrite ? 'Cancel' : 'Close'}</Button>
        <Button
          variant="primary"
          hidden={!canWrite}
          disabled={saving || load.status !== 'ready' || !form || !formChanged(form, load.config)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Dialog>
  );
}

function ModeSelect({
  id,
  value,
  onChange,
  withDefault,
}: {
  id: string;
  value: AgentChoice;
  onChange: (value: AgentChoice) => void;
  withDefault?: PolicyMode;
}) {
  const shown = value === 'default' ? withDefault : value;
  return (
    <div className="mode-select">
      <select
        id={id}
        className="input input-sm"
        value={value}
        aria-describedby={`${id}-line`}
        onChange={(event) => onChange(event.target.value as AgentChoice)}
      >
        {withDefault && <option value="default">Default ({MODE_META[withDefault].name})</option>}
        {POLICY_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {MODE_META[mode].name}
          </option>
        ))}
      </select>
      <p id={`${id}-line`} className="mode-line">
        {shown ? MODE_META[shown].line : ''}
      </p>
    </div>
  );
}

function AgentRow({
  agent,
  value,
  fallback,
  onChange,
}: {
  agent: { id: string; name: string; kind: 'agent' | 'human' | 'system'; color?: string };
  value: AgentChoice;
  fallback: PolicyMode;
  onChange: (value: AgentChoice) => void;
}) {
  const id = useId();
  return (
    <div className="policy-row">
      <label htmlFor={id} className="policy-who">
        <Avatar actor={agent} size={22} />
        <span>
          <strong>{agent.name}</strong>
          <span className="muted small policy-id">{agent.id}</span>
        </span>
      </label>
      <ModeSelect id={id} value={value} withDefault={fallback} onChange={onChange} />
    </div>
  );
}

/** Where "Open in editor" opens files; a choice for this browser, saved at once. */
function EditorSettings() {
  const info = useValue(serverInfo);
  const [scheme, setScheme] = useState<EditorScheme>(readEditorScheme);
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Editor</h3>
      <div className="policy-row">
        <label htmlFor={id} className="policy-who">
          <span>
            <strong>Open linked code in</strong>
            <span className="muted small">Saved in this browser</span>
          </span>
        </label>
        <select
          id={id}
          className="input input-sm"
          value={scheme}
          onChange={(event) => {
            const next = event.target.value as EditorScheme;
            setScheme(next);
            writeEditorScheme(next);
          }}
        >
          {EDITORS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>
      <div className="policy-row">
        <span className="policy-who">
          <span>
            <strong>Project root</strong>
            <span className="muted small">Link paths are relative to it</span>
          </span>
        </span>
        <code className="settings-root" title={info?.root}>
          {info?.root || 'Not known yet'}
        </code>
      </div>
    </section>
  );
}
