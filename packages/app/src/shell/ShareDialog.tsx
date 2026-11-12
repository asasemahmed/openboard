/**
 * Sharing: who may open these boards from other machines. Owners invite
 * people (a link) and agents (a token), see who has access and revoke it.
 * In local mode the dialog explains that the boards are only reachable here.
 */
import type { AccessGrant, Role } from '@openboard/core';
import { useEffect, useId, useReducer, useState } from 'react';
import { plainLine } from '../lib/agents.js';
import { calmMessage } from '../lib/api.js';
import { AGENT_GRANT_ROLES, PERSON_ROLES, ROLE_TEXT } from '../lib/roles.js';
import {
  EXPIRY_CHOICES,
  grantStatus,
  INITIAL_SHARE,
  type Revealed,
  shareReducer,
  sortedGrants,
} from '../lib/share.js';
import { absoluteTime, relativeTime } from '../lib/time.js';
import { useAccess, useCan, useRole } from '../state/access.js';
import { useSession } from '../state/context.js';
import { useValue, Value } from '../state/emitter.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';

/** Open state of the share dialog, for this tab. */
export const shareOpen = new Value(false);

export function ShareButton() {
  const canShare = useCan('access.manage');
  if (!canShare) return null;
  return (
    <>
      <button
        type="button"
        className="topbar-text-btn"
        title="Share these boards with people and agents"
        onClick={() => shareOpen.set(true)}
      >
        <Icon name="link" />
        <span className="topbar-text-btn-label">Share</span>
      </button>
      <ShareDialog />
    </>
  );
}

/** A quiet reminder of what this person may do, where the editing tools would be. */
export function AccessBadge() {
  const role = useRole();
  const text = ROLE_TEXT[role];
  const label = role === 'viewer' ? 'View only' : role === 'commenter' ? 'Comment only' : text.name;
  return (
    <span
      className="access-badge"
      role="status"
      title={text.you}
      aria-label={`${label}. ${text.you}`}
    >
      <Icon name="eye" size={14} />
      {label}
    </span>
  );
}

function ShareDialog() {
  const open = useValue(shareOpen);
  const state = useAccess();
  const shared = state.status === 'ready' && state.who.shared;
  return (
    <Dialog
      open={open}
      onClose={() => shareOpen.set(false)}
      title="Share"
      size="md"
      description={
        shared
          ? 'Invite people and agents on other machines. Each invite has a role, and you can revoke it at any time.'
          : undefined
      }
    >
      {open && (shared ? <ShareContent /> : <LocalOnly />)}
    </Dialog>
  );
}

function LocalOnly() {
  return (
    <div className="share-local">
      <p>
        These boards are only reachable from this machine: the server listens on this computer
        alone.
      </p>
      <p>
        To let others in, start it in shared mode with <code>openboard start --share</code>, then
        invite them from here. How it works and what to put in front of it:{' '}
        <code>docs/sharing.md</code>.
      </p>
      <div className="dialog-actions">
        <Button variant="primary" onClick={() => shareOpen.set(false)}>
          Done
        </Button>
      </div>
    </div>
  );
}

function ShareContent() {
  const { api } = useSession();
  // Everything here, invite secrets included, lives only as long as this component: closing the dialog ends it.
  const [state, dispatch] = useReducer(shareReducer, INITIAL_SHARE);

  useEffect(() => {
    let alive = true;
    api
      .listAccess()
      .then((list) => alive && dispatch({ type: 'loaded', grants: list.grants }))
      .catch(
        (error: unknown) => alive && dispatch({ type: 'failed', message: calmMessage(error) }),
      );
    return () => {
      alive = false;
    };
  }, [api]);

  const create = async (
    kind: 'human' | 'agent',
    role: Role,
    label: string,
    hours: number | null,
  ) => {
    dispatch({ type: 'create', kind });
    try {
      const result = await api.grantAccess({
        kind,
        role,
        label: label.trim() || (kind === 'human' ? 'Invited person' : 'Invited agent'),
        ...(hours ? { expiresInHours: hours } : {}),
      });
      dispatch({ type: 'created', kind, result });
    } catch (error) {
      dispatch({ type: 'failed', message: calmMessage(error) });
    }
  };

  return (
    <div className="share">
      {state.error && (
        <p className="inline-error" role="alert">
          {state.error}
        </p>
      )}
      <InviteForm
        kind="human"
        title="Invite a person"
        roles={PERSON_ROLES}
        busy={state.busy === 'human'}
        revealed={state.revealed?.kind === 'human' ? state.revealed : null}
        onCreate={create}
        onHide={() => dispatch({ type: 'hide' })}
      />
      <InviteForm
        kind="agent"
        title="Invite an agent"
        roles={AGENT_GRANT_ROLES}
        busy={state.busy === 'agent'}
        revealed={state.revealed?.kind === 'agent' ? state.revealed : null}
        onCreate={create}
        onHide={() => dispatch({ type: 'hide' })}
      />
      <WhoHasAccess
        grants={state.grants}
        onRevoked={(grant) => dispatch({ type: 'revoked', grant })}
      />
    </div>
  );
}

function InviteForm({
  kind,
  title,
  roles,
  busy,
  revealed,
  onCreate,
  onHide,
}: {
  kind: 'human' | 'agent';
  title: string;
  roles: readonly Role[];
  busy: boolean;
  revealed: Revealed | null;
  onCreate: (kind: 'human' | 'agent', role: Role, label: string, hours: number | null) => void;
  onHide: () => void;
}) {
  const [role, setRole] = useState<Role>('editor');
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState<number | null>(kind === 'human' ? 24 * 7 : null);
  const id = useId();
  return (
    <section className="share-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{title}</h3>
      <fieldset className="share-roles">
        <legend className="field-label">Role</legend>
        {roles.map((r) => (
          <label key={r} className={`share-role${role === r ? ' is-active' : ''}`}>
            <input
              type="radio"
              name={`${id}-role`}
              value={r}
              checked={role === r}
              onChange={() => setRole(r)}
            />
            <span>
              <strong>{ROLE_TEXT[r].name}</strong>
              <span className="muted small">{ROLE_TEXT[r].line}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="share-row">
        <div className="field">
          <label htmlFor={`${id}-label`} className="field-label">
            {kind === 'human' ? 'Who it is for' : 'Which agent'}
          </label>
          <input
            id={`${id}-label`}
            className="input input-sm"
            maxLength={80}
            value={label}
            placeholder={kind === 'human' ? 'Ada’s laptop' : 'CI agent'}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-exp`} className="field-label">
            Expires
          </label>
          <select
            id={`${id}-exp`}
            className="input input-sm"
            value={hours ?? ''}
            onChange={(event) => setHours(event.target.value ? Number(event.target.value) : null)}
          >
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.label} value={c.hours ?? ''}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={() => onCreate(kind, role, label, hours)}
      >
        {busy ? 'Creating…' : kind === 'human' ? 'Create invite link' : 'Create agent token'}
      </Button>
      {revealed && <Reveal revealed={revealed} onHide={onHide} />}
    </section>
  );
}

function Reveal({ revealed, onHide }: { revealed: Revealed; onHide: () => void }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  const role = ROLE_TEXT[revealed.grant.role].name.toLowerCase();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="share-reveal" role="status">
      <label htmlFor={id} className="field-label">
        {revealed.kind === 'human' ? 'Invite link' : 'Agent token'}{' '}
        <span className="muted">(shown only now)</span>
      </label>
      <div className="share-secret">
        <input
          id={id}
          className="input input-sm"
          readOnly
          value={revealed.secret}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button size="sm" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {revealed.kind === 'human' ? (
        <p className="small">
          Whoever has this link gets {role} access, from any machine that reaches this server, until
          it expires or you revoke it below. Send it to one person, privately.
        </p>
      ) : (
        <div className="small">
          <p>Give the agent this token, then:</p>
          <ol>
            <li>
              Set it as <code>OPENBOARD_TOKEN</code> where the agent runs.
            </li>
            <li>
              Run <code>openboard connect --remote</code> there for the configuration to add.
            </li>
          </ol>
          <p className="muted">
            The agent stays under the review policy: its {role} role caps what it may try, the
            policy decides what waits for review.
          </p>
        </div>
      )}
      <Button size="sm" variant="ghost" onClick={onHide}>
        Hide
      </Button>
    </div>
  );
}

function WhoHasAccess({
  grants,
  onRevoked,
}: {
  grants: AccessGrant[] | null;
  onRevoked: (grant: AccessGrant) => void;
}) {
  const { api, ui } = useSession();
  const [error, setError] = useState<string | null>(null);
  if (grants === null) return <p className="muted small">Reading who has access…</p>;
  const now = Date.now();
  const { active, ended } = sortedGrants(grants, now);

  const revoke = (grant: AccessGrant) =>
    ui.confirm.set({
      title: `Revoke access for “${grant.label}”?`,
      body: 'Its sessions end immediately: open tabs show that access has ended, and an agent’s next call fails. Its pending proposals stay for you to decide.',
      actions: [
        { label: 'Keep access', run: () => {} },
        {
          label: 'Revoke access',
          tone: 'danger',
          run: () => {
            setError(null);
            api
              .revokeAccess(grant.id)
              .then(onRevoked)
              .catch((err: unknown) => setError(calmMessage(err)));
          },
        },
      ],
    });

  const row = (grant: AccessGrant) => {
    const status = grantStatus(grant, now);
    return (
      <li key={grant.id} className={`grant-row status-${status}`}>
        <div className="grant-main">
          <strong>{plainLine(grant.label, 60)}</strong>
          <span className="badge">{grant.kind === 'agent' ? 'Agent' : 'Person'}</span>
          <span className="badge">{ROLE_TEXT[grant.role].name}</span>
        </div>
        <div className="grant-meta">
          <span title={absoluteTime(grant.createdAt)}>Created {relativeTime(grant.createdAt)}</span>
          <span>
            {grant.lastUsedAt ? `Last used ${relativeTime(grant.lastUsedAt)}` : 'Not used yet'}
          </span>
          <span>
            {status === 'revoked'
              ? `Revoked ${relativeTime(grant.revokedAt ?? '')}`
              : grant.expiresAt
                ? `${status === 'expired' ? 'Expired' : 'Expires'} ${new Date(grant.expiresAt).toLocaleDateString()}`
                : 'Never expires'}
          </span>
        </div>
        {status === 'active' && (
          <Button size="sm" variant="danger" onClick={() => revoke(grant)}>
            Revoke
          </Button>
        )}
      </li>
    );
  };

  return (
    <section className="share-section">
      <h3>Who has access</h3>
      {error && <p className="inline-error">{error}</p>}
      {active.length === 0 ? (
        <p className="muted small">Nobody but you, at this machine.</p>
      ) : (
        <ul className="grant-list">{active.map(row)}</ul>
      )}
      {ended.length > 0 && (
        <details className="grants-ended">
          <summary>Revoked or expired ({ended.length})</summary>
          <ul className="grant-list">{ended.map(row)}</ul>
        </details>
      )}
    </section>
  );
}
