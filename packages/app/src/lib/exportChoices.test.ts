import { describe, expect, it } from 'vitest';
import { parseServerInfo } from './api.js';
import { BUILTIN_EXPORTS, exportChoices, importChoices, importerForFile } from './exportChoices.js';

const raw = {
  version: '1.2.0',
  projectName: 'shop',
  url: 'http://127.0.0.1:4747',
  shared: true,
  plugins: [{ name: 'estimates', version: '0.1.0', warnings: ['x:estimate is declared twice'] }],
  exporters: [
    {
      name: 'json',
      extension: '.json',
      mime: 'application/json',
      description: '',
      source: 'builtin',
    },
    {
      name: 'csv',
      extension: '.csv',
      mime: 'text/csv',
      description: 'Estimates as CSV',
      source: 'plugin',
      plugin: 'estimates',
    },
    { name: 'BAD NAME', extension: '.x', source: 'plugin', plugin: 'evil' },
  ],
  importers: [
    { name: 'mermaid', extensions: ['.mmd'], description: '', source: 'builtin' },
    {
      name: 'opml',
      extensions: ['opml', '.OPML'],
      description: 'Outlines',
      source: 'plugin',
      plugin: 'outline',
    },
  ],
};

describe('server info with plugins', () => {
  it('reads plugins, exporters and importers defensively', () => {
    const info = parseServerInfo(raw);
    expect(info?.shared).toBe(true);
    expect(info?.plugins).toEqual([
      { name: 'estimates', version: '0.1.0', warnings: ['x:estimate is declared twice'] },
    ]);
    expect(info?.exporters.map((e) => e.name)).toEqual(['json', 'csv']);
    expect(info?.importers[1]).toEqual({
      name: 'opml',
      description: 'Outlines',
      extensions: ['.opml', '.opml'],
      source: 'plugin',
      plugin: 'outline',
    });
    const bare = parseServerInfo({ version: '1' });
    expect(bare).toMatchObject({ shared: false, plugins: [], exporters: [], importers: [] });
  });
});

describe('export menu', () => {
  it('lists the built-in formats, then plugin ones with their plugin', () => {
    const choices = exportChoices(parseServerInfo(raw));
    expect(choices.slice(0, BUILTIN_EXPORTS.length)).toEqual(BUILTIN_EXPORTS);
    expect(choices.slice(BUILTIN_EXPORTS.length)).toEqual([
      { label: 'CSV', format: 'csv', plugin: 'estimates' },
    ]);
    expect(exportChoices(null)).toEqual(BUILTIN_EXPORTS);
  });

  it('lets the import dialog take plugin formats, picked by file extension', () => {
    const choices = importChoices(parseServerInfo(raw));
    expect(choices.map((c) => c.id)).toEqual(['mermaid', 'jsoncanvas', 'opml']);
    expect(importerForFile(choices, 'Plan.OPML')).toBe('opml');
    // Built-in formats are left to detection, which also reads the text.
    expect(importerForFile(choices, 'flow.mmd')).toBeNull();
  });
});
