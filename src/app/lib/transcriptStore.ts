// Simple in-memory transcript store to share recent diarised utterances
// between the recording hook and agent tools.

export type StoredUtterance = {
  speakerId: string;
  speakerLabel?: string;
  start: number;
  end: number;
  text: string;
};

const store: Record<string, StoredUtterance[]> = {};

export function setTranscriptForSession(
  sessionId: string,
  utterances: StoredUtterance[],
): void {
  store[sessionId] = utterances;
}

export function clearTranscriptForSession(sessionId: string): void {
  delete store[sessionId];
}

export function getTranscriptForSession(
  sessionId: string,
): StoredUtterance[] {
  return store[sessionId] || [];
}

export function getTranscriptSnippet(
  sessionId: string,
  maxUtterances = 12,
): StoredUtterance[] {
  const utterances = getTranscriptForSession(sessionId);
  return utterances.slice(Math.max(utterances.length - maxUtterances, 0));
}

export function getTranscriptSnippetText(
  sessionId: string,
  maxUtterances = 12,
): string {
  const snippet = getTranscriptSnippet(sessionId, maxUtterances);
  return snippet
    .map(
      (u) =>
        `${u.speakerLabel || u.speakerId || "Unknown"}: ${u.text}`.trim(),
    )
    .join("\n");
}
