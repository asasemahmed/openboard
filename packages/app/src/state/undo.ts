/** Undo and redo of this person's own changes, scoped by `BoardDoc.createUndoManager`. */
import type { BoardDoc } from '@openboard/core';
import type * as Y from 'yjs';
import { Emitter } from './emitter.js';

export interface UndoSnapshot {
  canUndo: boolean;
  canRedo: boolean;
}

export class UndoController extends Emitter {
  private manager: Y.UndoManager;
  private snapshot: UndoSnapshot = { canUndo: false, canRedo: false };
  private readonly doc: BoardDoc;
  private readonly onStack = () => this.refresh();

  constructor(doc: BoardDoc, actorId: string) {
    super();
    this.doc = doc;
    this.manager = this.create(actorId);
  }

  private create(actorId: string): Y.UndoManager {
    const manager = this.doc.createUndoManager(actorId);
    manager.on('stack-item-added', this.onStack);
    manager.on('stack-item-popped', this.onStack);
    manager.on('stack-cleared', this.onStack);
    return manager;
  }

  private refresh(): void {
    const next = { canUndo: this.manager.canUndo(), canRedo: this.manager.canRedo() };
    if (next.canUndo !== this.snapshot.canUndo || next.canRedo !== this.snapshot.canRedo) {
      this.snapshot = next;
      this.emit();
    }
  }

  readonly get = (): UndoSnapshot => this.snapshot;

  undo(): boolean {
    return this.manager.undo() !== null;
  }

  redo(): boolean {
    return this.manager.redo() !== null;
  }

  destroy(): void {
    this.manager.destroy();
  }
}
