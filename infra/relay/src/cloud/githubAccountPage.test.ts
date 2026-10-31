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
    ["accounts", "actions", "status", "error", "auth"].map((id) => [id, new Element()]),
  );
  const createExternalAccount = vi.fn(async () => ({
    verification: {
      externalVerificationRedirectURL: new URL("https://github.com/login/oauth/authorize"),
    },
  }));
  const account = (id: string) => ({
    id,
    provider: "github",
    username: id,
    verification: { status: "verified" },
  });
  const Clerk = {
    load: vi.fn(async () => {}),
    user: userId
      ? {
          id: userId,
          externalAccounts: [account("personal"), account("work")],
          createExternalAccount,
        }
      : null,
    mountSignIn: vi.fn(),
  };
  const location = {
    href: "https://vitre.example/account/github?user=vitre-user",
    origin: "https://vitre.example",
    assign: vi.fn(),
  };
  let ready: () => Promise<void> = async () => {};
  const html = githubAccountPage(`pk_test_${btoa("test.clerk.accounts.dev$")}`);
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  NodeVM.runInNewContext(script, {
    URL,
    Clerk,
    location,
    document: { getElementById: (id: string) => elements[id], createElement: () => new Element() },
    window: {
      addEventListener: (_: string, fn: () => Promise<void>) => {
        ready = fn;
      },
    },
  });
  await ready();
  return { elements, Clerk, location, createExternalAccount };
}
it("links new GitHub identities to the current Vitre user and preserves the callback account", async () => {
  const f = await fixture("vitre-user");
  expect(f.elements.accounts!.children).toHaveLength(2);
  await f.elements.actions!.children.find(
    (element) => element.textContent === "Link another GitHub account",
  )!.onclick!();
  expect(f.createExternalAccount).toHaveBeenCalledWith({
    strategy: "oauth_github",
    oidcPrompt: "select_account",
    redirectUrl: "https://vitre.example/account/github?user=vitre-user",
    additionalScopes: ["repo"],
  });
  expect(f.location.assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize");
});
it("blocks linking in a different browser account and after the session changes", async () => {
  const wrong = await fixture("another-user");
  expect(wrong.elements.status!.textContent).toContain("different Vitre account");
  expect(wrong.elements.actions!.children.map((element) => element.textContent)).toEqual([
    "Switch account",
  ]);
  const f = await fixture("vitre-user");
  f.Clerk.user!.id = "another-user";
  await f.elements.actions!.children[0]!.onclick!();
  expect(f.createExternalAccount).not.toHaveBeenCalled();
});
it("lets a signed-out browser use the supported Vitre sign-in methods first", async () => {
  const f = await fixture(null);
  expect(f.Clerk.mountSignIn).toHaveBeenCalledOnce();
  expect(f.createExternalAccount).not.toHaveBeenCalled();
});
