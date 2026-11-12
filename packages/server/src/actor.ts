/**
 * Who is calling. Over HTTP the actor arrives in `x-openboard-actor-*`
 * headers, over the WebSocket as `actorId`, `actorName` and `actorKind` query
 * parameters (see "HTTP surface" in docs/ARCHITECTURE.md).
 */
import { type Actor, ActorSchema, OpenBoardError } from '@openboard/core';

/** Used for HTTP callers that do not say who they are. */
export const ANONYMOUS_AGENT: Actor = { id: 'anonymous', kind: 'agent', name: 'Anonymous agent' };

/** Used for socket connections that do not say who they are; browsers are people. */
export const ANONYMOUS_HUMAN: Actor = { id: 'anonymous', kind: 'human', name: 'Anonymous' };

/**
 * Header values must be ASCII, so clients send the name through
 * `encodeURIComponent`. A name that is not valid percent-encoding is taken as
 * it is.
 */
function decodeHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseActor(
  raw: { id?: string | null; name?: string | null; kind?: string | null },
  fallback: Actor,
  where: string,
): Actor {
  if (!raw.id && !raw.name && !raw.kind) return fallback;
  const candidate = {
    id: raw.id ?? fallback.id,
    kind: raw.kind ?? fallback.kind,
    name: raw.name || raw.id || fallback.name,
  };
  const parsed = ActorSchema.safeParse(candidate);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new OpenBoardError(
      'invalid_request',
      `invalid actor in ${where}: ${problems.join('; ')}`,
    );
  }
  return parsed.data;
}

/** The actor named by request headers, or the anonymous agent. Throws `invalid_request`. */
export function actorFromHeaders(get: (name: string) => string | undefined | null): Actor {
  const name = get('x-openboard-actor-name');
  return parseActor(
    {
      id: get('x-openboard-actor-id'),
      name: name == null ? name : decodeHeader(name),
      kind: get('x-openboard-actor-kind'),
    },
    ANONYMOUS_AGENT,
    'x-openboard-actor-* headers',
  );
}

/**
 * The actor named by socket query parameters, or an anonymous human.
 * `URLSearchParams` has already decoded the values once, which is all the
 * encoding they carry.
 */
export function actorFromQuery(params: URLSearchParams): Actor {
  return parseActor(
    { id: params.get('actorId'), name: params.get('actorName'), kind: params.get('actorKind') },
    ANONYMOUS_HUMAN,
    'actorId/actorName/actorKind query parameters',
  );
}
