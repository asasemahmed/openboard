import { createContext, type ReactNode, useContext } from 'react';
import { useStoreValue } from './emitter.js';
import type { BoardSession } from './session.js';

const SessionContext = createContext<BoardSession | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  session: BoardSession;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): BoardSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside a SessionProvider');
  return session;
}

export function useSelection() {
  const { store } = useSession();
  return useStoreValue(store, store.getSelection);
}

export function useMeta() {
  const { store } = useSession();
  return useStoreValue(store, store.getMeta);
}

export function useConnection() {
  const { connection } = useSession();
  return useStoreValue(connection, connection.get);
}

export function useUndoState() {
  const { undo } = useSession();
  return useStoreValue(undo, undo.get);
}

/** A board node by id, re-rendering only when that node changes. */
export function useBoardNode(id: string | undefined) {
  const { store } = useSession();
  return useStoreValue(store, () => (id ? store.node(id) : undefined));
}

export function useBoardEdge(id: string | undefined) {
  const { store } = useSession();
  return useStoreValue(store, () => (id ? store.edge(id) : undefined));
}
