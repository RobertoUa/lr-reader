export type Entry = {
  id: string;
  op: "save" | "remove";
  key: string;
  item?: any;
  // Email of the Language Reactor account the mark was made for; it is only sent with that login.
  account: string;
  attempts: number;
  error?: string;
};

// The latest mark for a key wins: older pending entries for it are dropped.
export function enqueue(list: Entry[], op: Entry["op"], key: string, account: string, item?: object): Entry[] {
  const e: Entry = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, op, key, item, account, attempts: 0 };
  return [...list.filter((x) => x.key !== key), e];
}

export const drop = (list: Entry[], key: string) => list.filter((x) => x.key !== key);

// Sends entries in order; sent ones are removed, failed ones stay with their error.
export async function flush(list: Entry[], send: (e: Entry) => Promise<void>): Promise<Entry[]> {
  const left: Entry[] = [];
  for (const e of list) {
    try {
      await send(e);
    } catch (err) {
      left.push({ ...e, attempts: e.attempts + 1, error: (err as Error).message || String(err) });
    }
  }
  return left;
}

// The outbox after a flush of `sent`, given what it holds now (marks may have changed during the flush):
// sent entries go, failed ones get their error, and entries dropped or replaced meanwhile stay gone.
export function afterFlush(now: Entry[], sent: Entry[], failed: Entry[]): Entry[] {
  const sentIds = new Set(sent.map((e) => e.id));
  const failedById = new Map(failed.map((e) => [e.id, e]));
  return now.filter((e) => !sentIds.has(e.id) || failedById.has(e.id)).map((e) => failedById.get(e.id) ?? e);
}
