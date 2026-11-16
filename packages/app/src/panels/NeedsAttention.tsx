/**
 * "Needs attention": what `boardHealth` finds on the board, grouped by kind,
 * in the inspector when nothing is selected. Each finding is a button that
 * selects its card, brings it into view and focuses it. The section is not
 * rendered at all when there is nothing to show.
 */
import type { HealthFinding, HealthKind } from '@openboard-dev/core';
import { useId, useMemo, useState } from 'react';
import { useActions } from '../canvas/actions.js';
import { focusNodeElement } from '../canvas/nodeFocus.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { Section } from './fields.js';

const GROUP_LABELS: Record<HealthKind, string> = {
  unanswered_question: 'Open questions',
  unmitigated_risk: 'Risks without a plan',
  blocked_but_clear: 'Blocked, but nothing in the way',
  loose_card: 'Loose cards',
};

/** Findings shown per group before "Show all". */
const SHOWN = 5;

function groupByKind(findings: readonly HealthFinding[]) {
  const groups = new Map<HealthKind, HealthFinding[]>();
  for (const finding of findings) {
    const list = groups.get(finding.kind);
    if (list) list.push(finding);
    else groups.set(finding.kind, [finding]);
  }
  return [...groups];
}

export function NeedsAttention() {
  const { store, ui } = useSession();
  const actions = useActions();
  const findings = useStoreValue(store, store.health);
  const groups = useMemo(() => groupByKind(findings), [findings]);
  if (findings.length === 0) return null;

  const go = (id: string) => {
    ui.pauseFollow();
    actions.jumpTo(id);
    focusNodeElement(id);
  };

  return (
    <Section
      title="Needs attention"
      aside={
        <span className="attention-count" aria-hidden="true">
          {findings.length}
        </span>
      }
    >
      <div className="attention">
        {groups.map(([kind, list]) => (
          <AttentionGroup key={kind} kind={kind} findings={list} onPick={go} />
        ))}
      </div>
    </Section>
  );
}

function AttentionGroup({
  kind,
  findings,
  onPick,
}: {
  kind: HealthKind;
  findings: readonly HealthFinding[];
  onPick: (id: string) => void;
}) {
  const { store } = useSession();
  const headingId = useId();
  const [all, setAll] = useState(false);
  const shown = all ? findings : findings.slice(0, SHOWN);
  return (
    <div className="attention-group">
      <h4 id={headingId} className="attention-heading">
        {GROUP_LABELS[kind]} <span className="attention-count">{findings.length}</span>
      </h4>
      <ul className="attention-list" aria-labelledby={headingId}>
        {shown.map((finding) => {
          const id = finding.nodeIds[0] as string;
          return (
            <li key={id}>
              <button type="button" className="attention-item" onClick={() => onPick(id)}>
                <span className="attention-title">{store.node(id)?.title ?? id}</span>
                <span className="attention-reason">{finding.reason}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {findings.length > SHOWN && (
        <button
          type="button"
          className="link-btn attention-more"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'Show fewer' : `Show all ${findings.length}`}
        </button>
      )}
    </div>
  );
}
