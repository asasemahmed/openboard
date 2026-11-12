/**
 * Inline icons drawn on a 16px grid with a 1.5px stroke in `currentColor`.
 * Decorative by default (`aria-hidden`); give the surrounding control a label.
 */
import type { SVGProps } from 'react';

const PATHS = {
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  chevronRight: <path d="M6 4l4 4-4 4" />,
  undo: (
    <>
      <path d="M5.5 3.5L2.5 6.5l3 3" />
      <path d="M2.5 6.5h7a4 4 0 010 8H7" />
    </>
  ),
  redo: (
    <>
      <path d="M10.5 3.5l3 3-3 3" />
      <path d="M13.5 6.5h-7a4 4 0 000 8H9" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25L13.5 13.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  system: (
    <>
      <rect x="2" y="2.75" width="12" height="8.5" rx="1.5" />
      <path d="M5.5 14h5M8 11.25V14" />
    </>
  ),
  fit: (
    <path d="M2.5 6V3.5a1 1 0 011-1H6M10 2.5h2.5a1 1 0 011 1V6M13.5 10v2.5a1 1 0 01-1 1H10M6 13.5H3.5a1 1 0 01-1-1V10" />
  ),
  minimap: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <rect x="8.5" y="8" width="4" height="3.5" rx=".5" />
    </>
  ),
  pin: (
    <>
      <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4" />
      <path d="M8 9v4.5" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4.5h11M6.5 4.5V3a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1.5" />
      <path d="M4 4.5l.6 8.1a1 1 0 001 .9h4.8a1 1 0 001-.9l.6-8.1" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" />
    </>
  ),
  link: (
    <>
      <path d="M7 9a2.75 2.75 0 003.9 0l2-2a2.75 2.75 0 00-3.9-3.9l-.6.6" />
      <path d="M9 7a2.75 2.75 0 00-3.9 0l-2 2A2.75 2.75 0 007 12.9l.6-.6" />
    </>
  ),
  file: (
    <>
      <path d="M9 2H4.5a1 1 0 00-1 1v10a1 1 0 001 1h7a1 1 0 001-1V5.5z" />
      <path d="M9 2v3.5h3.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M2.25 8h11.5M8 2.25c1.6 1.7 2.4 3.6 2.4 5.75S9.6 12.05 8 13.75C6.4 12.05 5.6 10.15 5.6 8S6.4 3.95 8 2.25z" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.5l6 10.5H2z" />
      <path d="M8 6.5v3M8 11.25v.25" />
    </>
  ),
  keyboard: (
    <>
      <rect x="1.75" y="4" width="12.5" height="8" rx="1.5" />
      <path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5 9.5h6" />
    </>
  ),
  layout: (
    <>
      <rect x="2" y="2" width="5" height="4" rx="1" />
      <rect x="9" y="2" width="5" height="4" rx="1" />
      <rect x="2" y="10" width="5" height="4" rx="1" />
      <path d="M4.5 6v4M11.5 6v2.5a1 1 0 01-1 1H7" />
    </>
  ),
  frame: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 5.5h12" />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r=".75" />
      <circle cx="8" cy="8" r=".75" />
      <circle cx="12.5" cy="8" r=".75" />
    </>
  ),
  boards: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 11-1.5-3.55" />
      <path d="M13 2.5v3h-3" />
    </>
  ),
  external: (
    <>
      <path d="M9.5 2.5h4v4M13.5 2.5L8 8" />
      <path d="M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3" />
    </>
  ),
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />,
  /** A small robot head: marks agents and agent-made things. */
  agent: (
    <>
      <rect x="2.5" y="5.25" width="11" height="8.25" rx="2.5" />
      <path d="M8 5.25V2.75" />
      <path d="M6 9v.75M10 9v.75" />
    </>
  ),
  /** A target: keep the view on what others change. */
  follow: (
    <>
      <circle cx="8" cy="8" r="4.25" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
    </>
  ),
  arrowUp: <path d="M8 13V3M4 7l4-4 4 4" />,
  arrowDown: <path d="M8 3v10M4 9l4 4 4-4" />,
  arrowLeft: <path d="M13 8H3M7 4L3 8l4 4" />,
  arrowRight: <path d="M3 8h10M9 4l4 4-4 4" />,
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  /** A frame agents may only read. */
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </>
  ),
  /** A frame agents change freely. */
  unlock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 014.8-1" />
    </>
  ),
  /** Agent changes here wait for a person to look. */
  eye: (
    <>
      <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
      <circle cx="8" cy="8" r="1.75" />
    </>
  ),
  comment: (
    <path d="M3 3.25h10a1 1 0 011 1v6a1 1 0 01-1 1H8l-3 2.5v-2.5H3a1 1 0 01-1-1v-6a1 1 0 011-1z" />
  ),
  /** A question waiting for an answer. */
  ask: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.4 6.3a1.7 1.7 0 113 1.1c-.6.5-1.4.8-1.4 1.6" />
      <path d="M8 11.1v.15" />
    </>
  ),
  /** Proposals waiting for review: a checklist. */
  review: (
    <>
      <path d="M2.5 4.25l1.25 1.25 2-2.25M2.5 10.25l1.25 1.25 2-2.25" />
      <path d="M8 4.5h5.5M8 10.5h5.5" />
    </>
  ),
  /** History: a clock with a hand turning back. */
  history: (
    <>
      <path d="M2.75 8a5.25 5.25 0 101.55-3.7" />
      <path d="M2.5 2.5v2.25h2.25" />
      <path d="M8 5.25V8l1.75 1.25" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
    </>
  ),
  play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  /** Waiting for a person: an hourglass. */
  hourglass: (
    <>
      <path d="M4.5 2.5h7M4.5 13.5h7" />
      <path d="M5.5 2.5c0 3 5 3 5 5.5s-5 2.5-5 5.5M10.5 2.5c0 3-5 3-5 5.5s5 2.5 5 5.5" />
    </>
  ),
  /** An idle agent: an open circle. */
  idle: <circle cx="8" cy="8" r="3.5" />,
  /** Pan the view to something. */
  locate: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75v2.5M8 11.75v2.5M1.75 8h2.5M11.75 8h2.5" />
    </>
  ),
  // status shapes; filled parts use a nested element with fill
  statusTodo: <circle cx="8" cy="8" r="5" />,
  statusProgress: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M8 3a5 5 0 010 10z" fill="currentColor" stroke="none" />
    </>
  ),
  statusBlocked: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M4.5 11.5l7-7" />
    </>
  ),
  statusDone: (
    <>
      <circle cx="8" cy="8" r="5.5" fill="currentColor" stroke="none" />
      <path d="M5.5 8.25l1.75 1.75 3.25-3.75" stroke="var(--card, #fff)" />
    </>
  ),
  statusCancelled: (
    <>
      <circle cx="8" cy="8" r="5" strokeDasharray="2 2" />
      <path d="M5.5 8h5" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
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
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The OpenBoard mark from assets/logo.svg. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="15" fill="var(--accent)" />
      <path
        d="M34 14H22a8 8 0 0 0-8 8v20a8 8 0 0 0 8 8h20a8 8 0 0 0 8-8V30"
        fill="none"
        stroke="#fff"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path d="M26.5 37.5 43 21" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
      <circle cx="25" cy="39" r="4.5" fill="#fff" />
      <circle cx="45.5" cy="18.5" r="6" fill="#fff" />
    </svg>
  );
}
