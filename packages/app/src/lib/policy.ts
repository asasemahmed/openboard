/**
 * Review policy as people set it: the project default and per-agent modes in
 * the settings dialog, and the per-frame override in the inspector.
 */
import {
  type Actor,
  type BoardNode,
  FRAME_POLICY_PROP,
  type FramePolicy,
  framePolicyOf,
  type Json,
  type PolicyMode,
  type ProjectConfig,
} from '@openboard/core';

export const POLICY_MODES: readonly PolicyMode[] = [
  'auto',
  'review_destructive',
  'review_all',
  'locked',
];

/** Names and one plain line per mode, shortened from the rules in core's collab.ts. */
export const MODE_META: Record<PolicyMode, { name: string; line: string }> = {
  auto: { name: 'Free', line: 'Every change applies directly.' },
  review_destructive: {
    name: 'Review edits to others’ work',
    line: 'Adding is free. Changing or removing what someone else made waits for review.',
  },
  review_all: { name: 'Review everything', line: 'Every change waits for review.' },
  locked: { name: 'Read only', line: 'Can read the board but not change it.' },
};

/** "Use the default" for an agent, or one of the modes. */
export type AgentChoice = PolicyMode | 'default';

export interface PolicyForm {
  default: PolicyMode;
  /** One entry per agent shown in the form. */
  agents: Record<string, AgentChoice>;
}

/** The form for a config, with a row for each of `agents` (by id). */
export function policyForm(
  config: ProjectConfig,
  agents: readonly Pick<Actor, 'id'>[],
): PolicyForm {
  const rows: Record<string, AgentChoice> = {};
  for (const agent of agents) rows[agent.id] = config.policy.agents[agent.id] ?? 'default';
  return { default: config.policy.default, agents: rows };
}

/**
 * The config to save. Agents the form does not show keep their settings;
 * agents set to "default" lose their entry.
 */
export function configFromForm(form: PolicyForm, base: ProjectConfig): ProjectConfig {
  const agents: Record<string, PolicyMode> = { ...base.policy.agents };
  for (const [id, choice] of Object.entries(form.agents)) {
    if (choice === 'default') delete agents[id];
    else agents[id] = choice;
  }
  return { ...base, version: 1, policy: { default: form.default, agents } };
}

export function formChanged(form: PolicyForm, base: ProjectConfig): boolean {
  const next = configFromForm(form, base);
  if (next.policy.default !== base.policy.default) return true;
  const a = Object.entries(next.policy.agents).sort();
  const b = Object.entries(base.policy.agents).sort();
  return JSON.stringify(a) !== JSON.stringify(b);
}

// ── Frames ───────────────────────────────────────────────────────────────────

export type FrameAccess = FramePolicy | 'inherit';

export const FRAME_ACCESS: readonly FrameAccess[] = ['inherit', 'auto', 'review', 'locked'];

export const FRAME_ACCESS_META: Record<FrameAccess, { name: string; line: string }> = {
  inherit: { name: 'Inherit', line: 'Agents follow the project settings or an enclosing frame.' },
  auto: { name: 'Free', line: 'Agents change anything in this frame directly.' },
  review: { name: 'Needs review', line: 'Agent changes in this frame wait for review.' },
  locked: { name: 'Locked', line: 'Agents can read this frame but not change it.' },
};

export function frameAccess(node: Pick<BoardNode, 'type' | 'props'>): FrameAccess {
  return framePolicyOf(node) ?? 'inherit';
}

/**
 * The `props` to write for a frame's new access setting, keeping every other
 * prop. Null clears `props` when nothing else is left in it.
 */
export function framePolicyProps(
  node: Pick<BoardNode, 'props'>,
  access: FrameAccess,
): Record<string, Json> | null {
  const props: Record<string, Json> = { ...(node.props ?? {}) };
  if (access === 'inherit') delete props[FRAME_POLICY_PROP];
  else props[FRAME_POLICY_PROP] = access;
  return Object.keys(props).length > 0 ? props : null;
}
