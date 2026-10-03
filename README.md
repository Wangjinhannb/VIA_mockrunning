# VIA

VIA is a local route editor and authorized mock-location playback tool.

The original idea was not to build a generic map dashboard. The core workflow is:

1. Search for a place or open a known area on the map.
2. Create a route by adding, dragging, reordering, or deleting nodes.
3. Choose polyline or smooth geometry, optionally close the route into a loop.
4. Set a running / movement speed and preview the route in the browser.
5. Connect an Android test device over ADB.
6. Send the simulated position along the route to Android's system test provider.

In short:

```text
Map editor -> motion playback -> local ADB bridge -> Android mock location
```

The project started from the idea of reproducing the useful workflow of `yinsuecci/mockrunning`, then making the route editor more general instead of hard-coding a single running track.

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

A public Cloudflare deployment can host the VIA website and route library later, but Cloudflare cannot directly access a USB / local ADB device on the user's computer. The long-term architecture should therefore be:

```text
VIA website (public)
        |
        +-- route editing / account / cloud storage
        |
        `-- local VIA Bridge on the user's computer
                    |
                    `-- ADB -> authorized Android device
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

## License

MIT
