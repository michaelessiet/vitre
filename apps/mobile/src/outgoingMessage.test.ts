import { CloudClientError } from "@t3tools/client-runtime/cloud";
import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import type { CloudAttachment } from "@t3tools/contracts/cloud";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  conversationMessages,
  deliverOutgoing,
  outgoingMessageId,
  restoreOutgoing,
  type ContinueCommand,
  type OutgoingMessage,
} from "./outgoingMessage";

const createdAt = "2026-10-25T10:00:00.000Z";
const uploaded: CloudAttachment[] = [
  {
    type: "image",
    name: "screen.png",
    mimeType: "image/png",
    sizeBytes: 24,
    sha256: "a".repeat(64),
    chunks: ["b".repeat(64)],
  },
];

function outgoing(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    command: {
      type: "task.continue",
      idempotencyKey: "continue-one",
      taskId: "task-one",
      prompt: "Explain this screen",
      model: "gpt-5.4",
    },
    attachments: [
      {
        id: "local-image",
        name: "screen.png",
        mimeType: "image/png",
        uri: "file:///cache/screen.png",
        size: 24,
        type: "image",
      },
    ],
    createdAt,
    prepared: false,
    status: "sending",
    ...overrides,
  };
}

function serverMessage(id: string, text: string): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text,
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delivery() {
  const publications: OutgoingMessage[] = [];
  return {
    publications,
    publish: vi.fn(async (message: OutgoingMessage) => {
      publications.push(message);
    }),
    upload: vi.fn(async () => uploaded),
    dispatch: vi.fn(async (_command: ContinueCommand) => ({ entityId: "task-one" })),
  };
}

describe("outgoing mobile messages", () => {
  it("publishes the bubble synchronously and persists both stages before dispatch", async () => {
    const message = outgoing();
    const initialPersist = gate();
    const preparedPersist = gate();
    const preparedPublished = gate();
    const operations = delivery();
    operations.publish.mockImplementation((current) => {
      operations.publications.push(current);
      if (current.status !== "sending") return Promise.resolve();
      if (!current.prepared) return initialPersist.promise;
      preparedPublished.resolve();
      return preparedPersist.promise;
    });

    const result = deliverOutgoing(message, operations);

    expect(operations.publish).toHaveBeenCalledTimes(1);
    expect(conversationMessages([], [operations.publications[0]!])).toMatchObject([
      {
        text: message.command.prompt,
        attachments: message.attachments,
        outgoing: { status: "sending" },
      },
    ]);
    expect(operations.upload).not.toHaveBeenCalled();
    expect(operations.dispatch).not.toHaveBeenCalled();

    initialPersist.resolve();
    await preparedPublished.promise;
    expect(operations.upload).toHaveBeenCalledExactlyOnceWith(message.attachments);
    expect(operations.publications[1]).toMatchObject({
      prepared: true,
      command: { ...message.command, attachments: uploaded },
    });
    expect(operations.dispatch).not.toHaveBeenCalled();

    preparedPersist.resolve();
    await result;
    expect(operations.dispatch).toHaveBeenCalledExactlyOnceWith(
      operations.publications[1]!.command,
    );
    expect(operations.publications.at(-1)?.status).toBe("sent");
  });

  it("keeps the accepted bubble until the exact server message arrives", async () => {
    const operations = delivery();
    await deliverOutgoing(outgoing(), operations);
    const accepted = operations.publications.at(-1)!;
    const optimistic = conversationMessages([], [accepted]);

    expect(accepted.status).toBe("sent");
    expect(optimistic).toHaveLength(1);
    expect(optimistic[0]?.id).toBe("continue-one-message");
    expect(optimistic[0]?.outgoing).toBe(accepted);

    const echo = serverMessage(outgoingMessageId(accepted), accepted.command.prompt);
    const messages = [echo];
    expect(conversationMessages(messages, [accepted])).toBe(messages);
    expect(conversationMessages(messages, [accepted])[0]?.outgoing).toBeUndefined();
  });

  it("does not deduplicate an outgoing message against identical text in history", () => {
    const message = outgoing({ status: "sent" });
    const previous = serverMessage("earlier-message", message.command.prompt);

    const messages = conversationMessages([previous], [message]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(previous);
    expect(messages[1]?.text).toBe(previous.text);
    expect(messages[1]?.id).toBe(outgoingMessageId(message));
    expect(messages[1]?.outgoing).toBe(message);
  });

  it("shows a prepared legacy request's attachments without relying on the current draft", () => {
    const message = outgoing({
      command: { ...outgoing().command, attachments: uploaded },
      attachments: [],
      prepared: true,
      status: "uncertain",
    });

    expect(conversationMessages([], [message])[0]?.attachments).toEqual([
      { id: `${uploaded[0]!.sha256}-0`, name: "screen.png" },
    ]);
  });

  it("keeps multiple sent and failed bubbles while reconciling only matching server IDs", () => {
    const sent = outgoing({ status: "sent", prepared: true });
    const failed = outgoing({
      command: { ...sent.command, idempotencyKey: "continue-two" },
      status: "failed",
      error: "Upload interrupted",
      createdAt: "2026-10-25T10:01:00.000Z",
    });
    const previous = serverMessage("earlier-message", sent.command.prompt);
    const outbox = [sent, failed];

    const optimistic = conversationMessages([previous], outbox);
    expect(optimistic.map((message) => message.id)).toEqual([
      previous.id,
      outgoingMessageId(sent),
      outgoingMessageId(failed),
    ]);
    expect(optimistic[1]?.outgoing).toBe(sent);
    expect(optimistic[2]?.outgoing).toBe(failed);

    const sentEcho = serverMessage(outgoingMessageId(sent), sent.command.prompt);
    const partial = conversationMessages([previous, sentEcho], outbox);
    expect(partial).toHaveLength(3);
    expect(partial[1]).toBe(sentEcho);
    expect(partial[1]?.outgoing).toBeUndefined();
    expect(partial[2]?.outgoing).toBe(failed);

    const failedEcho = serverMessage(outgoingMessageId(failed), failed.command.prompt);
    const reconciled = [previous, sentEcho, failedEcho];
    expect(conversationMessages(reconciled, outbox)).toBe(reconciled);
    expect(conversationMessages(reconciled, [])).toBe(reconciled);
  });

  it("retries an ambiguous response with the same request and uploaded attachments", async () => {
    const operations = delivery();
    operations.dispatch.mockRejectedValueOnce(new CloudClientError(0, "network", "Response lost"));
    await deliverOutgoing(outgoing(), operations);
    const uncertain = operations.publications.at(-1)!;
    const firstPayload = structuredClone(operations.dispatch.mock.calls[0]![0]);

    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.error).toBe("Response lost");
    expect(uncertain.prepared).toBe(true);
    expect(uncertain.command.attachments).toEqual(uploaded);

    await deliverOutgoing(uncertain, operations);

    expect(operations.upload).toHaveBeenCalledTimes(1);
    expect(operations.dispatch).toHaveBeenCalledTimes(2);
    expect(operations.dispatch.mock.calls[1]![0]).toEqual(firstPayload);
    expect(operations.dispatch.mock.calls[1]![0].idempotencyKey).toBe("continue-one");
    expect(operations.publications.at(-1)).toMatchObject({ status: "sent", error: undefined });
    expect(outgoingMessageId(operations.publications.at(-1)!)).toBe(outgoingMessageId(uncertain));
  });

  it("keeps an upload failure visible as definitely failed without dispatching", async () => {
    const operations = delivery();
    const message = outgoing();
    operations.upload.mockRejectedValueOnce(new Error("Upload failed integrity verification"));

    await deliverOutgoing(message, operations);

    expect(operations.dispatch).not.toHaveBeenCalled();
    const failed = operations.publications.at(-1)!;
    expect(failed).toMatchObject({
      status: "failed",
      prepared: false,
      error: "Upload failed integrity verification",
      attachments: message.attachments,
    });
    expect(conversationMessages([], [failed])[0]?.outgoing).toBe(failed);
  });

  it.each(["uncertain", "sent"] as const)(
    "keeps a previously %s request ambiguous when retry persistence fails",
    async (status) => {
      const message = outgoing({
        command: { ...outgoing().command, attachments: uploaded },
        prepared: true,
        status,
      });
      const operations = delivery();
      operations.publish.mockRejectedValueOnce(new Error("Storage unavailable"));

      await deliverOutgoing(message, operations);

      const interrupted = operations.publications.at(-1)!;
      expect(interrupted).toMatchObject({
        status: "uncertain",
        error: "Storage unavailable",
        command: message.command,
      });
      expect(operations.dispatch).not.toHaveBeenCalled();
      expect(operations.upload).not.toHaveBeenCalled();

      await deliverOutgoing(interrupted, operations);

      expect(operations.dispatch).toHaveBeenCalledExactlyOnceWith(message.command);
      expect(operations.upload).not.toHaveBeenCalled();
      expect(operations.publications.at(-1)?.status).toBe("sent");
    },
  );

  it("marks an explicitly rejected uncertain retry as definitely failed", async () => {
    const operations = delivery();
    operations.dispatch.mockRejectedValueOnce(
      new CloudClientError(409, "task_archived", "Task is archived", "rejected"),
    );

    await deliverOutgoing(outgoing({ status: "uncertain", prepared: true }), operations);

    expect(operations.dispatch).toHaveBeenCalledTimes(1);
    expect(operations.publications.at(-1)).toMatchObject({
      status: "failed",
      prepared: true,
      error: "Task is archived",
    });
  });

  it("does not publish or send when the conversation has already unmounted", async () => {
    const operations = delivery();
    const controller = new AbortController();
    controller.abort();

    await deliverOutgoing(outgoing(), { ...operations, signal: controller.signal });

    expect(operations.publish).not.toHaveBeenCalled();
    expect(operations.upload).not.toHaveBeenCalled();
    expect(operations.dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch or overwrite the remounted outbox after unmounting during upload", async () => {
    const operations = delivery();
    const controller = new AbortController();
    const uploading = gate();
    const uploadedLater = gate();
    operations.upload.mockImplementation(async () => {
      uploading.resolve();
      await uploadedLater.promise;
      return uploaded;
    });

    const result = deliverOutgoing(outgoing(), { ...operations, signal: controller.signal });
    await uploading.promise;
    controller.abort();
    uploadedLater.resolve();
    await result;

    expect(operations.publish).toHaveBeenCalledTimes(1);
    expect(operations.dispatch).not.toHaveBeenCalled();
    const persisted = operations.publications[0]!;
    expect(persisted).toMatchObject({ status: "sending", prepared: false });
    expect(restoreOutgoing(persisted).status).toBe("failed");
  });

  it("keeps a dispatched request intact without publishing late results after unmount", async () => {
    const operations = delivery();
    const controller = new AbortController();
    const dispatched = gate();
    const response = gate();
    operations.dispatch.mockImplementation(async () => {
      dispatched.resolve();
      await response.promise;
      return { entityId: "task-one" };
    });
    let finished = false;
    const result = deliverOutgoing(outgoing(), { ...operations, signal: controller.signal }).then(
      () => {
        finished = true;
      },
    );
    await dispatched.promise;
    const persisted = operations.publications.at(-1)!;

    controller.abort();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(restoreOutgoing(persisted)).toMatchObject({
      status: "uncertain",
      prepared: true,
      command: operations.dispatch.mock.calls[0]![0],
    });

    response.resolve();
    await result;
    expect(operations.dispatch).toHaveBeenCalledTimes(1);
    expect(operations.publish).toHaveBeenCalledTimes(2);
    expect(operations.publications.at(-1)).toBe(persisted);
  });

  it.each([
    { prepared: true, status: "uncertain" },
    { prepared: false, status: "failed" },
  ] as const)(
    "restores an interrupted prepared=$prepared send as $status, requiring an explicit retry",
    ({ prepared, status }) => {
      const interrupted = outgoing({ prepared });

      const restored = restoreOutgoing(interrupted);

      expect(restored.status).toBe(status);
      expect(restored.command).toEqual(interrupted.command);
      expect(restored.attachments).toEqual(interrupted.attachments);
      expect(restored.createdAt).toBe(interrupted.createdAt);
      expect(conversationMessages([], [restored])[0]?.outgoing?.status).toBe(status);
      expect(interrupted.status).toBe("sending");
    },
  );
});
