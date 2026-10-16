import type { CloudClient } from "@t3tools/client-runtime/cloud";
import type { ProviderApprovalDecision } from "@t3tools/contracts";
import { uuidv4 } from "../../lib/uuid";

/** Approval and question responses must go to the live worker, not to task.resume. */
async function dispatchToWorkspace(client: CloudClient, taskId: string, command: unknown) {
  const connection = await client.connection(taskId);
  const tokenResponse = await fetch(new URL("/oauth/token", connection.httpBaseUrl).toString(), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: connection.bootstrapToken,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Vitre Mobile",
      client_device_type: "mobile",
    }),
  });
  if (!tokenResponse.ok) throw new Error("Cloud workspace authentication failed");
  const credentials = (await tokenResponse.json()) as { access_token?: string };
  if (!credentials.access_token) throw new Error("Cloud workspace authentication failed");
  const response = await fetch(
    new URL("/api/orchestration/dispatch", connection.httpBaseUrl).toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    },
  );
  if (!response.ok) throw new Error(`Cloud workspace request failed (${response.status})`);
}

export function respondToCloudApproval(
  client: CloudClient,
  taskId: string,
  threadId: string,
  requestId: string,
  decision: ProviderApprovalDecision,
) {
  return dispatchToWorkspace(client, taskId, {
    type: "thread.approval.respond",
    commandId: uuidv4(),
    threadId,
    requestId,
    decision,
    createdAt: new Date().toISOString(),
  });
}

export function respondToCloudQuestion(
  client: CloudClient,
  taskId: string,
  threadId: string,
  requestId: string,
  answers: Record<string, string>,
) {
  return dispatchToWorkspace(client, taskId, {
    type: "thread.user-input.respond",
    commandId: uuidv4(),
    threadId,
    requestId,
    answers,
    createdAt: new Date().toISOString(),
  });
}
