export type BackgroundBrief = {
  text: string;
  updatedAt: string;
  source?: string;
  raw?: any;
};

const store: Record<string, BackgroundBrief> = {};

export function setBackgroundBrief(
  sessionId: string,
  brief: BackgroundBrief,
): void {
  store[sessionId] = brief;
}

export function getBackgroundBrief(
  sessionId: string,
): BackgroundBrief | null {
  return store[sessionId] || null;
}
