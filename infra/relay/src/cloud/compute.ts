import * as Schema from "effect/Schema";
import type { CloudConfigurationValue } from "./config.ts";
import { CloudError } from "./policy.ts";

/** Execution is independent of the API used to buy/provision the user's VM. */
export interface MachineConfiguration {
  url: string;
  token: string;
  ownerId: string;
}
export interface WorkerBootstrap {
  controlUrl: string;
  attemptId: string;
  token: string;
  mode?: "login" | "publication";
  deadlineAt: string;
}
export interface ComputeExecutor {
  name(attemptId: string): string;
  prepare?(attemptId: string): Promise<{ port: number }>;
  ensure(taskId: string, bootstrap: WorkerBootstrap): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string; running?: boolean } | null>;
  owned(): Promise<Array<{ id: string; attemptId: string }>>;
  stop(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Provisioning adapters must reconcile by stable machine ID, never by task ID. */
export interface MachineProvisioner {
  ensure(input: { machineId: string; ownerId: string; region: string; size: string }): Promise<{
    machineId: string;
    providerResourceId: string;
    state: "provisioning" | "ready" | "unavailable";
  }>;
  resize(machineId: string, size: string): Promise<void>;
  destroy(machineId: string): Promise<void>;
}
const attemptPattern = /^(?:[a-f0-9-]{36}-[1-9][0-9]*|(?:login|publish)-[a-f0-9-]{36})$/;
const decodeWorker = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, running: Schema.optionalKey(Schema.Boolean) }),
);
const decodeWorkers = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ id: Schema.String, attemptId: Schema.String })),
);
const decodePort = Schema.decodeUnknownSync(
  Schema.Struct({ port: Schema.Int.check(Schema.isBetween({ minimum: 20000, maximum: 59999 })) }),
);

export class PersistentMachineClient implements ComputeExecutor {
  private readonly config: MachineConfiguration;
  private readonly fetcher: typeof fetch;
  constructor(config: MachineConfiguration, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }
  name(attemptId: string) {
    if (!attemptPattern.test(attemptId))
      throw new CloudError("invalid_attempt", "Invalid worker attempt");
    return `machine-${attemptId}`;
  }
  private path(id: string) {
    if (this.name(id.slice(8)) !== id)
      throw new CloudError("invalid_attempt", "Worker is outside this machine");
    return `/attempts/${id.slice(8)}`;
  }
  private async request(path: string, method = "GET", body?: unknown) {
    // The Worker's compatibility date may expose the legacy URL implementation,
    // which supports construction but not the newer static URL.parse method.
    let origin: URL | null;
    try {
      origin = new URL(this.config.url);
    } catch {
      origin = null;
    }
    if (
      !origin ||
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/" ||
      this.config.token.length < 32 ||
      !this.config.ownerId
    )
      throw new CloudError(
        "machine_not_configured",
        "Configure the user's HTTPS machine endpoint and account credential",
        503,
      );
    const response = await this.fetcher.call(globalThis, new URL(`/v1${path}`, origin), {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "x-vitre-owner": this.config.ownerId,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CloudError(
        response.status === 404 ? "machine_attempt_not_found" : "machine_unavailable",
        `Machine request failed (${response.status})`,
        response.status === 404 ? 404 : 503,
      );
    }
    return response.json();
  }
  async prepare(attemptId: string) {
    return decodePort(await this.request(`${this.path(this.name(attemptId))}/prepare`, "POST"));
  }
  async ensure(taskId: string, bootstrap: WorkerBootstrap) {
    const id = this.name(bootstrap.attemptId);
    const worker = decodeWorker(await this.request(this.path(id), "PUT", { taskId, ...bootstrap }));
    if (worker.id !== id)
      throw new CloudError("machine_identity_conflict", "Machine returned another attempt");
    return worker;
  }
  async get(id: string) {
    try {
      const worker = decodeWorker(await this.request(this.path(id)));
      if (worker.id !== id)
        throw new CloudError("machine_identity_conflict", "Machine returned another attempt");
      return worker;
    } catch (error) {
      if (error instanceof CloudError && error.code === "machine_attempt_not_found") return null;
      throw error;
    }
  }
  async owned() {
    const workers = decodeWorkers(await this.request("/attempts"));
    for (const worker of workers)
      if (this.name(worker.attemptId) !== worker.id)
        throw new CloudError("machine_identity_conflict", "Invalid machine attempt list");
    return [...workers];
  }
  async stop(id: string) {
    await this.request(`${this.path(id)}/stop`, "POST");
  }
  async delete(id: string) {
    await this.request(this.path(id), "DELETE");
  }
}

/** Execution uses the assigned persistent machine; an absent assignment fails closed. */
export function computeExecutor(config: CloudConfigurationValue): ComputeExecutor {
  return new PersistentMachineClient(
    config.machine ?? { url: "", token: "", ownerId: config.allowedUserId },
  );
}
