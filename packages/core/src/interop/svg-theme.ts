/**
 * Colours for the static SVG renderer, matching the canvas tokens and the
 * banners in assets/. Type and status colours keep at least 4.5:1 against the
 * card in both themes; the diff colours were picked the same way.
 */
import type { Status } from '../schema.js';

export interface SvgTheme {
  paper: string;
  canvas: string;
  dot: string;
  card: string;
  frameFill: string;
  frameFillOpacity: number;
  line: string;
  lineStrong: string;
  ink: string;
  ink2: string;
  ink3: string;
  sunken: string;
  accent: string;
  /** Label and dot colour per built-in node type; `custom` for `x:` types. */
  types: Record<string, string>;
  status: Record<Status, string>;
  edge: { muted: string; ink: string; danger: string };
  diff: { added: string; removed: string; updated: string; moved: string; onBadge: string };
}

export const SVG_FONT_SANS =
  "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
export const SVG_FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const LIGHT_THEME: SvgTheme = {
  paper: '#FBFAF7',
  canvas: '#F4F1EA',
  dot: '#DCD8CE',
  card: '#FFFFFF',
  frameFill: '#FFFFFF',
  frameFillOpacity: 0.42,
  line: '#DEDAD1',
  lineStrong: '#C9C4B9',
  ink: '#15171A',
  ink2: '#5F646D',
  ink3: '#747983',
  sunken: '#F1EEE7',
  accent: '#FF5A1F',
  types: {
    note: '#15171A',
    task: '#0B7A55',
    decision: '#3B4CC0',
    question: '#1663A6',
    risk: '#C2410C',
    doc: '#8A5A00',
    code: '#0E6E86',
    agent: '#B0306B',
    run: '#6B46C1',
    frame: '#5F646D',
    custom: '#5F646D',
  },
  status: {
    todo: '#5F646D',
    in_progress: '#C2410C',
    blocked: '#B42318',
    done: '#0B7A55',
    cancelled: '#747983',
  },
  edge: { muted: '#8A8F98', ink: '#5F646D', danger: '#B42318' },
  diff: {
    added: '#0B7A55',
    removed: '#B42318',
    updated: '#B45309',
    moved: '#747983',
    onBadge: '#FFFFFF',
  },
};

export const DARK_THEME: SvgTheme = {
  paper: '#0E1013',
  canvas: '#121519',
  dot: '#262A31',
  card: '#171A1F',
  frameFill: '#F3F1EC',
  frameFillOpacity: 0.025,
  line: '#2A2E35',
  lineStrong: '#3A3F48',
  ink: '#F3F1EC',
  ink2: '#9A9FA8',
  ink3: '#868B94',
  sunken: '#0E1013',
  accent: '#FF5A1F',
  types: {
    note: '#F3F1EC',
    task: '#3DDC97',
    decision: '#9AA6FF',
    question: '#6CB6FF',
    risk: '#FF7A45',
    doc: '#E8B54A',
    code: '#4FD1E8',
    agent: '#F28AC0',
    run: '#B79CFF',
    frame: '#9A9FA8',
    custom: '#9A9FA8',
  },
  status: {
    todo: '#9A9FA8',
    in_progress: '#FF7A45',
    blocked: '#FF6B5E',
    done: '#3DDC97',
    cancelled: '#868B94',
  },
  edge: { muted: '#666C76', ink: '#9A9FA8', danger: '#FF6B5E' },
  diff: {
    added: '#3DDC97',
    removed: '#FF6B5E',
    updated: '#F5B942',
    moved: '#868B94',
    onBadge: '#0E1013',
  },
};
