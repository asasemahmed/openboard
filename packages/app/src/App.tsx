import { useEffect, useRef } from 'react';
import { joinLink } from './joinToken.js';
import { onUnauthorized } from './lib/api.js';
import { useRoute } from './lib/router.js';
import { JoinScreen, SignedOutScreen } from './shell/AccessScreens.js';
import { BoardScreen } from './shell/BoardScreen.js';
import { HomeScreen } from './shell/HomeScreen.js';
import { StateScreen } from './shell/StateScreen.js';
import { access, loadAccess, signedOut, useAccess } from './state/access.js';
import { api, loadServerInfo, serverInfo } from './state/boards.js';
import { useValue } from './state/emitter.js';
import { adoptServerName, currentActor } from './state/identity.js';
import { Toasts } from './ui/Toasts.js';

// Any 401, from any request, means this browser is signed out: stop and say so.
onUnauthorized((message) => signedOut('unauthorized', message));

export function App() {
  const route = useRoute();
  const state = useAccess();
  const link = useValue(joinLink);
  // Reopen the last board only when the app starts at "/", not when someone navigates back to the list.
  const firstRoute = useRef(route);

  // Who are we? Asked first, before anything else talks to the server (a join does its own).
  useEffect(() => {
    if (route.name === 'join' || access.get().status !== 'loading') return;
    void loadAccess(api, currentActor);
  }, [route.name]);

  // A new person is called what the server calls its user, until they pick a name.
  useEffect(() => {
    if (state.status !== 'ready') return;
    void loadServerInfo().then(() => adoptServerName(serverInfo.get()?.user));
  }, [state.status]);

  // An invite link always gets its own page, even when already signed in (it may be another grant).
  if (route.name === 'join' && (state.status !== 'ready' || link.token !== null))
    return <JoinScreen />;
  if (state.status === 'signed-out') return <SignedOutScreen state={state} />;
  if (state.status === 'loading') return <StateScreen title="Opening…" busy />;
  if (route.name === 'board') {
    return (
      <>
        <BoardScreen key={route.boardId} boardId={route.boardId} />
        <Toasts />
      </>
    );
  }
  return <HomeScreen resumeLast={firstRoute.current === route} />;
}
