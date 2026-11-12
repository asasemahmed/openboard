import { useRef } from 'react';
import { useRoute } from './lib/router.js';
import { BoardScreen } from './shell/BoardScreen.js';
import { HomeScreen } from './shell/HomeScreen.js';
import { Toasts } from './ui/Toasts.js';

export function App() {
  const route = useRoute();
  // Reopen the last board only when the app starts at "/", not when someone navigates back to the list.
  const firstRoute = useRef(route);
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
