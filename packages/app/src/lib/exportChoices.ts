/** The formats the board menu offers: the built-in ones, then any a server plugin adds. */
import type { ServerInfo } from './api.js';

export interface ExportChoice {
  /** Menu text. */
  label: string;
  format: string;
  theme?: 'light' | 'dark';
  /** The plugin that adds it, shown as a quiet suffix. */
  plugin?: string;
}

export const BUILTIN_EXPORTS: readonly ExportChoice[] = [
  { label: 'JSON (the board file)', format: 'json' },
  { label: 'Markdown', format: 'markdown' },
  { label: 'Mermaid', format: 'mermaid' },
  { label: 'JSON Canvas', format: 'jsoncanvas' },
  { label: 'SVG, light', format: 'svg', theme: 'light' },
  { label: 'SVG, dark', format: 'svg', theme: 'dark' },
];

const BUILTIN_FORMATS = new Set(['json', 'markdown', 'mermaid', 'jsoncanvas', 'svg']);

function shout(name: string): string {
  return name.length <= 4 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1);
}

export function exportChoices(info: Pick<ServerInfo, 'exporters'> | null): ExportChoice[] {
  const out = [...BUILTIN_EXPORTS];
  for (const e of info?.exporters ?? []) {
    if (e.source !== 'plugin' || BUILTIN_FORMATS.has(e.name)) continue;
    const choice: ExportChoice = { label: shout(e.name), format: e.name };
    if (e.plugin) choice.plugin = e.plugin;
    out.push(choice);
  }
  return out;
}

export interface ImportFormatChoice {
  id: string;
  name: string;
  extensions: string[];
  plugin?: string;
}

export const BUILTIN_IMPORTS: readonly ImportFormatChoice[] = [
  { id: 'mermaid', name: 'Mermaid flowchart', extensions: ['.mmd', '.mermaid'] },
  { id: 'jsoncanvas', name: 'JSON Canvas', extensions: ['.canvas'] },
];

export function importChoices(info: Pick<ServerInfo, 'importers'> | null): ImportFormatChoice[] {
  const out = [...BUILTIN_IMPORTS];
  for (const i of info?.importers ?? []) {
    if (i.source !== 'plugin' || out.some((o) => o.id === i.name)) continue;
    const choice: ImportFormatChoice = {
      id: i.name,
      name: shout(i.name),
      extensions: i.extensions,
    };
    if (i.plugin) choice.plugin = i.plugin;
    out.push(choice);
  }
  return out;
}

/** A plugin importer whose extension matches the file name, if any. */
export function importerForFile(
  choices: readonly ImportFormatChoice[],
  filename: string,
): string | null {
  const lower = filename.toLowerCase();
  const found = choices.find((c) => c.plugin && c.extensions.some((e) => lower.endsWith(e)));
  return found?.id ?? null;
}
