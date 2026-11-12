/** A claim on the selected node, with Release (people may release any claim). */
import { useState } from 'react';
import { plainLine } from '../lib/agents.js';
import { calmMessage } from '../lib/api.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { Avatar } from '../ui/Avatar.js';
import { Button } from '../ui/Button.js';
import { Section } from './fields.js';

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function ClaimSection({ nodeId }: { nodeId: string }) {
  const session = useSession();
  const { claims, store, ui } = session;
  const claim = useStoreValue(claims, () => claims.claimOn(nodeId));
  const actor = useStoreValue(store, () => (claim ? store.meta.actors[claim.by] : undefined));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!claim) return null;
  const name = actor?.name ?? claim.by;

  const release = () =>
    ui.confirm.set({
      title: `Release ${name}’s claim?`,
      body: `${name} will no longer hold this card. Its work is not undone, and it can claim the card again.`,
      actions: [
        { label: 'Keep it', run: () => {} },
        {
          label: 'Release',
          tone: 'primary',
          run: () => {
            setBusy(true);
            setError(null);
            session.api
              .claim(session.boardId, { nodeIds: [nodeId], release: true })
              .catch((err: unknown) => setError(calmMessage(err)))
              .finally(() => setBusy(false));
          },
        },
      ],
    });

  return (
    <Section title="Claimed">
      <div className="claim-box">
        <Avatar actor={actor ?? { id: claim.by, name, kind: 'agent' }} size={22} />
        <div>
          <p>
            <strong>{name}</strong> is working on this until {clock(claim.until)}.
          </p>
          {claim.note && <p className="muted">{plainLine(claim.note, 200)}</p>}
          <p className="muted small">Other agents cannot change it meanwhile. People can.</p>
        </div>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="inspector-actions">
        <Button size="sm" disabled={busy} onClick={release}>
          Release claim
        </Button>
      </div>
    </Section>
  );
}
