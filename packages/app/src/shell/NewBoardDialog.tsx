import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '../lib/api.js';
import { boardPath, navigate } from '../lib/router.js';
import { boards } from '../state/boards.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';

export function NewBoardForm({ onDone, onCancel }: { onDone?: () => void; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const descId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) {
      setError('Give the board a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const board = await boards.create({
        name: clean,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onDone?.();
      navigate(boardPath(board.id));
    } catch (err) {
      setError(
        err instanceof ApiError && err.unreachable
          ? 'The server is not reachable, so the board could not be created.'
          : err instanceof Error
            ? err.message
            : 'The board could not be created.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="new-board-form" onSubmit={submit}>
      <div className="field">
        <label className="field-label" htmlFor={nameId}>
          Name
        </label>
        <input
          id={nameId}
          className="input"
          value={name}
          maxLength={120}
          placeholder="Checkout redesign"
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={descId}>
          What is it for? <span className="muted">(optional)</span>
        </label>
        <textarea
          id={descId}
          className="input"
          rows={3}
          maxLength={2000}
          value={description}
          placeholder="Agents read this before anything else on the board."
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create board'}
        </Button>
      </div>
    </form>
  );
}

export function NewBoardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="New board">
      <NewBoardForm onDone={onClose} onCancel={onClose} />
    </Dialog>
  );
}
