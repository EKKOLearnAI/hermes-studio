export type MessageViewportScrollSnapshot = {
  anchorMessageId: string | null;
  anchorOffset: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasNearBottom: boolean;
}

type MessageScrollSession = {
  id: string;
  profile?: string | null;
}

export function messageScrollPositionKey(
  scope: string,
  session: MessageScrollSession | null | undefined,
): string | null {
  const sessionId = String(session?.id || "").trim();
  if (!sessionId) return null;
  const normalizedScope = scope.trim() || "default";
  const profile = String(session?.profile || "default").trim() || "default";
  return `${normalizedScope}\u0000${profile}\u0000${sessionId}`;
}

export function rememberMessageScrollPosition(
  positions: Map<string, MessageViewportScrollSnapshot>,
  key: string,
  snapshot: MessageViewportScrollSnapshot,
  maxEntries = 200,
) {
  positions.delete(key);
  positions.set(key, snapshot);
  while (positions.size > maxEntries) {
    const oldestKey = positions.keys().next().value;
    if (oldestKey === undefined) break;
    positions.delete(oldestKey);
  }
}
