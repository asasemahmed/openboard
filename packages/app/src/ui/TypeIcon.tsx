/**
 * The icons a declared type may pick (`TYPE_ICONS` in core), drawn like the
 * rest of the app's icons: a 16px grid, 1.5px stroke in `currentColor`.
 */
import { builtinTypeGlyph, type TypeIcon as TypeIconName } from '@openboard/core';
import { createElement, type ReactNode } from 'react';

export const TYPE_ICON_PATHS: Record<TypeIconName, ReactNode> = {
  box: (
    <>
      <path d="M2.5 5L8 2.25 13.5 5v6L8 13.75 2.5 11z" />
      <path d="M2.5 5L8 7.75 13.5 5M8 7.75v6" />
    </>
  ),
  circle: <circle cx="8" cy="8" r="5.5" />,
  star: (
    <path d="M8 2.25l1.75 3.6 3.95.55-2.85 2.8.7 3.95L8 11.3l-3.55 1.85.7-3.95L2.3 6.4l3.95-.55z" />
  ),
  flag: (
    <>
      <path d="M3.5 14V2.5" />
      <path d="M3.5 3h8.25l-1.75 3 1.75 3H3.5" />
    </>
  ),
  bookmark: <path d="M4 2.5h8v11l-4-2.75-4 2.75z" />,
  tag: (
    <>
      <path d="M2.5 2.5h5.25l6 6-5.25 5.25-6-6z" />
      <circle cx="5.5" cy="5.5" r="0.75" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.25" r="2.75" />
      <path d="M2.75 13.75a5.25 5.25 0 0110.5 0" />
    </>
  ),
  users: (
    <>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13.5a4.5 4.5 0 019 0" />
      <path d="M10.25 3.25a2.5 2.5 0 010 4.75M12 9.5a4.5 4.5 0 012.5 4" />
    </>
  ),
  bot: builtinTypePaths('agent'),
  bug: (
    <>
      <rect x="4.75" y="5" width="6.5" height="8.5" rx="3.25" />
      <path d="M6 5a2 2 0 014 0M2.5 8.5h2.25M11.25 8.5h2.25M3 4.5l1.9 1.4M13 4.5l-1.9 1.4M3 13l1.9-1.4M13 13l-1.9-1.4" />
    </>
  ),
  bolt: <path d="M9 1.75L3.5 9h4l-.5 5.25L12.5 7h-4z" />,
  beaker: (
    <>
      <path d="M6 2.25v4.5L2.75 12.5a1 1 0 00.9 1.5h8.7a1 1 0 00.9-1.5L10 6.75v-4.5" />
      <path d="M5 2.25h6M4.5 10h7" />
    </>
  ),
  chart: (
    <>
      <path d="M2.5 2.5v11h11" />
      <path d="M5.5 10.5V8M8.5 10.5V5.5M11.5 10.5V7" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.75V8l2.25 1.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.75h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M5.5 8.25l1.75 1.75 3.25-3.75" />
    </>
  ),
  alert: builtinTypePaths('risk'),
  lightbulb: (
    <>
      <path d="M6 11.5v-1.1a4.5 4.5 0 114 0v1.1z" />
      <path d="M6.5 14h3" />
    </>
  ),
  link: (
    <>
      <path d="M7 9a2.75 2.75 0 003.9.1l2-2a2.75 2.75 0 00-3.9-3.9l-.85.85" />
      <path d="M9 7a2.75 2.75 0 00-3.9-.1l-2 2a2.75 2.75 0 003.9 3.9l.85-.85" />
    </>
  ),
  file: builtinTypePaths('doc'),
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10" />,
  database: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="1.75" />
      <path d="M3 4v8c0 1 2.25 1.75 5 1.75s5-.75 5-1.75V4M3 8c0 1 2.25 1.75 5 1.75S13 9 13 8" />
    </>
  ),
  server: (
    <>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      <path d="M5 4.75h.01M5 11.25h.01" />
    </>
  ),
  target: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="0.5" />
    </>
  ),
};

export function TypeIcon({ name, size = 16 }: { name: TypeIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="type-icon"
    >
      {TYPE_ICON_PATHS[name]}
    </svg>
  );
}

function builtinTypePaths(type: string): ReactNode {
  return builtinTypeGlyph(type)?.map(({ tag, attrs }) =>
    createElement(tag, { ...attrs, key: `${tag}:${Object.values(attrs).join(',')}` }),
  );
}

export function hasBuiltinTypeIcon(type: string): boolean {
  return builtinTypeGlyph(type) !== undefined;
}

export function BuiltinTypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  if (!hasBuiltinTypeIcon(type)) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="type-icon"
    >
      {builtinTypePaths(type)}
    </svg>
  );
}
