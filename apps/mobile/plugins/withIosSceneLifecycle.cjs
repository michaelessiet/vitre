const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

// Expo 57 includes ExpoAppSceneDelegate, but its bundled prebuild template still
// starts React Native in AppDelegate. iOS 27 rejects that legacy life cycle.
const legacyStartup =
  /#if os\(iOS\) \|\| os\(tvOS\)\s+window = UIWindow\(frame: UIScreen\.main\.bounds\)\s+factory\.startReactNative\(\s+withModuleName: "main",\s+in: window,\s+launchOptions: launchOptions\)\s+#endif\n/;
const legacyDeclaration = "class AppDelegate: ExpoAppDelegate {";
const sceneDeclaration = "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {";

/** @type {import("expo/config-plugins").ConfigPlugin} */
const withIosSceneLifecycle = (config) => {
  config = withAppDelegate(config, (config) => {
    const { language, contents } = config.modResults;
    if (
      language !== "swift" ||
      (!contents.includes(sceneDeclaration) &&
        !(contents.includes(legacyDeclaration) && legacyStartup.test(contents)))
    ) {
      throw new Error(
        "The Expo AppDelegate template changed. Update withIosSceneLifecycle before building iOS.",
      );
    }

    const updated = contents
      .replace(legacyDeclaration, sceneDeclaration)
      .replace(legacyStartup, "");
    if (updated.includes("factory.startReactNative(")) {
      throw new Error("React Native must start in ExpoAppSceneDelegate, not AppDelegate.");
    }
    config.modResults.contents = updated;
    return config;
  });

  return withInfoPlist(config, (config) => {
    // The Expo scene delegate owns the window and forwards links, auth callbacks,
    // and foreground/background events to the existing app delegate subscribers.
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "EXExpoAppSceneDelegate",
          },
        ],
      },
    };
    return config;
  });
};

module.exports = withIosSceneLifecycle;
