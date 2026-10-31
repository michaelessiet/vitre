# Native mobile devices in Vitre

On macOS, create a simulator in Xcode or an emulator in Android Studio. Open a
local project thread in Vitre and select **Devices** from the dock's **+** menu,
or **Open Devices** from the command palette. Search for a device and select it.
Devices marked **Start** boot automatically; **Running** devices connect directly.
Vitre waits for the device to finish booting before attaching its display.

The device renders in a native Metal view inside Vitre. Click to tap, drag to
swipe, scroll with a trackpad or mouse wheel, and type after focusing a device field. The toolbar provides Home and,
for Android, Back. The frame counter measures new rendered frames per second;
a stationary screen can legitimately show zero.

Use **Stop** in the device toolbar to shut down the selected device. Vitre shows
**Stopping…** until shutdown finishes, then **Stopped**. Select the device from
**Open Devices** to start it again. Stop becomes available after startup finishes.
Closing the Devices tab disconnects its display and leaves a running device on.

## Requirements

- iOS: Xcode with an installed simulator runtime and a configured device. Vitre uses the Xcode
  selected by `xcode-select -p`.
- Android: Android SDK Emulator and a configured AVD. Vitre finds the SDK through
  `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the default macOS SDK directory, or `PATH`.
  It starts stopped AVDs with a local authenticated EmulatorController gRPC
  endpoint and an embedded display. Stale discovery records from exited emulator
  processes are ignored.
- Maestro, Java, browser viewers, and device-side test helpers are not required.

Vitre does not install SDKs, create virtual devices, modify Xcode, or change
global agent MCP configuration.

The picker follows the [Vitre design language](design-language/README.md).

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
| `mobile_devices`    | List configured devices and their running state.            |
| `mobile_open`       | Start if needed and connect a listed `deviceId`.            |
| `mobile_status`     | Read device identity, dimensions, frame counts, and errors. |
| `mobile_screenshot` | Get the current screen as an MCP image.                     |
| `mobile_tap`        | Tap normalized `x`, `y` coordinates.                        |
| `mobile_swipe`      | Drag from `from` to `to` over `durationMs` (50–5000).       |
| `mobile_type`       | Type up to 1024 ASCII characters into the focused field.    |
| `mobile_press`      | Press `GoHome`, `GoBack`, `AppSwitch`, or `Power`.          |
| `mobile_close`      | Disconnect the Devices panel.                               |
| `mobile_stop`       | Shut down the selected simulator/emulator.                  |

Coordinates range from 0 to 1, with (0,0) at the top left. Agents should capture
before interacting and capture again to verify the result; an input response
acknowledges dispatch, not an application assertion. Back and AppSwitch are
Android-only. This implementation does not provide accessibility-tree queries,
Maestro YAML execution, multitouch, or Unicode text entry.

A cold boot can outlast an individual tool request. If `mobile_open` returns
`starting: true`, poll `mobile_status` until connected or an error appears.
Startup has a three-minute timeout. Android startup logs are written to
`<vitre-home>/logs/android-emulator.log`.

If `mobile_stop` returns `stopping: true`, poll `mobile_status` until `stopped: true`
or an error appears. Input and screenshots are unavailable during shutdown and
after stopping. Shutdown continues if the panel is closed while it is in progress.

## Ownership and lifecycle

One device panel is active per desktop window and belongs to one local thread.
Agent control requires that thread to be selected in Vitre. Close the panel
before connecting from another thread. Human and agent input affect the same
device, so avoid simultaneous gestures.

Closing the tab or exiting Vitre releases the display and input connection,
leaving the device running. Hiding the panel preserves the connection. Cloud
threads, physical devices, Windows, and Linux are outside this initial scope.
Cancelling Android startup before it completes stops the emulator process that
Vitre just launched. Already-running devices are left alone. iOS booting is owned
by CoreSimulator and may finish after its panel is closed.

Stop uses Android's authenticated graceful shutdown operation or iOS's
`simctl shutdown` for the selected device only. It verifies shutdown before
reporting success; failure stays visible with Stop available to retry. Reopening
the picker refreshes the running state. Stopping does not delete the virtual device.

## Local verification

The macOS debug build was exercised with an iPhone 17 Pro simulator and a Pixel
10 emulator: connection, switching devices, Home/Back, taps, wheel scrolling,
keyboard entry, command-palette focus, and panel teardown. iOS animation samples
reached roughly 50–65 rendered frames/second; Android interaction reached about
47 at a 570 × 1280 preview. These are short debug-build samples, not a sustained
benchmark or a claim of Android Studio frame-rate parity. Android still needs
performance tuning. Wait for a tapped field to gain focus before typing.

Start/Stop was also verified on both platforms, including Android restart after
Stop, Close preserving a running emulator, shutdown continuing after tab closure,
and stopping the selected iOS simulator while another stayed booted. Toolbar and
stopped states were checked in light and dark themes.
