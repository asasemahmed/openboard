import { type AccessAction, can } from '@openboard/core';
/**
 * Cmd/Ctrl+K: find a node by title, id or tag and jump to it, or run a
 * command (add a node, tidy up, switch theme or board).
 */
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useActions } from '../canvas/actions.js';
import { fuzzyScore, searchNodes } from '../lib/fuzzy.js';
import { ADDABLE_TYPES, STATUS_META, typeMeta } from '../lib/nodeTypes.js';
import { boardPath, navigate } from '../lib/router.js';
import { setThemePref, type ThemePref } from '../lib/theme.js';
import { useRole } from '../state/access.js';
import { boards, useBoards } from '../state/boards.js';
import { useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { Kbd } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { TypeDot } from './AddMenu.js';
import { THEME_NAMES } from './ThemeToggle.js';

interface Item {
  id: string;
  group: 'Nodes' | 'Commands' | 'Boards';
  label: string;
  detail?: string;
  lead: ReactNode;
  shortcut?: string;
  keywords?: string;
  run: () => void;
}

const MAX_NODES = 8;
const MAX_OTHER = 6;

function icon(name: IconName) {
  return <Icon name={name} />;
}

/** What a command needs beyond reading the board (`add:<type>` commands need `board.edit`). */
const COMMAND_NEEDS: Record<string, AccessAction> = {
  tidy: 'board.edit',
  'tidy-all': 'board.edit',
  undo: 'board.undo',
  redo: 'board.undo',
  import: 'board.edit',
  'new-board': 'board.create',
};

export function CommandPalette() {
  const session = useSession();
  const { ui, store } = session;
  const state = useValue(ui.palette);
  const actions = useActions();
  const role = useRole();
  const list = useBoards();
  const [query, setQuery] = useState(state.query);
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.open) {
      setQuery(state.query);
      setActive(0);
      void boards.refresh();
    }
  }, [state.open, state.query]);

  const close = () => ui.closePalette();

  const commands = useMemo<Item[]>(() => {
    const out: Item[] = ADDABLE_TYPES.map((type) => {
      const meta = typeMeta(type);
      return {
        id: `add:${type}`,
        group: 'Commands',
        label: type === 'frame' ? 'Frame the selection' : `New ${meta.name.toLowerCase()}`,
        detail: meta.hint,
        lead: <TypeDot type={type} />,
        ...(meta.key ? { shortcut: meta.key } : {}),
        keywords: `add create ${type}`,
        run: () =>
          type === 'frame' ? actions.frameSelection() : actions.addNode(type, actions.viewCenter()),
      };
    });
    out.push(
      {
        id: 'tidy',
        group: 'Commands',
        label: 'Tidy up',
        detail: 'Lay out everything nobody pinned',
        lead: icon('layout'),
        keywords: 'layout arrange',
        run: () => void actions.tidy('unpinned'),
      },
      {
        id: 'tidy-all',
        group: 'Commands',
        label: 'Tidy everything…',
        detail: 'Also moves and unpins pinned nodes',
        lead: icon('layout'),
        keywords: 'layout arrange all',
        run: () =>
          ui.confirm.set({
            title: 'Tidy everything?',
            body: 'This also moves nodes that you or others placed by hand, and unpins them. Undo does not reverse a layout.',
            actions: [
              { label: 'Cancel', run: () => {} },
              { label: 'Tidy everything', tone: 'primary', run: () => void actions.tidy('all') },
            ],
          }),
      },
      {
        id: 'fit',
        group: 'Commands',
        label: 'Fit board in view',
        lead: icon('fit'),
        shortcut: 'shift+1',
        keywords: 'zoom',
        run: actions.fit,
      },
      {
        id: 'minimap',
        group: 'Commands',
        label: ui.minimap.get() ? 'Hide mini map' : 'Show mini map',
        lead: icon('minimap'),
        run: () => ui.minimap.set(!ui.minimap.get()),
      },
      {
        id: 'select-all',
        group: 'Commands',
        label: 'Select everything',
        lead: icon('boards'),
        shortcut: 'mod+a',
        run: () => store.selectAll(),
      },
      {
        id: 'undo',
        group: 'Commands',
        label: 'Undo',
        lead: icon('undo'),
        shortcut: 'mod+z',
        run: actions.undo,
      },
      {
        id: 'redo',
        group: 'Commands',
        label: 'Redo',
        lead: icon('redo'),
        shortcut: 'shift+mod+z',
        run: actions.redo,
      },
      ...(['system', 'light', 'dark'] as ThemePref[]).map(
        (pref): Item => ({
          id: `theme:${pref}`,
          group: 'Commands',
          label: `Theme: ${THEME_NAMES[pref]}`,
          lead: icon(pref === 'system' ? 'system' : pref === 'light' ? 'sun' : 'moon'),
          keywords: 'appearance dark light mode',
          run: () => setThemePref(pref),
        }),
      ),
      {
        id: 'import',
        group: 'Commands',
        label: 'Import…',
        detail: 'A Mermaid flowchart or a JSON Canvas',
        lead: icon('plus'),
        keywords: 'import mermaid canvas obsidian paste file',
        run: () => ui.importDialog.set({}),
      },
      {
        id: 'compare',
        group: 'Commands',
        label: 'Compare with a git revision…',
        detail: 'What changed since a commit of the board',
        lead: icon('history'),
        keywords: 'compare diff git commit revision changes',
        run: () => ui.comparePicker.set(true),
      },
      {
        id: 'replay',
        group: 'Commands',
        label: 'Replay history',
        detail: 'Watch the board change, batch by batch',
        lead: icon('history'),
        keywords: 'replay history timeline past time travel playback',
        run: () => void session.replay.open(),
      },
      {
        id: 'connect-agent',
        group: 'Commands',
        label: 'Connect an agent…',
        detail: 'Claude Code, Cursor, Codex or any MCP client',
        lead: icon('agent'),
        keywords: 'mcp agent setup claude cursor codex install',
        run: () => ui.connectAgent.set(true),
      },
      {
        id: 'follow',
        group: 'Commands',
        label: ui.follow.get() === 'on' ? 'Stop following changes' : 'Follow changes',
        detail: 'Move the view to what others change',
        lead: icon('follow'),
        keywords: 'follow agent watch activity',
        run: () => ui.follow.set(ui.follow.get() === 'on' ? 'off' : 'on'),
      },
      {
        id: 'shortcuts',
        group: 'Commands',
        label: 'Keyboard shortcuts',
        lead: icon('keyboard'),
        shortcut: '?',
        run: () => ui.shortcuts.set(true),
      },
      {
        id: 'new-board',
        group: 'Commands',
        label: 'New board…',
        lead: icon('plus'),
        run: () => ui.newBoard.set(true),
      },
      {
        id: 'all-boards',
        group: 'Commands',
        label: 'All boards',
        lead: icon('boards'),
        run: () => navigate('/'),
      },
    );
    // Commands that change the board are not offered to people who may not.
    return out.filter((item) => {
      const needs = COMMAND_NEEDS[item.id] ?? (item.id.startsWith('add:') ? 'board.edit' : null);
      return needs === null || can(role, needs);
    });
  }, [actions, ui, store, role]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const boardItems: Item[] = list.boards
      .filter((b) => b.id !== session.boardId)
      .map((b) => ({
        id: `board:${b.id}`,
        group: 'Boards',
        label: b.name,
        detail: `${b.nodeCount} nodes`,
        lead: icon('boards'),
        run: () => navigate(boardPath(b.id)),
      }));
    if (!q)
      return [
        ...commands.slice(0, 2),
        ...commands.filter((c) => ['tidy', 'fit', 'connect-agent', 'shortcuts'].includes(c.id)),
        ...boardItems.slice(0, 3),
      ];

    const nodeItems: Item[] = searchNodes([...store.boardNodes().values()], q, MAX_NODES).map(
      (match) => {
        const meta = typeMeta(match.node.type);
        const detailParts = [meta.name];
        if (match.node.status) detailParts.push(STATUS_META[match.node.status].name);
        if (match.field === 'id') detailParts.push(match.node.id);
        if (match.field === 'tag') detailParts.push(`#${(match.node.tags ?? []).join(' #')}`);
        return {
          id: `node:${match.node.id}`,
          group: 'Nodes',
          label: match.node.title,
          detail: detailParts.join(', '),
          lead: <TypeDot type={match.node.type} />,
          run: () => actions.jumpTo(match.node.id),
        };
      },
    );
    const rank = (pool: Item[]) =>
      pool
        .map((item) => {
          const score = Math.max(
            fuzzyScore(q, item.label) ?? -1,
            (fuzzyScore(q, item.keywords ?? '') ?? -1) * 0.6,
          );
          return { item, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_OTHER)
        .map((r) => r.item);
    return [...nodeItems, ...rank(commands), ...rank(boardItems)];
  }, [query, commands, list.boards, session.boardId, store, actions]);

  const clamped = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${clamped}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [clamped]);

  const runItem = (item: Item | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  let lastGroup: string | null = null;

  return (
    <Dialog
      open={state.open}
      onClose={close}
      title="Search and commands"
      hideTitle
      size="md"
      className="palette"
    >
      <div className="palette-input-row">
        <Icon name="search" />
        <input
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items[clamped] ? `${listId}-${clamped}` : undefined}
          aria-label="Search nodes, commands and boards"
          placeholder="Find a node by title, id or tag, or type a command"
          value={query}
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((clamped + 1) % Math.max(1, items.length));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((clamped - 1 + items.length) % Math.max(1, items.length));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              runItem(items[clamped]);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        />
        <Kbd shortcut="esc" />
      </div>
      <div className="palette-list" role="listbox" id={listId} ref={listRef} aria-label="Results">
        {items.length === 0 && <p className="palette-empty">Nothing matches “{query}”.</p>}
        {items.map((item, index) => {
          const heading = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.id} role="presentation">
              {heading && (
                <div className="palette-group" role="presentation">
                  {query.trim() ? heading : heading === 'Commands' ? 'Suggestions' : heading}
                </div>
              )}
              <div
                id={`${listId}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === clamped}
                data-index={index}
                className={`palette-item${index === clamped ? ' is-active' : ''}`}
                onMouseMove={() => {
                  if (index !== clamped) setActive(index);
                }}
                onClick={() => runItem(item)}
                onKeyDown={() => {}}
              >
                <span className="palette-lead">{item.lead}</span>
                <span className="palette-label">{item.label}</span>
                {item.detail && <span className="palette-detail">{item.detail}</span>}
                {item.shortcut && <Kbd shortcut={item.shortcut} />}
              </div>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
