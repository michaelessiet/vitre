import { expect, it, vi } from "vite-plus/test";
import * as NodeVM from "node:vm";
import { githubAccountPage } from "./githubAccountPage.ts";
class Element {
  textContent = "";
  disabled = false;
  children: Element[] = [];
  onclick?: () => Promise<void>;
  append(...elements: Element[]) {
    this.children.push(...elements);
  }
  replaceChildren() {
    this.children = [];
  }
}
async function fixture(userId: string | null) {
  const elements = Object.fromEntries(
    ["accounts", "actions", "status", "error", "auth", "connection"].map((id) => [
      id,
      new Element(),
    ]),
  );
  const accounts = [
    { id: "eac-personal", login: "personal", state: "connected" },
    { id: "gha_123", login: "work", state: "connected" },
  ];
  const storage = new Map<string, string>();
  const timers: (() => Promise<void>)[] = [];
  const getToken = vi.fn(async () => "session-jwt");
  const randomUUID = vi.fn(() => "request");
  const createExternalAccount = vi.fn();
  const Clerk = {
    load: vi.fn(async () => {}),
    user: userId
      ? {
          id: userId,
          externalAccounts: [{ id: "eac-personal", reauthorize: vi.fn() }],
          createExternalAccount,
          reload: vi.fn(),
        }
      : null,
    session: { id: "session", getToken },
    mountSignIn: vi.fn(),
  };
  let connectionResult: Record<string, unknown> = {
    status: "pending",
    requestId: "request",
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
    pollAfterMs: 5000,
  };
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    expect(init.headers).toMatchObject({ Authorization: "Bearer session-jwt" });
    return Response.json(
      path.endsWith("/connections") ? connectionResult : { githubAccounts: accounts },
    );
  });
  const location = {
    href: "https://vitre.example/account/github?user=vitre-user",
    origin: "https://vitre.example",
    assign: vi.fn(),
  };
  let ready: () => Promise<void> = async () => {};
  const html = githubAccountPage("pk_test_" + btoa("test.clerk.accounts.dev$"));
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  NodeVM.runInNewContext(script, {
    URL,
    Clerk,
    location,
    fetch: fetcher,
    crypto: { randomUUID },
    setTimeout: (fn: () => Promise<void>) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: vi.fn(),
    confirm: () => true,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    document: { getElementById: (id: string) => elements[id], createElement: () => new Element() },
    window: {
      addEventListener: (event: string, fn: () => Promise<void>) => {
        if (event === "load") ready = fn;
      },
    },
  });
  await ready();
  const click = (text: string) =>
    elements.actions!.children.find((el) => el.textContent === text)!.onclick!();
  return {
    elements,
    Clerk,
    location,
    fetcher,
    getToken,
    randomUUID,
    createExternalAccount,
    storage,
    timers,
    click,
    result: (value: typeof connectionResult) => {
      connectionResult = value;
    },
  };
}
it("starts GitHub device authorization without trying to add a second Clerk identity", async () => {
  const f = await fixture("vitre-user");
  expect(f.elements.accounts!.children).toHaveLength(2);
  await f.click("Connect GitHub account");
  expect(f.createExternalAccount).not.toHaveBeenCalled();
  expect(f.fetcher.mock.calls.at(-1)).toMatchObject([
    "/v1/cloud/github/connections",
    { body: JSON.stringify({ type: "start", requestId: "request" }) },
  ]);
  expect(f.elements.connection!.children.some((el) => el.textContent === "ABCD-EFGH")).toBe(true);
  expect(
    f.elements.connection!.children.find((el) => el.textContent === "Continue on GitHub"),
  ).toMatchObject({
    href: "https://github.com/login/device",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  expect(f.getToken).toHaveBeenCalledWith({ template: "t3-relay" });
});
it("blocks linking in another browser account and after the active session changes", async () => {
  const wrong = await fixture("another-user");
  expect(wrong.elements.status!.textContent).toContain("different Vitre account");
  expect(wrong.fetcher).not.toHaveBeenCalled();
  expect(wrong.elements.actions!.children.map((el) => el.textContent)).toEqual(["Switch account"]);
  const f = await fixture("vitre-user");
  f.fetcher.mockClear();
  f.Clerk.user!.id = "another-user";
  await f.click("Connect GitHub account");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("does not send a token if the account changes while it is being obtained", async () => {
  const f = await fixture("vitre-user");
  f.fetcher.mockClear();
  f.getToken.mockImplementation(async () => {
    f.Clerk.session.id = "different";
    return "wrong-session-token";
  });
  await f.click("Connect GitHub account");
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.elements.error!.textContent).toContain("session changed");
});
it("polls completion and shows the connected repository account", async () => {
  const f = await fixture("vitre-user");
  await f.click("Connect GitHub account");
  f.result({ status: "connected", account: { id: "gha_456", login: "work", state: "connected" } });
  await f.timers.at(-1)!();
  expect(f.elements.status!.textContent).toBe("@work is connected for repository access.");
  expect(f.storage.size).toBe(0);
  expect(f.elements.connection!.children).toHaveLength(0);
});
it("shows authorization expiry and stops retaining an unusable pending request", async () => {
  const f = await fixture("vitre-user");
  await f.click("Connect GitHub account");
  f.fetcher.mockImplementation(async () =>
    Response.json({ message: "Code expired. Start a new connection." }, { status: 409 }),
  );
  await f.timers.at(-1)!();
  expect(f.elements.error!.textContent).toContain("Code expired");
  expect(f.storage.size).toBe(0);
});
it.each([429, 503, 504, "network", "conflict"])(
  "retains the authorization code and resumes polling after a transient %s failure",
  async (failure) => {
    const f = await fixture("vitre-user");
    await f.click("Connect GitHub account");
    f.fetcher.mockImplementationOnce(async () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "conflict")
        return Response.json({ code: "concurrent_update" }, { status: 409 });
      return new Response("Temporarily unavailable", { status: Number(failure) });
    });
    await f.timers.at(-1)!();
    expect(f.storage.size).toBe(1);
    expect(f.elements.connection!.children.some((el) => el.textContent === "ABCD-EFGH")).toBe(true);
    expect(f.elements.error!.textContent).toContain("Retrying automatically");
    f.result({
      status: "connected",
      account: { id: "gha_456", login: "work", state: "connected" },
    });
    await f.timers.at(-1)!();
    expect(f.storage.size).toBe(0);
    expect(f.elements.error!.textContent).toBe("");
    expect(f.elements.status!.textContent).toContain("@work is connected");
  },
);
it("reuses the connection request when starting authorization is interrupted", async () => {
  const f = await fixture("vitre-user");
  f.fetcher.mockImplementationOnce(async () =>
    Response.json({ message: "Retry" }, { status: 503 }),
  );
  await f.click("Connect GitHub account");
  expect(f.storage.size).toBe(1);
  await f.click("Connect GitHub account");
  expect(f.randomUUID).toHaveBeenCalledOnce();
  expect(f.elements.connection!.children.some((el) => el.textContent === "ABCD-EFGH")).toBe(true);
});
it("does not retry polling or retain the code after authentication is revoked", async () => {
  const f = await fixture("vitre-user");
  await f.click("Connect GitHub account");
  const scheduled = f.timers.length;
  f.fetcher.mockImplementationOnce(async () =>
    Response.json({ message: "Sign in again" }, { status: 401 }),
  );
  await f.timers.at(-1)!();
  expect(f.timers).toHaveLength(scheduled);
  expect(f.storage.size).toBe(0);
  expect(f.elements.error!.textContent).toContain("Sign in again");
});
it("keeps the sign-in identity and disconnects only the selected repository connection", async () => {
  const f = await fixture("vitre-user");
  const personal = f.elements.accounts!.children[0]!;
  const work = f.elements.accounts!.children[1]!;
  expect(personal.children.map((el) => el.textContent)).not.toContain("Disconnect");
  await work.children.find((el) => el.textContent === "Disconnect")!.onclick!();
  expect(
    f.fetcher.mock.calls.some(
      ([, init]) => init.body === JSON.stringify({ type: "disconnect", accountId: "gha_123" }),
    ),
  ).toBe(true);
});
it("lets a signed-out browser use the existing Vitre sign-in first", async () => {
  const f = await fixture(null);
  expect(f.Clerk.mountSignIn).toHaveBeenCalledOnce();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.createExternalAccount).not.toHaveBeenCalled();
});
