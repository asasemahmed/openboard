/** "Agent access" for a frame: inherit the project policy, or free, review or lock what is inside. */
import type { BoardNode, Json } from '@openboard/core';
import { type KeyboardEvent, useId } from 'react';
import { FRAME_ACCESS, FRAME_ACCESS_META, frameAccess, framePolicyProps } from '../lib/policy.js';

export function FrameAccessField({
  node,
  onChange,
}: {
  node: BoardNode;
  onChange: (props: Record<string, Json> | null) => void;
}) {
  const id = useId();
  const current = frameAccess(node);
  const choose = (access: (typeof FRAME_ACCESS)[number]) => {
    if (access !== current) onChange(framePolicyProps(node, access));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const group = event.currentTarget;
    const index = FRAME_ACCESS.indexOf(current);
    const next = FRAME_ACCESS[(index + step + FRAME_ACCESS.length) % FRAME_ACCESS.length];
    if (!next) return;
    choose(next);
    requestAnimationFrame(() =>
      group.querySelector<HTMLElement>(`[data-access="${next}"]`)?.focus(),
    );
  };
  return (
    <fieldset className="field frame-access">
      <legend className="field-label" id={id}>
        Agent access
      </legend>
      <div
        className="segmented segmented-wide"
        role="radiogroup"
        aria-labelledby={id}
        onKeyDown={onKeyDown}
      >
        {FRAME_ACCESS.map((access) => (
          <button
            key={access}
            type="button"
            role="radio"
            aria-checked={current === access}
            tabIndex={current === access ? 0 : -1}
            data-access={access}
            className={current === access ? 'is-active' : ''}
            onClick={() => choose(access)}
          >
            {FRAME_ACCESS_META[access].name}
          </button>
        ))}
      </div>
      <p className="field-hint">{FRAME_ACCESS_META[current].line}</p>
    </fieldset>
  );
}
