import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const config: ExpoConfig = {
  name: "Vitre",
  slug: "vitre-mobile",
  scheme: "vitre",
  version: "0.1.0",
  icon: "../../assets/vitre/icon.png",
  orientation: "default",
  userInterfaceStyle: "dark",
  ios: { bundleIdentifier: "app.vitre.mobile", supportsTablet: true },
  android: { package: "app.vitre.mobile", predictiveBackGestureEnabled: true },
  plugins: [
    "./plugins/withIosSceneLifecycle.cjs",
    "expo-web-browser",
    "expo-status-bar",
    "expo-secure-store",
    "expo-notifications",
    "expo-document-picker",
    [
      "expo-image-picker",
      {
        photosPermission: "Attach photos to your Vitre conversations.",
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
  ],
  extra: projectId ? { eas: { projectId } } : {},
};
export default config;
