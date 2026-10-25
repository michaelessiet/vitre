import { CloudClientError } from "@t3tools/client-runtime/cloud";
import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import type { CloudAttachment, CloudCommand } from "@t3tools/contracts/cloud";
import type { LocalAttachment } from "./attachments";

export type ContinueCommand = Extract<CloudCommand, { type: "task.continue" }>;
export interface OutgoingMessage {
  command: ContinueCommand;
  attachments: LocalAttachment[];
  createdAt: string;
  prepared: boolean;
  status: "sending" | "sent" | "uncertain" | "failed";
  error?: string;
}

export type ConversationMessage = Omit<OrchestrationMessage, "attachments"> & {
  attachments?: readonly { id: string; name: string }[];
  outgoing?: OutgoingMessage;
};

// The cloud worker uses this same id when it dispatches thread.turn.start.
export const outgoingMessageId = (message: OutgoingMessage) =>
  MessageId.make(`${message.command.idempotencyKey}-message`);

export function conversationMessages(
  messages: readonly OrchestrationMessage[],
  outgoing: readonly OutgoingMessage[],
): readonly ConversationMessage[] {
  if (outgoing.length === 0) return messages;
  const serverIds = new Set(messages.map((message) => message.id));
  const pending = outgoing.filter((message) => !serverIds.has(outgoingMessageId(message)));
  if (pending.length === 0) return messages;
  return [
    ...messages,
    ...pending.map(
      (message): ConversationMessage => ({
        id: outgoingMessageId(message),
        role: "user",
        text: message.command.prompt,
        attachments: message.prepared
          ? (message.command.attachments ?? []).map((attachment, index) => ({
              id: `${attachment.sha256}-${index}`,
              name: attachment.name,
            }))
          : message.attachments,
        turnId: null,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
        outgoing: message,
      }),
    ),
  ];
}

/** Never resend automatically after reopening; the previous response may have been lost. */
export function restoreOutgoing(message: OutgoingMessage): OutgoingMessage {
  return message.status === "sending"
    ? { ...message, status: message.prepared ? "uncertain" : "failed" }
    : message;
}

/** Publish before the first await, then persist the exact request before dispatching it. */
export async function deliverOutgoing(
  message: OutgoingMessage,
  operations: {
    signal?: AbortSignal;
    publish: (message: OutgoingMessage) => Promise<void>;
    upload: (attachments: LocalAttachment[]) => Promise<CloudAttachment[]>;
    dispatch: (command: ContinueCommand) => Promise<unknown>;
  },
): Promise<void> {
  if (operations.signal?.aborted) return;
  let current: OutgoingMessage = { ...message, status: "sending", error: undefined };
  // An earlier attempt may already have been accepted even if this retry fails
  // to persist before dispatch. Keep its key ambiguous until a definite receipt.
  let mayHaveDispatched = message.status === "uncertain" || message.status === "sent";
  try {
    await operations.publish(current);
    if (operations.signal?.aborted) return;
    if (!current.prepared) {
      const attachments = await operations.upload(current.attachments);
      if (operations.signal?.aborted) return;
      current = { ...current, command: { ...current.command, attachments }, prepared: true };
      await operations.publish(current);
      if (operations.signal?.aborted) return;
    }
    mayHaveDispatched = true;
    // An in-flight command may already be accepted. Leave its persisted
    // prepared request intact for an exact-key retry after reopening.
    await operations.dispatch(current.command);
    if (operations.signal?.aborted) return;
    current = { ...current, status: "sent" };
  } catch (error) {
    if (operations.signal?.aborted) return;
    const rejected = error instanceof CloudClientError && error.requestDisposition === "rejected";
    current = {
      ...current,
      status: mayHaveDispatched && !rejected ? "uncertain" : "failed",
      error: error instanceof Error ? error.message : "Could not send this message.",
    };
  }
  // A storage failure must not hide the message or leave its send spinner stuck.
  if (operations.signal?.aborted) return;
  await operations.publish(current).catch(() => {});
}
