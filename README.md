# VIA

VIA is a local route editor and authorized mock-location playback tool.

The original idea was not to build a generic map dashboard. The core workflow is:

1. Search for a place or open a known area on the map.
2. Create a route by adding, dragging, reordering, or deleting nodes.
3. Choose polyline or smooth geometry, optionally close the route into a loop.
4. Set a running / movement speed and preview the route in the browser.
5. Connect an authorized test device through a local device bridge.
6. Send the simulated position along the route through platform-supported testing interfaces.

In short:

```text
Map editor -> motion playback -> local device bridge -> authorized test device
```

The project started from the idea of reproducing the useful workflow of `yinsuecci/mockrunning`, then making the route editor more general instead of hard-coding a single running track.

> [!IMPORTANT]
> ## Authorized Testing and Responsible Use Notice
>
> VIA is intended solely for **authorized development, QA, device testing, automation validation, location-dependent application testing, and legitimate research** on devices, accounts, applications, and environments that the user owns or is explicitly authorized to test.
>
> This project **does not provide, endorse, document, or support** instructions or tooling for:
>
> - software cracking, piracy, license circumvention, or DRM bypass;
> - unauthorized modification or tampering with third-party mobile applications;
> - code injection, process injection, DLL injection, runtime patching, binary patching, or similar techniques used to alter third-party software without authorization;
> - Hook / hooking frameworks or runtime instrumentation intended to intercept, modify, or falsify third-party application behavior;
> - bypassing anti-cheat, anti-fraud, integrity verification, attestation, jailbreak/root detection, anti-tamper, or other security controls;
> - concealing, removing, or falsifying platform mock-location indicators or equivalent test-environment markers;
> - obtaining unauthorized access to devices, accounts, credentials, private data, or protected services;
> - exploiting platform vulnerabilities, privilege-escalation techniques, jailbreak/root exploits, persistence mechanisms, or malware-like behavior;
> - evading platform, application, service-provider, enterprise-management, or regulatory restrictions.
>
> VIA uses platform-supported or documented testing interfaces wherever possible. Users are responsible for obtaining appropriate authorization and complying with applicable laws, software licenses, platform policies, contractual obligations, and organizational security requirements.
>
> The maintainers do not provide operational assistance for bypassing third-party protections or for adapting VIA into a circumvention, cheating, piracy, or unauthorized surveillance tool. Security-related discussions should remain limited to defensive engineering, interoperability, debugging, testing, and other legitimate purposes.

## Current features

- Leaflet map editor.
- Place search through a local Nominatim proxy.
- Add, drag, reorder, focus, and delete route nodes.
- Polyline and Catmull-Rom smooth route modes.
- Open route or closed-loop playback.
- Distance and ETA calculation.
- Adjustable movement speed.
- One shared Start / Pause playback button.
- Route JSON import / export.
- Local route library in browser storage.
- Direct OpenStreetMap tile loading by default, with optional local disk tile cache.
- Android ADB device discovery.
- Connect to an authorized Android device.
- Push the browser playback position to Android's `gps` test provider about once per second.
- Clear the test provider and restore the previous mock-location app-op mode when disconnecting.

## Device integration

VIA separates the public/web-facing route editor from the local device-control bridge. Device communication is intentionally performed on the user's own computer so USB, local pairing, ADB, usbmux, and other device transports are not exposed as public web APIs.

### Android — ADB

Android integration uses **Android Debug Bridge (ADB)** from the Android SDK Platform-Tools package.

Requirements:

- Android SDK Platform-Tools with `adb` available in `PATH`, or set `ADB_PATH` to the executable.
- Developer options enabled on the test device.
- USB debugging, or an already configured and authorized Android wireless-debugging connection.
- The computer must be explicitly authorized by the Android device.
- Android system location must be enabled.
- The ROM must expose the system test-provider commands used by `cmd location providers`; Android 12+ is recommended.

Current Android flow:

```text
VIA browser UI
    -> local VIA bridge
    -> adb
    -> Android shell
    -> LocationManager test provider
```

VIA currently uses Android's system test-provider mechanism and the `android:mock_location` app-op for the shell process. A typical session performs the following lifecycle:

1. discover authorized devices with `adb devices -l`;
2. verify the selected device is online;
3. inspect `cmd location help` for test-provider support;
4. verify system location is enabled;
5. temporarily allow the shell mock-location app-op when required;
6. create and enable a `gps` test provider;
7. send route coordinates using the system test-provider location command;
8. remove the test provider on clear/disconnect;
9. restore the previous app-op state when the session ends.

The Android bridge intentionally **does not attempt to hide Android's mock-location semantics**. Applications may detect test locations through platform APIs or other integrity mechanisms. VIA does not attempt to defeat those checks.

### iPhone / iOS — pymobiledevice3

iPhone integration is a **planned device-adapter path** for VIA and is not yet implemented in the current minimal repository. The intended implementation uses [`pymobiledevice3`](https://github.com/doronz88/pymobiledevice3) as the local Python transport layer.

Expected requirements for iOS support:

- Python 3.11+.
- `pymobiledevice3` installed in the VIA local bridge environment.
- A trusted pairing relationship between the iPhone and the host computer.
- Developer Mode enabled where required by the iOS version and the selected developer service.
- Apple Mobile Device Support on Windows, or an appropriate usbmux-compatible service on macOS/Linux.
- For newer iOS versions, a valid Remote Service Discovery (RSD) / developer tunnel may be required by `pymobiledevice3` for developer-service access.

Planned iOS architecture:

```text
VIA browser UI
    -> local VIA bridge
    -> pymobiledevice3
    -> usbmux / RSD developer services
    -> authorized iPhone test session
```

The iOS adapter must remain constrained to documented or legitimate developer/testing interfaces exposed by the connected device. VIA will not include jailbreak exploits, private-framework patching, third-party app hooking, binary modification, anti-tamper bypasses, or techniques intended to conceal simulated-location state from third-party applications.

### Capability boundaries

VIA is a location-playback test tool. Unless separately and explicitly implemented, it does not claim to simulate or modify:

- GNSS raw measurements, satellites, carrier phase, pseudorange, or baseband behavior;
- accelerometer, gyroscope, magnetometer, barometer, step counter, or other physical sensors;
- cellular, Wi-Fi, Bluetooth, or UWB radio measurements;
- third-party application memory, code, signatures, entitlements, or runtime control flow;
- operating-system integrity, attestation, anti-cheat, or anti-fraud state.

A coordinate being injected into a platform-supported test provider does not imply that the rest of the device's physical sensor environment has been reproduced.

## Android requirements

The Android bridge is local-only and requires:

- Android SDK Platform-Tools (`adb`) in `PATH`, or set `ADB_PATH`.
- USB debugging or an already configured ADB connection.
- The device must be authorized.
- System location must be enabled.
- The ROM must expose `cmd location providers ...` test-provider commands; Android 12+ is recommended.

VIA deliberately uses Android's official test-provider path. It does **not** hide the mock-location flag and does not attempt to bypass integrity or anti-cheat checks. Use it only on devices and apps you are authorized to test.

## Run

### Windows

```text
start.bat
```

### macOS / Linux

```bash
./start.sh
```

Or directly:

```bash
python app.py
```

The app listens only on `127.0.0.1` and starts at port `8787` (or the next free local port). Set `VIA_PORT` to choose a preferred port.

## Project structure

```text
VIA_mockrunning/
|-- app.py
|-- start.bat
|-- start.sh
|-- static/
|   |-- index.html
|   |-- app.css
|   `-- app.js
|-- examples/
|   `-- gdufe_foshan_track.json
|-- LICENSE
|-- README.md
`-- .gitignore
```

## Why the device bridge stays local

A public Cloudflare deployment can host the VIA website and route library later, but Cloudflare cannot directly access a USB / local ADB or usbmux-connected device on the user's computer. The long-term architecture should therefore be:

```text
VIA website (public)
        |
        +-- route editing / account / cloud storage
        |
        `-- local VIA Bridge on the user's computer
                    |
                    +-- ADB -> authorized Android device
                    |
                    `-- pymobiledevice3 -> authorized iPhone test session
```

The current repository intentionally starts with the original local workflow first.

## Route format

The current JSON format remains compatible with the earlier Route Studio drafts:

```json
{
  "format": "route-studio-v1",
  "name": "Campus loop",
  "routeStyle": "smooth",
  "closedLoop": true,
  "speedKmh": 5,
  "nodes": [
    {"lat": 23.212836, "lng": 112.845606},
    {"lat": 23.212575, "lng": 112.845357}
  ]
}
```

## Security and operational model

- The local bridge binds to `127.0.0.1` by default and is not designed to expose device-control endpoints directly to the LAN or public internet.
- Device-control actions should require explicit local user intent and an already authorized device connection.
- Pairing codes, device secrets, authentication material, and private user data must not be logged, committed, or sent to public services.
- A future public VIA website should communicate with the local bridge through a narrowly scoped local API with explicit origin checks, request validation, and user-visible consent for sensitive device actions.
- Cloud-hosted services must not be given direct device-control authority over arbitrary local hardware without a separate, authenticated, consent-based bridge design.

## Project scope vs. software license

The responsible-use notice above defines the **project's supported scope and maintainer policy**. It is not a substitute for legal advice and does not by itself change the permissions granted by the repository's software license. If a future hosted VIA service requires enforceable usage restrictions, those terms should be published separately as Terms of Service / Acceptable Use Policy rather than being mixed into the source-code license.

## License

MIT
