import { describe, expect, it } from "vite-plus/test";
import { parseGithubRepository } from "./index.ts";
describe("GitHub repository input", () => {
  it.each([
    "owner/repo",
    "https://github.com/owner/repo",
    "https://github.com/owner/repo/",
    " https://github.com/owner/repo.git/ ",
  ])("normalizes %s", (input) =>
    expect(parseGithubRepository(input)).toEqual({ owner: "owner", name: "repo" }),
  );
  it.each([
    "http://github.com/a/b",
    "https://github.com.evil/a/b",
    "https://github.com/a/b/tree/main",
    "https://github.com/a/b?x=1",
    "https://user@github.com/a/b",
    "a/..",
    "a/b#branch",
    "a/b/c",
    "a/",
  ])("rejects %s", (input) => expect(() => parseGithubRepository(input)).toThrow("repository URL"));
});
