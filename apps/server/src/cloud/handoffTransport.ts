import { CloudConnection, CloudOverview } from "@t3tools/contracts/cloud";
import * as Schema from "effect/Schema";
import { cloudApi } from "./StartCloudConversation.ts";
import { CloudRequestFailure } from "./requestFailure.ts";

const decodeOverview = Schema.decodeUnknownSync(CloudOverview);
const decodeConnection = Schema.decodeUnknownSync(CloudConnection);

export function handoffRelay(
  session: { relayUrl: string; accessToken: string },
  fetcher: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> = fetch,
) {
  const api = cloudApi(session, fetcher);
  return {
    api,
    overview: async () => decodeOverview(await api("")),
    environment: async (taskId: string) => {
      const connection = decodeConnection(
        await api(`/tasks/${encodeURIComponent(taskId)}/connection`),
      );
      const origin = new URL(connection.httpBaseUrl);
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash ||
        origin.pathname !== "/"
      )
        throw new Error("Invalid cloud environment origin");
      const response = await fetcher(new URL("/oauth/token", origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: connection.bootstrapToken,
          subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          client_label: "Vitre conversation transfer",
          client_device_type: "desktop",
        }),
      });
      if (!response.ok) throw new Error("Cloud workspace authentication failed");
      const credentials = (await response.json()) as { access_token?: string };
      if (!credentials.access_token) throw new Error("Cloud workspace authentication failed");
      return async (path: string, body?: unknown): Promise<unknown> => {
        const result = await fetcher(new URL(path, origin), {
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
          headers: {
            Authorization: `Bearer ${credentials.access_token}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!result.ok) {
          const body = (await result.json().catch(() => null)) as {
            code?: string;
            reason?: string;
          } | null;
          if (
            body?.code === "invalid_request" &&
            ["execution_busy", "command_rejected"].includes(body.reason ?? "")
          ) {
            throw new CloudRequestFailure(
              "Waiting for the current turn and pending requests",
              "rejected",
              body.reason,
              true,
            );
          }
          throw new CloudRequestFailure(
            `Cloud workspace request failed (${result.status})`,
            "unknown",
            body?.code,
          );
        }
        return result.json();
      };
    },
  };
}
