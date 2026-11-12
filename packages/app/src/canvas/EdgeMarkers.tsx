/**
 * SVG markers for edge ends, one per shape and colour tone. Edges refer to
 * them as `url(#ob-m-<shape>-<tone>)`.
 */
import type { EdgeMarker } from '../lib/edgeTypes.js';

export const MARKER_TONES = ['muted', 'ink', 'danger', 'accent'] as const;
export type MarkerTone = (typeof MARKER_TONES)[number];

export function markerUrl(shape: EdgeMarker, tone: MarkerTone): string | undefined {
  return shape === 'none' ? undefined : `url(#ob-m-${shape}-${tone})`;
}

function Shape({ shape, color }: { shape: Exclude<EdgeMarker, 'none'>; color: string }) {
  switch (shape) {
    case 'arrow':
      return (
        <path
          d="M1 1L9 5L1 9z"
          fill={color}
          stroke={color}
          strokeWidth="1"
          strokeLinejoin="round"
        />
      );
    case 'open':
      return (
        <path
          d="M1.5 1.5L8.5 5L1.5 8.5"
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'hollow':
      return (
        <path
          d="M1.5 1.5L8.5 5L1.5 8.5z"
          fill="var(--canvas)"
          stroke={color}
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      );
    case 'tee':
      return <path d="M8 0.5V9.5" stroke={color} strokeWidth="2" strokeLinecap="round" />;
    case 'dot':
      return <circle cx="5" cy="5" r="3" fill={color} />;
  }
}

const SHAPES = ['arrow', 'open', 'hollow', 'tee', 'dot'] as const;

export function EdgeMarkers() {
  return (
    <svg className="edge-markers" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        {SHAPES.map((shape) =>
          MARKER_TONES.map((tone) => (
            <marker
              key={`${shape}-${tone}`}
              id={`ob-m-${shape}-${tone}`}
              viewBox="0 0 10 10"
              refX={shape === 'tee' ? 8 : shape === 'dot' ? 5 : 8.5}
              refY="5"
              markerWidth="10"
              markerHeight="10"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <Shape shape={shape} color={`var(--edge-${tone})`} />
            </marker>
          )),
        )}
      </defs>
    </svg>
  );
}
