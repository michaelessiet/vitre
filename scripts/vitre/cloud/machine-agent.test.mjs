import { afterEach, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { createMachineAgent, sandboxArguments, systemdDriver } from "./machine-agent.mjs";
const cleanups = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).toReversed()) await clean();
});
const taskId = "00000000-0000-4000-8000-000000000001";
const attemptId = `${taskId}-1`;
const token = "machine-credential-".repeat(3);
async function fixture(driver = { start: async () => {}, stop: async () => {} }, options = {}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-machine-"));
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const config = {
    directory,
    ownerId: "user-a",
    token,
    controlUrl: "https://relay.example",
    driver,
    recoveryIntervalMs: 0,
    ...options,
  };
  let server;
  async function listen() {
    server = await createMachineAgent(config);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  }
  const close = () =>
    new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await listen();
  cleanups.push(close);
  const request = (path, method = "GET", body, headers = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "x-vitre-owner": "user-a", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const bootstrap = (id = attemptId) => ({
    taskId,
    attemptId: id,
    controlUrl: config.controlUrl,
    token: "worker-token-".repeat(4),
    deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  return {
    directory,
    request,
    bootstrap,
    recover: () => server.recover(),
    restart: async () => {
      await close();
      await listen();
    },
  };
}
function recoveredBootstrap(overrides = {}) {
  return {
    resident: true,
    stopRequested: false,
    attempt: { id: attemptId },
    task: { id: taskId, state: "running", worker: { state: "ready" } },
    ...overrides,
  };
}
async function recoveredJournal(f, overrides = {}) {
  await NodeFSP.writeFile(
    NodePath.join(f.directory, "workspaces", taskId, "worker/journal.json"),
    JSON.stringify({ attemptId, submitted: true, setupComplete: true, ...overrides }),
  );
}
async function seedReceipt(f, receipt) {
  const folder = NodePath.join(f.directory, receipt.attemptId);
  await NodeFSP.mkdir(folder, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(folder, "receipt.json"), JSON.stringify(receipt));
}
it("fences machine access by both account and credential", async () => {
  const f = await fixture();
  expect((await f.request("/health", "GET", undefined, { "x-vitre-owner": "user-b" })).status).toBe(
    401,
  );
  expect(
    (await f.request("/health", "GET", undefined, { authorization: "Bearer wrong" })).status,
  ).toBe(401);
  expect((await f.request("/health")).status).toBe(200);
});
it("serializes retries and does not replay work after agent restart", async () => {
  let starts = 0;
  const f = await fixture({
    start: async () => {
      starts++;
    },
    stop: async () => {},
  });
  const input = f.bootstrap();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => f.request(`/attempts/${attemptId}`, "PUT", input)),
  );
  expect(responses.every((r) => r.status === 200)).toBe(true);
  await f.restart();
  expect((await f.request(`/attempts/${attemptId}`, "PUT", input)).status).toBe(200);
  expect(starts).toBe(1);
  expect(
    (await f.request(`/attempts/${attemptId}`, "PUT", { ...input, token: "changed".repeat(8) }))
      .status,
  ).toBe(409);
});
it("keeps conversation files across attempts and prevents overlapping owners", async () => {
  const f = await fixture();
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  const file = NodePath.join(f.directory, "workspaces", taskId, "workspace", "work.txt");
  await NodeFSP.writeFile(file, "preserved");
  const next = `${taskId}-2`;
  expect((await f.request(`/attempts/${next}`, "PUT", f.bootstrap(next))).status).toBe(409);
  expect((await f.request(`/attempts/${attemptId}/stop`, "POST")).status).toBe(200);
  expect((await f.request(`/attempts/${next}`, "PUT", f.bootstrap(next))).status).toBe(200);
  expect((await f.request(`/attempts/${attemptId}`, "DELETE")).status).toBe(200);
  expect(await NodeFSP.readFile(file, "utf8")).toBe("preserved");
});
it("does not release ownership when process termination fails", async () => {
  const f = await fixture({
    start: async () => {},
    stop: async () => {
      throw Error("not stopped");
    },
  });
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  expect((await f.request(`/attempts/${attemptId}/stop`, "POST")).status).toBe(503);
  expect((await f.request(`/attempts/${taskId}-2`, "PUT", f.bootstrap(`${taskId}-2`))).status).toBe(
    409,
  );
});
it("reports authoritative process state without retiring its durable attempt receipt", async () => {
  let running = true;
  const f = await fixture({
    start: async () => {},
    stop: async () => {},
    running: async () => running,
  });
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  expect(await (await f.request(`/attempts/${attemptId}`)).json()).toEqual({
    id: `machine-${attemptId}`,
    running: true,
  });
  running = false;
  expect(await (await f.request(`/attempts/${attemptId}`)).json()).toEqual({
    id: `machine-${attemptId}`,
    running: false,
  });
  // A read does not release ownership; explicit stop must still confirm it.
  expect((await f.request(`/attempts/${taskId}-2`, "PUT", f.bootstrap(`${taskId}-2`))).status).toBe(
    409,
  );
});
it("does not report an unknown process inspection as stopped", async () => {
  const f = await fixture({
    start: async () => {},
    stop: async () => {},
    running: async () => {
      throw Error("unknown systemd response");
    },
  });
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  expect((await f.request(`/attempts/${attemptId}`)).status).toBe(503);
});
it("retains a task's endpoint port across attempts without lending it to another task", async () => {
  const f = await fixture();
  const first = await (await f.request(`/attempts/${attemptId}/prepare`, "POST")).json();
  const retry = await (await f.request(`/attempts/${attemptId}/prepare`, "POST")).json();
  const second = await (await f.request(`/attempts/${taskId}-2/prepare`, "POST")).json();
  expect(first.port).toBe(retry.port);
  expect(second.port).toBe(first.port);
  await f.request(`/attempts/${attemptId}/stop`, "POST");
  await f.request(`/attempts/${taskId}-2/stop`, "POST");
  const other = "00000000-0000-4000-8000-000000000002-1";
  const otherPort = await (await f.request(`/attempts/${other}/prepare`, "POST")).json();
  expect(otherPort.port).not.toBe(first.port);
  expect(
    (
      await f.request(`/attempts/${attemptId}`, "PUT", {
        ...f.bootstrap(),
        controlUrl: "https://attacker.example",
      })
    ).status,
  ).toBe(400);
});
it("migrates shared legacy ports to unique stable conversation ports across retries and restarts", async () => {
  const f = await fixture();
  const tasks = [
    taskId,
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ];
  for (const task of tasks)
    await seedReceipt(f, { attemptId: `${task}-1`, port: 20000, state: "stopped" });
  const ports = [];
  for (const task of tasks) {
    const id = `${task}-2`;
    const prepared = await (await f.request(`/attempts/${id}/prepare`, "POST")).json();
    ports.push(prepared.port);
    expect(
      (await f.request(`/attempts/${id}`, "PUT", { ...f.bootstrap(id), taskId: task })).status,
    ).toBe(200);
    const bootstrap = JSON.parse(
      await NodeFSP.readFile(NodePath.join(f.directory, id, "bootstrap.json"), "utf8"),
    );
    expect(bootstrap.port).toBe(prepared.port);
  }
  expect(ports).toEqual([20001, 20002, 20003]);
  await f.restart();
  for (const [index, task] of tasks.entries()) {
    await f.request(`/attempts/${task}-2/stop`, "POST");
    for (const attempt of [10, 11]) {
      const id = `${task}-${attempt}`;
      expect(await (await f.request(`/attempts/${id}/prepare`, "POST")).json()).toEqual({
        port: ports[index],
      });
      expect(await (await f.request(`/attempts/${id}/prepare`, "POST")).json()).toEqual({
        port: ports[index],
      });
      await f.request(`/attempts/${id}/stop`, "POST");
    }
  }
});
it("prefers the newest valid unique own port while reserving every foreign port", async () => {
  const f = await fixture();
  const otherTask = "00000000-0000-4000-8000-000000000002";
  for (const [attempt, port] of [
    [1, 20000],
    [2, 20001],
    [10, 20004],
    [11, 19999],
    [12, 60000],
    [13, 20003.5],
  ])
    await seedReceipt(f, { attemptId: `${taskId}-${attempt}`, taskId, port, state: "stopped" });
  for (const [attempt, port] of [
    [1, 20000],
    [2, 20002],
    [3, 20003],
  ])
    await seedReceipt(f, {
      attemptId: `${otherTask}-${attempt}`,
      taskId: otherTask,
      port,
      state: "stopped",
    });
  expect(await (await f.request(`/attempts/${taskId}-14/prepare`, "POST")).json()).toEqual({
    port: 20004,
  });
  const freshTask = "00000000-0000-4000-8000-000000000003";
  expect(await (await f.request(`/attempts/${freshTask}-1/prepare`, "POST")).json()).toEqual({
    port: 20005,
  });
});
it("preserves a current live endpoint and prefers it over newer inactive own receipts", async () => {
  const f = await fixture();
  await seedReceipt(f, { attemptId, taskId, port: 20002, state: "started" });
  await seedReceipt(f, { attemptId: `${taskId}-2`, taskId, port: 20003, state: "stopped" });
  expect(await (await f.request(`/attempts/${attemptId}/prepare`, "POST")).json()).toEqual({
    port: 20002,
  });
  expect(await (await f.request(`/attempts/${taskId}-3/prepare`, "POST")).json()).toEqual({
    port: 20002,
  });
  expect((await f.request(`/attempts/${taskId}-3`, "PUT", f.bootstrap(`${taskId}-3`))).status).toBe(
    409,
  );
});
it("keeps conversation services resident while bounding auxiliary jobs", async () => {
  const commands = [];
  const driver = systemdDriver("/runtime", async (_binary, args) => commands.push(args));
  const deadline = new Date(Date.now() + 3600_000).toISOString();
  await driver.start(attemptId, "/task", deadline);
  await driver.start(`login-${taskId}`, "/login", deadline);
  expect(commands[0]).toContain("--property=RuntimeMaxSec=infinity");
  expect(commands[1]).not.toContain("--property=RuntimeMaxSec=infinity");
  expect(commands[1].find((arg) => arg.startsWith("--property=RuntimeMaxSec="))).toMatch(/=\d+$/);
});
it("isolates worker process and filesystem access without exposing machine credentials", () => {
  const args = sandboxArguments("/installed/runtime", "/private/conversation");
  expect(args).toContain("--unshare-pid");
  expect(args).toContain("--ro-bind");
  expect(args).toContain("/private/conversation/workspace");
  expect(args).not.toContain("/var/lib/vitre-machine");
  expect(args).not.toContain("CAP_SYS_ADMIN");
});

it("rehydrates a lost resident service only after current relay authorization and retains its disk", async () => {
  let running = false;
  const starts = [];
  let validations = 0;
  const f = await fixture(
    {
      running: async () => running,
      start: async (...args) => {
        starts.push(args);
        running = true;
      },
      stop: async () => {
        running = false;
      },
    },
    {
      fetcher: async (url, options) => {
        expect(url.href).toBe(`https://relay.example/v1/cloud/worker/${taskId}/bootstrap`);
        expect(options.headers.authorization).toBe(`Bearer ${f.bootstrap().token}`);
        validations++;
        return Response.json(recoveredBootstrap());
      },
    },
  );
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  await recoveredJournal(f);
  const file = NodePath.join(f.directory, "workspaces", taskId, "workspace", "dirty.txt");
  await NodeFSP.writeFile(file, "unpublished changes");
  await f.restart();
  await f.recover();
  expect(validations).toBe(0);
  running = false; // The host reboot lost its transient systemd unit.
  await f.restart();
  await Promise.all([f.recover(), f.recover()]);
  await f.recover();
  expect(starts).toHaveLength(2);
  expect(starts[1][3]).toEqual({ recover: true });
  expect(validations).toBe(1);
  expect(await NodeFSP.readFile(file, "utf8")).toBe("unpublished changes");
});

it.each([
  { stopRequested: true },
  { resident: false },
  { attempt: { id: `${taskId}-2` } },
  { task: { id: taskId, state: "cancelled", worker: { state: "ready" } } },
  {
    task: {
      id: taskId,
      state: "running",
      archivedAt: new Date().toISOString(),
      worker: { state: "ready" },
    },
  },
  { task: { id: taskId, state: "running", worker: { state: "stopped" } } },
])("does not resurrect a no-longer-authorized resident service (%j)", async (status) => {
  let starts = 0;
  const f = await fixture(
    {
      running: async () => false,
      start: async () => {
        starts++;
      },
      stop: async () => {},
    },
    {
      fetcher: async () => Response.json(recoveredBootstrap(status)),
    },
  );
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  await recoveredJournal(f);
  await f.recover();
  expect(starts).toBe(1);
});

it("never recovers unjournaled prompts, incomplete setup, or explicitly stopped receipts", async () => {
  let starts = 0;
  const f = await fixture(
    {
      running: async () => false,
      start: async () => {
        starts++;
      },
      stop: async () => {},
    },
    {
      fetcher: async () => Response.json(recoveredBootstrap()),
    },
  );
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  await f.recover();
  await recoveredJournal(f, { submitted: false });
  await f.recover();
  await recoveredJournal(f, { setupComplete: false });
  await f.recover();
  await recoveredJournal(f);
  await f.request(`/attempts/${attemptId}/stop`, "POST");
  await f.recover();
  expect(starts).toBe(1);
});

it("does not race an explicit stop while recovery authorization is in flight", async () => {
  let starts = 0;
  const requested = Promise.withResolvers();
  const authorized = Promise.withResolvers();
  const f = await fixture(
    {
      running: async () => false,
      start: async () => {
        starts++;
      },
      stop: async () => {},
    },
    {
      fetcher: async () => {
        requested.resolve();
        return authorized.promise;
      },
    },
  );
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  await recoveredJournal(f);
  const recovering = f.recover();
  await requested.promise;
  await f.request(`/attempts/${attemptId}/stop`, "POST");
  authorized.resolve(Response.json(recoveredBootstrap()));
  await recovering;
  expect(starts).toBe(1);
});

it("does not resurrect an old attempt after a new attempt starts during authorization", async () => {
  const starts = [];
  const requested = Promise.withResolvers();
  const authorized = Promise.withResolvers();
  const f = await fixture(
    {
      running: async () => false,
      start: async (id) => starts.push(id),
      stop: async () => {},
    },
    {
      fetcher: async () => {
        requested.resolve();
        return authorized.promise;
      },
    },
  );
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  await recoveredJournal(f);
  const recovering = f.recover();
  await requested.promise;
  await f.request(`/attempts/${attemptId}/stop`, "POST");
  const next = `${taskId}-2`;
  expect((await f.request(`/attempts/${next}`, "PUT", f.bootstrap(next))).status).toBe(200);
  await recoveredJournal(f, { attemptId: next, submitted: false });
  authorized.resolve(Response.json(recoveredBootstrap()));
  await recovering;
  expect(starts).toEqual([attemptId, next]);
});

it("retries failed relay validation without launching from cached authority", async () => {
  let starts = 0;
  let available = false;
  const f = await fixture(
    {
      running: async () => false,
      start: async () => {
        starts++;
      },
      stop: async () => {},
    },
    {
      fetcher: async () =>
        available ? Response.json(recoveredBootstrap()) : new Response(null, { status: 503 }),
    },
  );
  await f.request(`/attempts/${attemptId}`, "PUT", f.bootstrap());
  await recoveredJournal(f);
  await f.recover();
  expect(starts).toBe(1);
  available = true;
  await f.recover();
  expect(starts).toBe(2);
});

it("recognizes missing systemd units after reboot and fails closed on unknown process state", async () => {
  const missing = systemdDriver("/runtime", async () => {
    throw Object.assign(new Error("missing"), {
      stdout: "LoadState=not-found\nActiveState=inactive\n",
    });
  });
  expect(await missing.running(attemptId)).toBe(false);
  const unknown = systemdDriver("/runtime", async () => ({
    stdout: "LoadState=loaded\nActiveState=unknown\n",
  }));
  await expect(unknown.running(attemptId)).rejects.toThrow("unknown");
  const active = systemdDriver("/runtime", async () => ({
    stdout: "LoadState=loaded\nActiveState=active\n",
  }));
  expect(await active.running(attemptId)).toBe(true);
});

it("launches recovered services with the worker recovery guard and collects failed units", async () => {
  const commands = [];
  const driver = systemdDriver("/runtime", async (binary, args) => commands.push([binary, args]));
  await driver.start(attemptId, "/task", new Date().toISOString(), { recover: true });
  expect(commands[0]).toEqual([
    "systemctl",
    ["reset-failed", `vitre-attempt-${attemptId}.service`],
  ]);
  expect(commands[1][0]).toBe("systemd-run");
  expect(commands[1][1]).toContain("--collect");
  expect(commands[1][1].slice(-4)).toEqual(["run", "/task", "/runtime", "recover"]);
});
