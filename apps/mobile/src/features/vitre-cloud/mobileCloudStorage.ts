import type { PendingCloudSend } from "./mobileCloudState";

type Document = { readonly version: 1; readonly pending: ReadonlyArray<PendingCloudSend> };

let queue: Promise<unknown> = Promise.resolve();

async function file() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, "vitre-cloud");
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, "pending-sends.json");
}

async function read(): Promise<PendingCloudSend[]> {
  const target = await file();
  if (!target.exists) return [];
  try {
    const value: unknown = JSON.parse(await target.text());
    if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1)
      return [];
    if (!("pending" in value) || !Array.isArray(value.pending)) return [];
    return value.pending.filter(
      (item): item is PendingCloudSend =>
        typeof item === "object" &&
        item !== null &&
        typeof item.accountId === "string" &&
        typeof item.taskId === "string" &&
        typeof item.idempotencyKey === "string" &&
        typeof item.prompt === "string" &&
        typeof item.createdAt === "string" &&
        (item.disposition === "submitting" || item.disposition === "uncertain"),
    );
  } catch {
    return [];
  }
}

export async function loadPendingCloudSend(accountId: string, taskId: string) {
  await queue;
  const pending =
    (await read()).find((item) => item.accountId === accountId && item.taskId === taskId) ?? null;
  // A request that was in flight when the app exited has an unknown delivery outcome.
  return pending?.disposition === "submitting"
    ? { ...pending, disposition: "uncertain" as const }
    : pending;
}

export function updatePendingCloudSend(
  accountId: string,
  taskId: string,
  pending: PendingCloudSend | null,
): Promise<void> {
  const operation = queue.then(async () => {
    const previous = await read();
    const next = previous.filter((item) => item.accountId !== accountId || item.taskId !== taskId);
    if (pending) next.push(pending);
    const document: Document = { version: 1, pending: next };
    (await file()).write(JSON.stringify(document));
  });
  queue = operation.catch(() => undefined);
  return operation;
}

/** A delayed response may only update the request it belongs to. */
export function transitionPendingCloudSend(
  accountId: string,
  taskId: string,
  expectedKey: string,
  pending: PendingCloudSend | null,
): Promise<boolean> {
  const operation = queue.then(async () => {
    const previous = await read();
    const current = previous.find((item) => item.accountId === accountId && item.taskId === taskId);
    if (current?.idempotencyKey !== expectedKey) return false;
    const next = previous.filter((item) => item.accountId !== accountId || item.taskId !== taskId);
    if (pending) next.push(pending);
    const document: Document = { version: 1, pending: next };
    (await file()).write(JSON.stringify(document));
    return true;
  });
  queue = operation.catch(() => undefined);
  return operation;
}
