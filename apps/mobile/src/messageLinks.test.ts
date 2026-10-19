import { expect, it } from "vite-plus/test";
import { messageLink } from "./messageLinks";

it("opens cloud absolute and relative file links against the workspace", () => {
  for (const url of [
    "/workspace/repository/docs/overview.md",
    "./docs/overview.md",
    "docs/overview.md#L20",
    "docs/overview.md:20:3",
  ]) {
    expect(messageLink(url, "/workspace/repository")).toEqual({
      kind: "file",
      cwd: "/workspace/repository",
      relativePath: "docs/overview.md",
    });
  }
  expect(messageLink("docs/a%20b.md", "/custom/root").relativePath).toBe("docs/a b.md");
  expect(messageLink("/custom/root/README.md", "/custom/root").relativePath).toBe("README.md");
});

it("preserves web URLs and rejects unsupported or out-of-workspace links", () => {
  const url = "https://example.com/docs?q=1#section";
  expect(messageLink(url, "/workspace/repository")).toEqual({ kind: "web", url });
  for (const url of [
    "../secret",
    "/etc/passwd",
    "/workspace/repository-other/a",
    "%2e%2e/secret",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "#heading",
    "%invalid",
    "//host/path",
  ]) {
    expect(() => messageLink(url, "/workspace/repository")).toThrow();
  }
});
