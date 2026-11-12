/**
 * The pages around access in shared mode: joining from an invite link, and
 * the calm page shown when this browser is signed out or its access ended.
 */
import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { forgetJoinToken, joinLink, joinToken } from '../joinToken.js';
import { ApiError, retryAfterSeconds } from '../lib/api.js';
import { initialJoin, joinReducer } from '../lib/join.js';
import { ROLE_TEXT } from '../lib/roles.js';
import { navigate } from '../lib/router.js';
import { type AccessState, setWho } from '../state/access.js';
import { api } from '../state/boards.js';
import { useValue } from '../state/emitter.js';
import { identity, updateIdentity, useIdentity } from '../state/identity.js';
import { Button } from '../ui/Button.js';
import { StateScreen } from './StateScreen.js';

/** One join attempt per invite link; a new link (even on the same page) starts afresh. */
export function JoinScreen() {
  const { attempt } = useValue(joinLink);
  return <JoinFlow key={attempt} />;
}

function JoinFlow() {
  const [token] = useState(joinToken);
  const [state, dispatch] = useReducer(joinReducer, token, initialJoin);
  const me = useIdentity();
  const [name, setName] = useState(me.named ? me.name : '');
  const [wait, setWait] = useState(0);
  const nameId = useId();
  const attempt = useRef(0);

  useEffect(() => {
    if (state.step !== 'joining' || !token) return;
    const n = ++attempt.current;
    const remembered = identity.get().named ? identity.get().name : undefined;
    api
      .signIn(token, remembered)
      .then((who) => {
        if (n !== attempt.current) return;
        forgetJoinToken();
        dispatch({ type: 'joined', who });
        if (!identity.get().named) setName(who.actor.name);
      })
      .catch((error: unknown) => {
        if (n !== attempt.current) return;
        const e = error instanceof ApiError ? error : null;
        // A link that is not valid will not become valid: drop it. A rate limit or a
        // network failure may pass, so the token stays for one more try.
        if (e && e.status !== 429 && e.code !== 'unreachable') forgetJoinToken();
        dispatch({
          type: 'failed',
          status: e?.status ?? 0,
          code: e?.code ?? 'unreachable',
          message: e?.message ?? '',
          retryAfter: retryAfterSeconds(error),
        });
      });
  }, [state.step, token]);

  // Count down to when trying again makes sense.
  useEffect(() => {
    if (state.step !== 'rate-limited') return;
    setWait(state.retryAfter ?? 30);
    const timer = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(timer);
  }, [state]);

  if (state.step === 'joining')
    return (
      <StateScreen title="Joining…" busy>
        {null}
      </StateScreen>
    );

  if (state.step === 'joined') {
    const role = ROLE_TEXT[state.who.role];
    const finish = () => {
      if (name.trim()) updateIdentity({ name });
      setWho(state.who);
      navigate('/', { replace: true });
    };
    return (
      <StateScreen
        title="You’re in"
        actions={
          <Button variant="primary" onClick={finish}>
            Open the boards
          </Button>
        }
      >
        <p>
          {role.you}{' '}
          {state.who.expiresAt
            ? `Your access lasts until ${new Date(state.who.expiresAt).toLocaleString()}.`
            : ''}
        </p>
        <form
          className="field join-name"
          onSubmit={(event) => {
            event.preventDefault();
            finish();
          }}
        >
          <label htmlFor={nameId} className="field-label">
            Your name, as others see it
          </label>
          <input
            id={nameId}
            className="input"
            value={name}
            maxLength={80}
            autoComplete="name"
            aria-describedby={`${nameId}-hint`}
            onFocus={(event) => event.target.select()}
            onChange={(event) => setName(event.target.value)}
          />
          <p id={`${nameId}-hint`} className="field-hint">
            Change it if this is not you. You can rename yourself later from your profile.
          </p>
        </form>
      </StateScreen>
    );
  }

  const retry = () => dispatch({ type: 'start' });
  const content = {
    'no-token': {
      title: 'This invite link is incomplete',
      body: 'The part after the # is missing. Open the full link you were sent, or ask the person who shared the board for a new one.',
    },
    invalid: {
      title: 'This invite link does not work',
      body: 'It is wrong, has expired, or was revoked. Ask the person who shared the board for a new link.',
    },
    'rate-limited': {
      title: 'Too many attempts',
      body: wait > 0 ? `Try again in ${wait} seconds.` : 'You can try again now.',
    },
    unreachable: {
      title: 'The server is not reachable',
      body: 'Check that the board’s server is running and that this address is right, then try again.',
    },
    'not-shared': {
      title: 'This server is not shared',
      body: 'It only takes people at its own machine, so no invite is needed there. Ask for the address of the shared server.',
    },
  }[state.step];
  return (
    <StateScreen
      title={content.title}
      actions={
        (state.step === 'rate-limited' || state.step === 'unreachable') && joinToken() ? (
          <Button
            variant="primary"
            disabled={state.step === 'rate-limited' && wait > 0}
            onClick={retry}
          >
            Try again
          </Button>
        ) : undefined
      }
    >
      <p>{content.body}</p>
    </StateScreen>
  );
}

const SIGNED_OUT_TEXT = {
  revoked: 'Your access to these boards has ended: it was revoked or it expired.',
  unauthorized:
    'The server no longer recognises this browser: you are signed out, or your access ended.',
  'signed-out': 'You signed out of these boards.',
} as const;

/** Nothing of the boards is shown here: the page says what happened and how to get back in. */
export function SignedOutScreen({
  state,
}: {
  state: Extract<AccessState, { status: 'signed-out' }>;
}) {
  return (
    <StateScreen title="Your access has ended or you are signed out">
      <p>{SIGNED_OUT_TEXT[state.reason]}</p>
      {state.lostEdits && (
        <p>
          <strong>Some of your latest edits had not reached the server</strong> and were not saved.
        </p>
      )}
      <p>To come back, open an invite link from the person who shares these boards.</p>
    </StateScreen>
  );
}
