import { describe, expect, it } from 'vitest';
import {
  ActivityEventSchema,
  type Actor,
  BoardDoc,
  type Claim,
  type DocEvent,
  renderClaims,
  renderRead,
  renderSessions,
  type Session,
} from './index.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const bot: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };
const T0 = new Date('2026-01-01T00:00:00.000Z');

function seeded(): BoardDoc {
  const doc = BoardDoc.create({ id: 'main', name: 'Main' }, { now: T0 });
  doc.apply([{ op: 'add_node', id: 'n', node: { type: 'note', title: 'Note' } }], {
    actor: ada,
    now: T0,
  });
  return doc;
}

const claim: Claim = {
  nodeId: 'n',
  by: 'bot',
  minutes: 15,
  at: T0.toISOString(),
  until: '2026-01-01T00:15:00.000Z',
  note: 'mine',
};

describe('claims in the document', () => {
  it('stores claims apart from the board and reports them in events', () => {
    const doc = seeded();
    const events: DocEvent[] = [];
    doc.observe((event) => events.push(event));
    doc.putClaim(claim, doc.origin('bot', 'ops'));
    expect(doc.getClaim('n')).toEqual(claim);
    expect(events.map((e) => [e.claims, e.states, e.changes])).toEqual([[['n'], undefined, []]]);
    expect(doc.toJSON()).toEqual(seeded().toJSON());
    expect(doc.deleteClaims(['n', 'x'], doc.origin('bot', 'ops'))).toEqual(['n']);
    expect(doc.claims()).toEqual([]);
  });

  it('skips claims that fail their schema', () => {
    const doc = seeded();
    doc.ydoc.getMap('claims').set('n', { nodeId: 'other', by: 'bot' });
    expect(doc.claims()).toEqual([]);
    expect(doc.issues().some((line) => line.startsWith('claim on "n" skipped'))).toBe(true);
  });

  it('marks claimed nodes in reads', () => {
    const doc = seeded();
    doc.registerActor(bot, doc.origin('bot', 'ops'));
    const text = renderRead(doc.toJSON(), doc.nodes(), 1, { claims: { n: claim } }).text;
    expect(text).toContain('claimed by Bot (agent) until 2026-01-01T00:15:00.000Z (note "mine")');
  });
});

describe('document states for replay', () => {
  it('reports actor and metadata changes', () => {
    const doc = seeded();
    const events: DocEvent[] = [];
    doc.observe((event) => events.push(event));
    doc.registerActor(bot, doc.origin('bot', 'ops'));
    expect(events[0]?.states?.actors).toEqual({ bot: { before: null, after: bot } });
    doc.setMeta({ name: 'Renamed' }, ada);
    expect(events[1]?.states?.meta?.before.name).toBe('Main');
    expect(events[1]?.states?.meta?.after.name).toBe('Renamed');
  });

  it('exports the stored state without repairs', () => {
    const doc = seeded();
    doc.apply([{ op: 'add_node', id: 'f', node: { type: 'frame', title: 'F' } }], { actor: ada });
    doc.apply([{ op: 'update_node', id: 'n', patch: { parent: 'f' } }], { actor: ada });
    // Removing the frame in a raw write leaves a dangling parent behind.
    doc.ydoc.transact(() => doc.ydoc.getMap('nodes').delete('f'));
    expect(doc.raw().nodes.n?.parent).toBe('f');
    expect(doc.toJSON().nodes.n?.parent).toBeUndefined();
    expect(BoardDoc.fromJSON(doc.raw()).toJSON()).toEqual(doc.toJSON());
  });
});

describe('activity', () => {
  it('validates events', () => {
    expect(ActivityEventSchema.safeParse({ session: 's1', kind: 'tool_start' }).success).toBe(true);
    expect(ActivityEventSchema.safeParse({ session: 's 1', kind: 'tool_start' }).success).toBe(
      false,
    );
    expect(ActivityEventSchema.safeParse({ session: 's1', kind: 'dance' }).success).toBe(false);
  });

  it('renders sessions and claims for a model', () => {
    const session: Session = {
      id: 'main',
      actor: 'bot',
      label: 'Release',
      status: 'active',
      startedAt: T0.toISOString(),
      lastAt: T0.toISOString(),
      current: { tool: 'Bash', summary: 'pnpm build', since: T0.toISOString() },
      recent: [{ at: T0.toISOString(), tool: 'Read', summary: 'src/a.ts', ok: true }],
      counts: { tools: 1, errors: 0 },
      children: ['sub'],
    };
    const result = renderSessions([session], { actors: { bot } });
    expect(result.text).toContain('main "Release" by Bot (agent): active');
    expect(result.text).toContain('1 tool call, 0 errors');
    expect(result.text).toContain('now Bash since');
    expect(result.text).toContain('subagents: sub');
    expect(result.text).toContain('last Read ok at');
    expect(renderSessions([]).text).toBe('No agent sessions are running.');
    const text = renderClaims(
      'main',
      {
        claims: [claim],
        conflicts: [{ nodeId: 'm', by: 'bot', until: claim.until }],
        released: [],
      },
      { actors: { bot }, titles: { n: 'Note' } },
    );
    expect(text).toContain('Claimed by someone else (1)');
    expect(text).toContain('You hold 1 claim on board main:\n  n "Note" until');
  });
});
