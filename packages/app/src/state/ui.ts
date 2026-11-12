/** UI state that belongs to one open board but not to the document. */
import { isBoolean, readStored, writeStored } from '../lib/storage.js';
import { Value } from './emitter.js';

export type ConfirmRequest = {
  title: string;
  body?: string;
  /** Buttons from least to most destructive; the last one is the primary action. */
  actions: Array<{ label: string; tone?: 'danger' | 'primary'; run: () => void }>;
};

/**
 * Follow mode: `on` fits the view to each burst of changes by others;
 * `paused` is on, but held back because the person moved the view themselves.
 */
export type FollowState = 'off' | 'on' | 'paused';

/** Below this width the inspector overlays the canvas, so it starts closed. */
const NARROW_WIDTH = 960;

export class UiStore {
  /** Node whose title is being edited inline. */
  readonly editing = new Value<string | null>(null);
  /** Frame highlighted as the drop target while dragging. */
  readonly dropTarget = new Value<string | null>(null);
  readonly palette = new Value<{ open: boolean; query: string }>({ open: false, query: '' });
  readonly shortcuts = new Value(false);
  readonly minimap = new Value(readStored('minimap', isBoolean) ?? false);
  readonly confirm = new Value<ConfirmRequest | null>(null);
  readonly newBoard = new Value(false);
  readonly connectAgent = new Value(false);
  readonly follow = new Value<FollowState>(readStored('follow', isBoolean) ? 'on' : 'off');
  /** Open panel id per side; the panel registry decides what can go there. */
  readonly leftPanel = new Value<string | null>(null);
  readonly inspectorOpen = new Value(
    typeof window === 'undefined' || window.innerWidth >= NARROW_WIDTH,
  );
  /** Last pointer position over the canvas, in canvas coordinates (not observable). */
  lastPointer: { x: number; y: number } | null = null;

  constructor() {
    this.minimap.subscribe(() => writeStored('minimap', this.minimap.get()));
    // Pausing is not a preference; only on and off are remembered.
    this.follow.subscribe(() => writeStored('follow', this.follow.get() !== 'off'));
  }

  /** The person moved the view: hold follow mode back until they turn it on again. */
  pauseFollow(): void {
    if (this.follow.get() === 'on') this.follow.set('paused');
  }

  openPalette(query = ''): void {
    this.palette.set({ open: true, query });
  }

  closePalette(): void {
    this.palette.set({ open: false, query: '' });
  }

  /** True when a modal surface is open and canvas shortcuts should stay quiet. */
  modalOpen(): boolean {
    return (
      this.palette.get().open ||
      this.shortcuts.get() ||
      this.confirm.get() !== null ||
      this.newBoard.get() ||
      this.connectAgent.get()
    );
  }
}
