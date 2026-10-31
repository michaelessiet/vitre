// @effect-diagnostics globalTimers:off - The Playwright promise owns and clears this browser teardown deadline.
// @effect-diagnostics nodeBuiltinImport:off - Playwright runs in the isolated cloud worker.
import * as NodeTimers from "node:timers";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { chromium, type Browser } from "playwright-core";

export interface ScreenshotInput {
  port: number;
  path?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  fullPage?: boolean | undefined;
  waitForSelector?: string | undefined;
}

export function screenshotUrl(input: ScreenshotInput, backendPort: number): string {
  if (
    !Number.isInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65535 ||
    input.port === backendPort
  )
    throw new Error(
      "Choose the frontend development server port (1024–65535), not Vitre's backend port.",
    );
  const origin = `http://127.0.0.1:${input.port}`;
  const path = input.path ?? "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
    throw new Error("Use a local frontend path starting with /.");
  const url = new URL(path, origin);
  if (url.origin !== origin)
    throw new Error("Screenshots must use the frontend development server.");
  return url.href;
}

/** Fresh browser per request: no cross-thread cookies, pages, or retained processes. */
export async function captureScreenshot(
  input: ScreenshotInput,
  backendPort: number,
  launch: () => Promise<Browser> = () =>
    chromium.launch({ headless: true, chromiumSandbox: true, timeout: 20_000 }),
) {
  const url = screenshotUrl(input, backendPort);
  const width = input.width ?? 1280,
    height = input.height ?? 800;
  if (![width, height].every((size) => Number.isInteger(size) && size >= 320 && size <= 2560))
    throw new Error("Screenshot dimensions must be between 320 and 2560 pixels.");
  const browser = await launch();
  // Hard lifetime bounds include navigation, selectors, screenshot, and cleanup.
  const deadline = NodeTimers.setTimeout(() => {
    void browser.close().catch(() => {});
  }, 45_000);
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const origin = new URL(url).origin;
    // Keep navigations on the selected app. The cloud VM's network policy applies
    // to ordinary subresources; no credentials or browser profile are imported.
    await page.route("**/*", async (route) => {
      const request = route.request(),
        target = new URL(request.url());
      const local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(target.hostname);
      if (
        (request.isNavigationRequest() && target.origin !== origin) ||
        (local && target.origin !== origin)
      )
        await route.abort();
      else await route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (input.waitForSelector)
      await page.locator(input.waitForSelector).first().waitFor({ state: "visible" });
    await page.evaluate("document.fonts.ready");
    // Bound full-page images so an unbounded document cannot exhaust worker memory.
    const bounds = await page.evaluate<{ width: number; height: number }>(
      "({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })",
    );
    const fullPage = input.fullPage ?? false;
    if (
      fullPage &&
      (bounds.height > 16000 || bounds.width > 4096 || bounds.width * bounds.height > 20_000_000)
    )
      throw new Error(
        "This page is too large for a full-page screenshot. Capture the viewport instead.",
      );
    const png = await page.screenshot({
      type: "png",
      fullPage,
      animations: "disabled",
      timeout: 10_000,
    });
    if (png.byteLength > 8 * 1024 * 1024)
      throw new Error("The screenshot is too large. Use a smaller viewport.");
    return {
      png,
      url,
      width: fullPage ? Math.max(width, bounds.width) : width,
      height: fullPage ? Math.max(height, bounds.height) : height,
    };
  } finally {
    NodeTimers.clearTimeout(deadline);
    await browser.close();
  }
}

/** A unique directory avoids overwriting user files or following a pre-existing symlink. */
export async function saveScreenshot(workspace: string, png: Uint8Array): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(workspace, ".vitre-screenshot-"));
  const path = NodePath.join(directory, "screenshot.png");
  await NodeFSP.writeFile(path, png, { flag: "wx", mode: 0o600 });
  return path;
}
