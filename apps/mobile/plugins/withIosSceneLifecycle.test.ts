/// <reference types="node" />
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { ExportedConfig } from "expo/config-plugins";
import { expect, it } from "vite-plus/test";
import withIosSceneLifecycle from "./withIosSceneLifecycle.cjs";

const require = NodeModule.createRequire(import.meta.url);
// Exercise the installed SDK's actual template so an Expo upgrade cannot silently
// restore the launch crash or invalidate our AppDelegate transform.
const template = NodeChildProcess.execFileSync(
  "tar",
  [
    "-xOzf",
    NodePath.join(NodePath.dirname(require.resolve("expo/package.json")), "template.tgz"),
    "package/ios/HelloWorld/AppDelegate.swift",
  ],
  { encoding: "utf8" },
);

const modRequest = {
  projectRoot: "/vitre-mobile",
  platformProjectRoot: "/vitre-mobile/ios",
  platform: "ios" as const,
  modName: "appDelegate",
  introspect: false,
  ignoreExistingNativeFiles: false,
};

async function applyAppDelegate(contents: string, language: "swift" | "objc" = "swift") {
  const config: ExportedConfig = withIosSceneLifecycle({ name: "Vitre", slug: "vitre-mobile" });
  return config.mods!.ios!.appDelegate!({
    ...config,
    modRawConfig: config,
    modRequest,
    modResults: { path: "/vitre-mobile/ios/Vitre/AppDelegate.swift", language, contents },
  });
}

it("moves startup to Expo's scene delegate while retaining the factory and link handlers", async () => {
  const result = (await applyAppDelegate(template)).modResults.contents;
  expect(result).toContain("class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {");
  expect(result).toContain("reactNativeFactory = factory");
  expect(result).toContain("return super.application(application, didFinishLaunchingWithOptions:");
  expect(result).not.toContain("UIWindow(frame:");
  expect(result).not.toContain("factory.startReactNative(");
  expect(result.slice(result.indexOf("  // Linking API"))).toBe(
    template.slice(template.indexOf("  // Linking API")),
  );
  expect((await applyAppDelegate(result)).modResults.contents).toBe(result);
});

it("registers Expo's Objective-C scene class without removing other plist settings", async () => {
  const config: ExportedConfig = withIosSceneLifecycle({ name: "Vitre", slug: "vitre-mobile" });
  const existing = {
    UILaunchStoryboardName: "SplashScreen",
    CFBundleURLTypes: [{ CFBundleURLSchemes: ["vitre"] }],
  };
  const result = await config.mods!.ios!.infoPlist!({
    ...config,
    modRawConfig: config,
    modRequest: { ...modRequest, modName: "infoPlist" },
    modResults: { ...existing },
  });
  expect(result.modResults).toMatchObject({
    ...existing,
    UIApplicationSceneManifest: {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneDelegateClassName: "EXExpoAppSceneDelegate" },
        ],
      },
    },
  });
});

it("stops prebuild if the template no longer matches instead of producing a crashing binary", async () => {
  await expect(
    applyAppDelegate(template.replace("UIWindow(frame:", "CustomWindow(frame:")),
  ).rejects.toThrow("template changed");
  await expect(applyAppDelegate(template, "objc")).rejects.toThrow("template changed");
});
