/**
 * Decorations for agents at work: a claim chip in the label row (who holds
 * the node and what its session is doing), a tint on the border of claimed
 * cards, and a thin outline in an agent's colour while it reads or writes a
 * node. Registered once at startup.
 */
import type { CSSProperties } from 'react';
import { claimChip } from '../state/claims.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { Icon } from '../ui/Icon.js';
import { type DecorationProps, registerNodeDecoration } from './decorations.js';

function useChip(nodeId: string) {
  const { claims, presence, store } = useSession();
  const claim = useStoreValue(claims, () => claims.claimOn(nodeId));
  // Re-read the label when sessions change status; the text is a primitive, so cards only
  // re-render when it does.
  const key = useStoreValue(presence, () => {
    if (!claim) return '';
    const chip = claimChip(claim, store.meta.actors, presence.getAgents(), Date.now());
    return `${chip.label}\n${chip.color}\n${chip.tooltip}`;
  });
  if (!claim || !key) return null;
  const [label = '', color = '', tooltip = ''] = key.split('\n');
  return { label, color, tooltip };
}

function ClaimChip({ node }: DecorationProps) {
  const chip = useChip(node.id);
  if (!chip) return null;
  return (
    <span
      className="claim-chip"
      role="img"
      aria-label={chip.tooltip}
      title={chip.tooltip}
      style={{ ['--claim' as string]: chip.color } as CSSProperties}
    >
      <Icon name="agent" size={11} />
      <span className="claim-chip-text">{chip.label}</span>
    </span>
  );
}

function ClaimTint({ node }: DecorationProps) {
  const chip = useChip(node.id);
  if (!chip) return null;
  return (
    <div
      className="claim-tint"
      aria-hidden="true"
      style={{ ['--claim' as string]: chip.color } as CSSProperties}
    />
  );
}

/** A thin outline in the colour of the agent reading or writing this node. */
function AgentFocus({ node }: DecorationProps) {
  const { presence } = useSession();
  const key = useStoreValue(presence, () => presence.agentsOnNode(node.id));
  if (!key) return null;
  const [color = 'currentColor'] = (key.split('\n')[0] ?? '').split('|');
  return (
    <div
      className="agent-focus"
      aria-hidden="true"
      style={{ ['--peer' as string]: color } as CSSProperties}
    />
  );
}

let registered = false;

export function registerLiveDecorations(): void {
  if (registered) return;
  registered = true;
  registerNodeDecoration({
    id: 'claim-chip',
    slot: 'header',
    order: 5,
    applies: (_node, ghost) => !ghost,
    Component: ClaimChip,
  });
  registerNodeDecoration({
    id: 'claim-tint',
    slot: 'overlay',
    order: 2,
    applies: (_node, ghost) => !ghost,
    Component: ClaimTint,
  });
  registerNodeDecoration({
    id: 'agent-focus',
    slot: 'overlay',
    order: 3,
    applies: (_node, ghost) => !ghost,
    Component: AgentFocus,
  });
}
