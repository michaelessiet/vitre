import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThread } from "@t3tools/contracts";
import { importedConversationContext } from "./conversationContext.ts";
const thread = (messages: unknown[], marker = true) =>
  ({
    messages,
    activities: marker
      ? [{ kind: "thread.history.imported", payload: { lastMessageId: "last" } }]
      : [],
  }) as unknown as OrchestrationThread;
describe("transferred conversation context", () => {
  it("seeds the first new request and leaves later requests alone", () => {
    const messages = [
      { id: "last", role: "assistant", text: "Earlier answer" },
      { id: "new", role: "user", text: "Continue" },
    ];
    const result = importedConversationContext(thread(messages), "Continue");
    expect(result).toContain("assistant: Earlier answer");
    expect(result).toContain("Current user request:\nContinue");
    expect(
      importedConversationContext(
        thread([...messages, { id: "later", role: "user", text: "Next" }]),
        "Next",
      ),
    ).toBe("Next");
    expect(importedConversationContext(thread(messages, false), "Continue")).toBe("Continue");
  });
  it("bounds oversized history and handles missing boundaries", () => {
    expect(
      importedConversationContext(thread([{ id: "other", role: "user", text: "hello" }]), "Next"),
    ).toBe("Next");
    const result = importedConversationContext(
      thread([
        { id: "last", role: "assistant", text: "x".repeat(200_000) },
        { id: "new", role: "user", text: "Continue" },
      ]),
      "Continue",
    );
    expect(result).toContain("Earlier history omitted");
    expect(result.length).toBeLessThan(181_000);
  });
});
