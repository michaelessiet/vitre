// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser } from "playwright-core";
import { captureScreenshot, saveScreenshot, screenshotUrl } from "./capture.ts";

describe("cloud screenshots", () => {
  it.each([
    { port: 80 },
    { port: 3774 },
    { port: 70000 },
    { port: 3000, path: "//example.com" },
    { port: 3000, path: "/\\example.com" },
  ])("rejects backend access and escaped targets: %j", (input) => {
    expect(() => screenshotUrl(input, 3774)).toThrow();
  });
  it("keeps query strings and paths on the chosen frontend", () => {
    expect(screenshotUrl({ port: 3000, path: "/dashboard?mode=mobile" }, 3774)).toBe(
      "http://127.0.0.1:3000/dashboard?mode=mobile",
    );
  });
  function browserFixture(fail = false) {
    const close = vi.fn(async () => {});
    const page = {
      setDefaultTimeout: vi.fn(),
      route: vi.fn(),
      goto: vi.fn(async () => {
        if (fail) throw new Error("Application is not running");
      }),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ width: 1280, height: 900 }),
      screenshot: vi.fn(async () => Buffer.from([137, 80, 78, 71])),
      locator: vi.fn(() => ({ first: () => ({ waitFor: vi.fn() }) })),
    };
    const newContext = vi.fn(async () => ({ newPage: async () => page }));
    return {
      close,
      page,
      newContext,
      launch: async () => ({ close, newContext }) as unknown as Browser,
    };
  }
  it("waits for the requested UI, captures a PNG and closes its isolated browser", async () => {
    const browser = browserFixture();
    const image = await captureScreenshot(
      { port: 3000, fullPage: true, waitForSelector: "h1" },
      3774,
      browser.launch,
    );
    expect(image).toMatchObject({ width: 1280, height: 900 });
    expect(browser.page.locator).toHaveBeenCalledWith("h1");
    expect(browser.page.screenshot).toHaveBeenCalledWith({
      type: "png",
      fullPage: true,
      animations: "disabled",
      timeout: 10000,
    });
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it("cleans up after navigation failure and validates before launching", async () => {
    const browser = browserFixture(true);
    await expect(captureScreenshot({ port: 3000 }, 3774, browser.launch)).rejects.toThrow(
      "not running",
    );
    expect(browser.close).toHaveBeenCalledOnce();
    const launch = vi.fn(browser.launch);
    await expect(captureScreenshot({ port: 3000, width: 99999 }, 3774, launch)).rejects.toThrow(
      "dimensions",
    );
    expect(launch).not.toHaveBeenCalled();
  });
  it("persists separate image artifacts without overwriting existing work", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-shot-test-"));
    try {
      const png = Buffer.from([137, 80, 78, 71]);
      const first = await saveScreenshot(root, png),
        second = await saveScreenshot(root, png);
      expect(first).not.toBe(second);
      expect(await NodeFSP.readFile(first)).toEqual(png);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
