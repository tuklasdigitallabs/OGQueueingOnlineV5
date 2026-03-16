# Online Display Agent Plan

## Goal

Support the real store setup for the online QSYS model:

- VPS hosts the shared QSYS web/server platform
- staff/admin use phones, tablets, iPads, or laptops
- each branch TV is connected to a local Windows PC
- that PC runs a dedicated Electron display agent
- the display agent opens the branch display on the selected monitor
- queue audio plays from the TV PC, not from staff devices

This replaces the offline assumption that the display PC is also the server.

## Desired Store Flow

Per branch:

1. Staff uses:
   - `/qsys/b/:branchCode/staff-login`
2. Admin uses:
   - `/qsys/b/:branchCode/admin-login`
3. Guest QR points to:
   - `/qsys/b/:branchCode/guest`
4. Reception TV PC runs Electron display agent:
   - connects to `https://onegourmetph.com/qsys`
   - is paired to the branch
   - opens the display on the selected screen
   - stays in kiosk/fullscreen mode

## Non-Goals

- Do not require staff/admin to remotely "open display" from a normal browser
- Do not rely on users manually dragging a browser window to the TV screen
- Do not make the display page require normal staff/admin login

## Architecture

### 1. Web App

The online web app remains the source of truth for:

- queue state
- branch data
- auth
- reporting
- licensing

### 2. Electron Display Agent

The Electron app becomes a branch kiosk client, not the main server.

Responsibilities:

- save local kiosk config
- detect available displays on the PC
- let user choose the output monitor
- open the selected display route in fullscreen/kiosk mode
- persist monitor choice across restarts
- play chime/voice locally through the TV PC

### 3. Branch-Specific Display Routes

Canonical branch display routes should be:

- `/qsys/b/:branchCode/display`
- `/qsys/b/:branchCode/display-landscape`
- `/qsys/b/:branchCode/display-portrait`

The branch code in the path is the display context.

## Authentication Model

### Recommendation: Display Pairing Token

Do not use full staff/admin login for the TV PC.

Use a lightweight display auth model:

- each branch display gets a display key/token
- first-time setup pairs the local TV PC to the branch
- the agent stores the token locally
- display requests include the token
- server validates that token for that branch

Possible shapes:

- query param on first pairing:
  - `/qsys/b/YL-MOA/display?displayKey=...`
- then save locally and send via header on future requests:
  - `X-QSys-Display-Key: ...`

### Why not full login

- weaker operator separation
- unnecessary for a TV kiosk
- harder to support auto-start kiosk mode
- adds session expiry problems to the display device

## Electron Agent Config

Extend the local Electron config to include:

- `serverUrl`
  - example: `https://onegourmetph.com/qsys`
- `branchCode`
- `displayMode`
  - `landscape` or `portrait`
- `targetDisplayId`
  - Electron monitor id
- `displayKey`
  - saved pairing token
- `launchAtStartup`
  - optional Windows autostart flag

Current config already has:

- `branchCode`
- `displayMode`
- local kiosk URL values

This plan changes the Electron app from loading local display pages by default to loading online branch display URLs.

## Launcher UX

The launcher should become a `Display Agent Setup` screen.

Fields:

- Server URL
- Branch Code
- Display Mode
- Screen selector
- Display Key / Pairing button
- Start Display
- Test Audio
- Save Settings

Behavior:

1. Agent loads and detects all monitors
2. User selects the branch
3. User selects the target screen
4. User pairs the display
5. Agent launches the display window directly on that monitor

## Display Window Behavior

Display window should:

- open on `targetDisplayId`
- fullscreen/kiosk
- reopen on the same monitor after reboot
- reload if server connection drops and returns
- play audio through local system/TV output

## Staff/Admin Behavior

### In normal web mode

Staff/Admin pages should no longer assume they can control a remote display window.

So in online web mode:

- hide or disable:
  - `Open Display`
  - `Close Display`
  - local screen selection

Replace with:

- `Display URL`
- `Copy Display Link`
- `Open Display Page`
- optional `Download Display Agent`

### In Electron local mode

If the app is running as the local kiosk app, the existing display-controller functions can remain available.

## Server-Side Changes

### 1. Branch-Aware Display Routes

Add or normalize:

- `/b/:branchCode/display`
- `/b/:branchCode/display-landscape`
- `/b/:branchCode/display-portrait`

Display pages must resolve branch from the path, not global branch config.

### 2. Display Auth

Add tables such as:

- `display_devices`
  - `displayDeviceId`
  - `branchId`
  - `deviceName`
  - `displayKeyHash`
  - `status`
  - `lastSeenAt`
  - `createdAt`
  - `updatedAt`

Optional:

- `display_pairing_tokens`
  - one-time pairing flows

### 3. Display Presence / Telemetry

Add presence info for admin visibility:

- online/offline
- last heartbeat
- branch
- mode
- screen label

## Audio Strategy

Audio should play on the TV PC.

Recommended order:

1. Browser/Electron display page chime
2. Browser speech / audio clip sequence for spoken call
3. Optional Electron native speech fallback

The display device is the only place that should produce queue audio.

Staff phones/tablets should not be expected to play display audio.

## Rollout Plan

### Phase 1: Branch Display Routes

- add branch-specific display URLs
- make display pages resolve branch by path
- keep current display logic otherwise unchanged

### Phase 2: Agent Config + Screen Selection

- add `serverUrl`, `branchCode`, `targetDisplayId`, `displayMode`
- open the display on the selected monitor
- persist config locally

### Phase 3: Display Pairing/Auth

- implement branch-bound display token flow
- store locally after pairing
- validate on display requests

### Phase 4: Online Staff/Admin UX Cleanup

- hide local display-controller actions in normal browser mode
- show display link/copy tools instead

### Phase 5: Kiosk Hardening

- Windows auto-start
- reconnect handling
- health/status indicator
- test audio button
- watchdog/relaunch behavior

## Recommended First Commit

Start with the smallest realistic slice:

1. add branch-specific display routes
2. add Electron config fields:
   - `serverUrl`
   - `branchCode`
   - `targetDisplayId`
3. change launcher to:
   - choose screen
   - choose mode
   - save config
4. make Electron open:
   - `${serverUrl}/b/${branchCode}/display...`

That gives immediate value:

- online branch display
- automatic monitor placement
- no manual browser dragging

before pairing/auth hardening is added.

## Why This Is the Right Model

This approach fits the actual store reality:

- TV is at reception
- PC may be in the back office
- staff works from portable devices
- the server is centralized

It preserves the strength of the offline display workflow:

- fixed screen targeting
- kiosk behavior
- local audio output

while moving the queue system itself online.
