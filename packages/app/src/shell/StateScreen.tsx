import type { ReactNode } from 'react';
import { Button } from '../ui/Button.js';
import { Logo } from '../ui/Icon.js';

/** A full-page message: loading, errors, empty states. */
export function StateScreen({
  title,
  children,
  actions,
  busy,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
}) {
  return (
    <main className="state-screen" aria-busy={busy || undefined}>
      <div className="state-card">
        <Logo size={36} />
        <h1>{title}</h1>
        {children}
        {actions && <div className="state-actions">{actions}</div>}
      </div>
    </main>
  );
}

export function ServerUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <StateScreen
      title="Can’t reach the OpenBoard server"
      actions={
        <Button variant="primary" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      <p>Start it from your project folder, then try again:</p>
      <pre className="command">
        <span className="command-prompt">$</span> openboard start
      </pre>
    </StateScreen>
  );
}
