# Native mobile devices in Vitre

On macOS, start a simulator in Xcode or an emulator in Android Studio. Open a
local project thread in Vitre and select **Devices** from the dock's **+** menu,
or **Open Devices** from the command palette. Choose a running device.

The device renders in a native Metal view inside Vitre. Click to tap, drag to
swipe, scroll with a trackpad or mouse wheel, and type after focusing a device field. The toolbar provides Home and,
for Android, Back. The frame counter measures new rendered frames per second;
a stationary screen can legitimately show zero.

## Requirements

- iOS: Xcode with an installed, booted simulator runtime. Vitre uses the Xcode
  selected by `xcode-select -p`.
- Android: a running Android SDK emulator with its local authenticated
  EmulatorController gRPC endpoint. Vitre reads the emulator's local discovery
  registry and authentication token; it does not disable authentication.
- Maestro, Java, browser viewers, and device-side test helpers are not required.

Vitre does not install SDKs, modify Xcode, boot devices automatically, or change
global agent MCP configuration.

## Rendering and input

For iOS, CoreSimulator supplies shared IOSurfaces directly to Metal. New Xcode
versions use the simulator's DTUHID XPC service for touch, hardware buttons, and
keyboard input. Older toolchains can use the legacy Indigo HID interface.
These are private Apple interfaces and need compatibility verification when
upgrading Xcode.

For Android, Vitre consumes a continuous raw RGBA gRPC stream bounded to 1280 pixels on its longest edge, converts it to reusable BGRA IOSurfaces with Accelerate, and draws
with Metal. Touch coordinates map back to the full device resolution, including
rotation. Input RPCs run independently of frame reception. Frames replace
older pending frames instead of building a display queue. Shared-memory gRPC
streaming is avoided because it reproducibly crashes Emulator 36.5.11 on the
macOS installation used for development.

The Node backend handles agent requests only; live video stays in the native
application. PNG encoding happens only for an explicit agent screenshot.

## Agent tools

The existing preview capability grants access to these built-in MCP tools:

| Tool                | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `mobile_devices`    | List running devices on the connected desktop.              |
| `mobile_open`       | Connect a listed `deviceId` to this thread.                 |
| `mobile_status`     | Read device identity, dimensions, frame counts, and errors. |
| `mobile_screenshot` | Get the current screen as an MCP image.                     |
| `mobile_tap`        | Tap normalized `x`, `y` coordinates.                        |
| `mobile_swipe`      | Drag from `from` to `to` over `durationMs` (50–5000).       |
| `mobile_type`       | Type up to 1024 ASCII characters into the focused field.    |
| `mobile_press`      | Press `GoHome`, `GoBack`, `AppSwitch`, or `Power`.          |
| `mobile_close`      | Disconnect the Devices panel.                               |

Coordinates range from 0 to 1, with (0,0) at the top left. Agents should capture
before interacting and capture again to verify the result; an input response
acknowledges dispatch, not an application assertion. Back and AppSwitch are
Android-only. This implementation does not provide accessibility-tree queries,
Maestro YAML execution, multitouch, or Unicode text entry.

## Ownership and lifecycle

One device panel is active per desktop window and belongs to one local thread.
Agent control requires that thread to be selected in Vitre. Close the panel
before connecting from another thread. Human and agent input affect the same
device, so avoid simultaneous gestures.

Closing the tab or exiting Vitre releases the display and input connection,
leaving the device running. Hiding the panel preserves the connection. Cloud
threads, physical devices, Windows, and Linux are outside this initial scope.

## Local verification

The macOS debug build was exercised with an iPhone 17 Pro simulator and a Pixel
10 emulator: connection, switching devices, Home/Back, taps, wheel scrolling,
keyboard entry, command-palette focus, and panel teardown. iOS animation samples
reached roughly 50–65 rendered frames/second; Android interaction reached about
47 at a 570 × 1280 preview. These are short debug-build samples, not a sustained
benchmark or a claim of Android Studio frame-rate parity. Android still needs
performance tuning. Wait for a tapped field to gain focus before typing.
