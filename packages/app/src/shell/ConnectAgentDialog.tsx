/**
 * "Connect an agent": how to add this project's board server to Claude Code,
 * Cursor, Codex, Gemini CLI or any other MCP client, with copyable snippets built from
 * what the server reports in `GET /api/info`, and a few prompts to try.
 */
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import {
  AGENT_CLIENTS,
  type AgentClient,
  examplePrompts,
  type Snippet,
  snippetsFor,
} from '../lib/agentSetup.js';
import type { ServerInfo } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { readStored, writeStored } from '../lib/storage.js';
import { useMeta, useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { toasts } from '../state/toasts.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';

const COPIED_MS = 1600;
const isClient = (value: unknown): value is AgentClient =>
  AGENT_CLIENTS.some((c) => c.id === value);

type InfoState =
  | { status: 'loading' }
  | { status: 'ready'; info: ServerInfo | null }
  | { status: 'error'; message: string };

/** A copy button that says "Copied" for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className={`copy-btn${copied ? ' is-copied' : ''}`}
      aria-label={copied ? 'Copied' : label}
      title={label}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        } else {
          toasts.show('Could not copy. Select the text and copy it yourself.', { tone: 'error' });
        }
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

function SnippetBlock({ snippet }: { snippet: Snippet }) {
  return (
    <div className="snippet">
      <p className="snippet-label">
        {snippet.label}
        {snippet.file && (
          <>
            {' '}
            <code>{snippet.file}</code>
          </>
        )}
      </p>
      <div className="snippet-box">
        <pre className="snippet-code">
          <code>{snippet.text}</code>
        </pre>
        <CopyButton
          text={snippet.text}
          label={snippet.file ? `Copy for ${snippet.file}` : 'Copy command'}
        />
      </div>
    </div>
  );
}

/** "Plan <goal> on …": the placeholder is shown as a slot, and copied as written. */
function PromptText({ text }: { text: string }) {
  const parts = text.split(/(<[a-z ]+>)/);
  return (
    <>
      {parts.map((part, i) =>
        /^<[a-z ]+>$/.test(part) ? (
          <span key={i} className="prompt-slot">
            {part.slice(1, -1)}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function ClientTabs({
  active,
  onChange,
  panelId,
}: {
  active: AgentClient;
  onChange: (client: AgentClient) => void;
  panelId: string;
}) {
  const refs = useRef(new Map<AgentClient, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent) => {
    const index = AGENT_CLIENTS.findIndex((c) => c.id === active);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = AGENT_CLIENTS[(index + step + AGENT_CLIENTS.length) % AGENT_CLIENTS.length];
    if (!next) return;
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  };
  return (
    <div className="segmented client-tabs" role="tablist" aria-label="Agent" onKeyDown={onKeyDown}>
      {AGENT_CLIENTS.map((client) => (
        <button
          key={client.id}
          ref={(el) => {
            if (el) refs.current.set(client.id, el);
          }}
          type="button"
          role="tab"
          id={`${panelId}-${client.id}`}
          aria-selected={client.id === active}
          aria-controls={panelId}
          tabIndex={client.id === active ? 0 : -1}
          className={client.id === active ? 'is-active' : ''}
          onClick={() => onChange(client.id)}
        >
          {client.name}
        </button>
      ))}
    </div>
  );
}

function NoAgentAccess() {
  return (
    <div className="connect-missing">
      <p>
        This server does not say how agents can reach it. Agent access needs{' '}
        <code>openboard start</code> from a build that includes it: restart the server that way,
        then open this again.
      </p>
      <p className="muted">Or set up your agent from a terminal in the project folder:</p>
      <div className="snippet-box">
        <pre className="snippet-code">
          <code>openboard connect</code>
        </pre>
        <CopyButton text="openboard connect" label="Copy command" />
      </div>
    </div>
  );
}

export function ConnectAgentDialog() {
  const session = useSession();
  const open = useValue(session.ui.connectAgent);
  const { meta } = useMeta();
  const [client, setClient] = useState<AgentClient>(
    () => readStored('agentClient', isClient) ?? 'claude',
  );
  const [state, setState] = useState<InfoState>({ status: 'loading' });
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    session.api.info().then(
      (info) => {
        if (!cancelled) setState({ status: 'ready', info });
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'The server did not answer.',
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, session.api]);

  const choose = (next: AgentClient) => {
    setClient(next);
    writeStored('agentClient', next);
  };

  const info = state.status === 'ready' ? state.info : null;
  const mcp = info?.mcp;

  return (
    <Dialog
      open={open}
      onClose={() => session.ui.connectAgent.set(false)}
      title="Connect an agent"
      size="md"
      className="connect-dialog"
      description="Agents read and edit this board over MCP. Add OpenBoard to your agent once for this project, then ask it to work on the board."
    >
      {state.status === 'loading' && (
        <p className="connect-status muted" aria-busy="true">
          Checking how this server can be reached…
        </p>
      )}
      {state.status === 'error' && (
        <p className="field-error" role="alert">
          Could not ask the server how to connect: {state.message}
        </p>
      )}
      {state.status === 'ready' && !mcp && <NoAgentAccess />}
      {mcp && (
        <>
          <ClientTabs active={client} onChange={choose} panelId={panelId} />
          <div
            className="connect-panel"
            role="tabpanel"
            id={panelId}
            aria-labelledby={`${panelId}-${client}`}
          >
            {snippetsFor(client, mcp).map((snippet) => (
              <SnippetBlock key={snippet.id} snippet={snippet} />
            ))}
          </div>
        </>
      )}
      {state.status !== 'loading' && (
        <section className="connect-prompts" aria-labelledby={`${panelId}-prompts`}>
          <h3 id={`${panelId}-prompts`}>Then try asking</h3>
          <ul>
            {examplePrompts(meta.name).map((prompt) => (
              <li key={prompt.id}>
                <span className="prompt-text">
                  <PromptText text={prompt.text} />
                </span>
                <CopyButton text={prompt.text} label="Copy prompt" />
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="dialog-actions connect-actions">
        {info?.root && (
          <p className="connect-project">
            Project <strong>{info.projectName || 'this folder'}</strong>
            <code title={info.root}>{info.root}</code>
          </p>
        )}
        <Button onClick={() => session.ui.connectAgent.set(false)}>Done</Button>
      </div>
    </Dialog>
  );
}
