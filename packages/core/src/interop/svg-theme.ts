/**
 * Colours for the static SVG renderer, matching the canvas tokens. A card is
 * filled with a tint of its type's colour, as on the canvas: `fills`,
 * `fillLines` and `types` are the canvas's per-type hue (see tokens.css in
 * the app) at this theme's lightness, written out as hex so the picture
 * needs nothing but itself. Type labels keep at least 4.5:1 against their
 * fill in both themes; the diff colours were picked the same way.
 */
import type { Status } from '../schema.js';

export interface SvgTheme {
  paper: string;
  canvas: string;
  grid: string;
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
  /** Label and glyph colour per built-in node type; `custom` for `x:` types. */
  types: Record<string, string>;
  /** Card fill per type, and the slightly deeper edge around it. */
  fills: Record<string, string>;
  fillLines: Record<string, string>;
  /** Patches on a coloured card: behind a status, and behind a tag. */
  chip: { color: string; opacity: number };
  chipQuiet: { color: string; opacity: number };
  status: Record<Status, string>;
  edge: { muted: string; ink: string; danger: string };
  diff: { added: string; removed: string; updated: string; moved: string; onBadge: string };
}

export const SVG_FONT_SANS =
  "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
export const SVG_FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const LIGHT_THEME: SvgTheme = {
  paper: '#FBFAF7',
  canvas: '#F8F7F4',
  grid: '#ECEBE6',
  card: '#FFFFFF',
  frameFill: '#15171A',
  frameFillOpacity: 0.035,
  line: '#DEDAD1',
  lineStrong: '#C9C4B9',
  ink: '#15171A',
  ink2: '#5F646D',
  ink3: '#747983',
  sunken: '#F1EEE7',
  accent: '#FF5A1F',
  types: {
    note: '#644D00',
    task: '#006236',
    decision: '#43468D',
    question: '#005687',
    risk: '#82341A',
    doc: '#5F4C33',
    code: '#006168',
    agent: '#7E3053',
    run: '#653A7D',
    frame: '#554F45',
    custom: '#554F45',
  },
  fills: {
    note: '#FFEDA7',
    task: '#CDF9DE',
    decision: '#E3EAFF',
    question: '#CAF3FF',
    risk: '#FFDFCE',
    doc: '#F6EBDC',
    code: '#C0F9FC',
    agent: '#FFDDEF',
    run: '#FAE2FF',
    frame: '#F0ECE6',
    custom: '#F0ECE6',
  },
  fillLines: {
    note: '#EED579',
    task: '#ADE5C3',
    decision: '#CAD2FF',
    question: '#A8DEFF',
    risk: '#FFC4AF',
    doc: '#E2D4C1',
    code: '#99E5E9',
    agent: '#FFC2D8',
    run: '#E7C8FA',
    frame: '#DAD5CE',
    custom: '#DAD5CE',
  },
  chip: { color: '#FFFFFF', opacity: 0.66 },
  chipQuiet: { color: '#15171A', opacity: 0.07 },
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
  grid: '#181B20',
  card: '#171A1F',
  frameFill: '#F3F1EC',
  frameFillOpacity: 0.05,
  line: '#2A2E35',
  lineStrong: '#3A3F48',
  ink: '#F3F1EC',
  ink2: '#9A9FA8',
  ink3: '#868B94',
  sunken: '#0E1013',
  accent: '#FF5A1F',
  types: {
    note: '#E2CE80',
    task: '#94E2B5',
    decision: '#BEC8FF',
    question: '#8DD8FF',
    risk: '#FFB79E',
    doc: '#DECBB1',
    code: '#76E2E7',
    agent: '#FFB3D1',
    run: '#E4BBFE',
    frame: '#D3CDC3',
    custom: '#D3CDC3',
  },
  fills: {
    note: '#342900',
    task: '#163022',
    decision: '#25283F',
    question: '#142D3C',
    risk: '#3E2219',
    doc: '#2F2921',
    code: '#0A3032',
    agent: '#3B212B',
    run: '#312439',
    frame: '#2C2A27',
    custom: '#2C2A27',
  },
  fillLines: {
    note: '#4F3E00',
    task: '#214933',
    decision: '#383C5F',
    question: '#1D445C',
    risk: '#5D3225',
    doc: '#473E32',
    code: '#07494C',
    agent: '#593241',
    run: '#4A3657',
    frame: '#423F3A',
    custom: '#423F3A',
  },
  chip: { color: '#000000', opacity: 0.26 },
  chipQuiet: { color: '#F3F1EC', opacity: 0.1 },
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
