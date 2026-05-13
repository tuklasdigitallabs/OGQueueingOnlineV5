============================================================
QSYS OFFLINE – COMPLETE SYSTEM README
Standalone Local Queue Management System
Electron + Node.js + Express + SQLite
============================================================

CURRENT ONLINE/VPS NOTES
------------------------------------------------------------

This repo is now also used for QSys Online deployment at:
https://onegourmetph.com/qsys

Current live status as of 2026-04-14:
- GitHub Actions CI/CD is working end-to-end for the VPS deployment.
- `CI` validates pushes and PRs.
- `Deploy VPS` connects over SSH and deploys to the live server successfully.
- Public health endpoint is live at `https://onegourmetph.com/qsys/api/health`.
- Public test page is live at `https://onegourmetph.com/qsys/test`.
- Nginx routing to the QSys app is healthy.
- Branch licensing is active:
  - newly created/imported branches start `UNACTIVATED`
  - unactivated branches are blocked from guest, staff, and display access
- Guest ticket creation protection is active:
  - rate limiting is enabled
  - honeypot field is enabled
- Super Admin backup and restore is working for the live database.
- Admin shows read-only backup status.
- Reports export correctly from the hosted `/qsys` path.
- Raw ticket exports now use clearer filenames and readable re-call times.
- `Clear Called` now preserves historical called timestamps for reporting/audit.
- Admin Setup has been simplified for the online model:
  - Setup keeps Queue Settings, Display Setup, and Authentications
  - branch record management and QR actions live under Branches
  - Display Setup is DB-backed and shared with the local Display Agent

The online deployment runs the same Node/Express app in Docker:
- VPS app checkout: /opt/og-qsys/app
- Runtime/data folder: /opt/og-qsys
- App container: og-qsys-app
- App port: 3100
- Public base path: /qsys
- Nginx container: og_nginx

VPS deploy:

cd /opt/og-qsys/app
git pull --ff-only origin main
bash scripts/deploy_qsys_vps.sh
curl -s http://127.0.0.1:3100/api/health
curl -s https://onegourmetph.com/qsys/api/health

GitHub Actions CI/CD:
- workflow files: `.github/workflows/ci.yml` and `.github/workflows/deploy-vps.yml`
- setup guide: `CI_CD_VPS_SETUP.md`
- required repo secrets:
  - `VPS_HOST`
  - `VPS_USER`
  - `VPS_SSH_KEY`
- common working values on the current VPS:
  - `VPS_HOST=76.13.214.71`
  - `VPS_USER=ogadmin`
  - `VPS_APP_DIR=/opt/og-qsys/app`

Important 2026-04-07 updates:
- Business date auto-rollover now advances stale persisted dates on request.
- Guest ticket page shows the current waiting position within the ticket's pax group.
- Admin media uploads are converted to web-safe MP4 using FFmpeg.
- Docker image installs FFmpeg for VPS transcoding.
- Cloud media responses allow cross-origin playback by the local Electron display agent.
- Existing uploaded videos must be deleted and re-uploaded to generate converted *-websafe.mp4 files.

Recommended display video output:
- Container: MP4
- Video codec: H.264
- Pixel format: yuv420p
- Audio codec: AAC
- Even width/height
- Faststart enabled

ONLINE ADMIN / OPERATIONS NOTES
------------------------------------------------------------

Admin:
- Branches tab is now the source of truth for branch records, guest QR, and branch activation visibility.
- Setup tab is for queue behavior, shared display behavior, and report/auth integrations only.
- Display settings saved in Admin are stored in the database and shared with the local Electron Display Agent.

Super Admin:
- Branch licensing and feature provisioning are active.
- Backup & Restore is available in Super Admin and is intended for database protection.
- Current default retention policy keeps 14 backups.

Display Agent:
- Installer packaging is prepared to bundle FFmpeg for local media conversion.
- Shared display settings are synced through the server database.
- Device-only local settings such as monitor selection remain local to the machine.


SYSTEM OVERVIEW
------------------------------------------------------------

QSys Offline is a standalone queue management system
designed to operate fully without internet connectivity.

It runs on:
- A Windows PC (Server PC)
- Electron desktop application
- Local Node.js + Express server
- SQLite database
- LAN network access

All modules (Guest, Staff, Admin, Display) operate
from a single local server instance.

No cloud.
No Firebase.
No external dependencies once installed.


============================================================
SYSTEM ARCHITECTURE
============================================================

SERVER PC
- Runs Electron app
- Hosts local Express server
- Stores SQLite database
- Serves Guest, Staff, Admin, and Display routes

CLIENT DEVICES (LAN)
- Staff tablets/laptops
- Guest phones (via local IP)
- Display TV (browser or embedded window)

NETWORK
- Works on local WiFi router
- Internet not required
- All devices must be on same network

============================================================
MODULE BREAKDOWN
============================================================

------------------------------------------------------------
1) GUEST MODULE
------------------------------------------------------------

Purpose:
Queue registration interface for customers.

Access:
http://<LOCAL-IP>:3000/guest

Features:
- Name input
- Pax selection
- Priority dropdown (None / Senior / PWD)
- Auto queue number assignment
- Auto group assignment (A/B/C etc.)
- Priority override → Group P
- Confirmation screen with large queue number

Data Stored:
- queueNum
- name
- pax
- group
- branch
- timestamp (server)
- createdAt (local time Asia/Manila)
- status (waiting)

Limitations:
- Guests cannot edit or delete queue after submission


------------------------------------------------------------
2) STAFF MODULE
------------------------------------------------------------

Purpose:
Operational queue management.

Access:
http://<LOCAL-IP>:3000/staff

Features:
- Staff login
- Branch-based queue view
- View waiting list by group
- Call queue
- Call Again
- Mark seated
- Track number of times called
- Display queued timestamp
- Compute waiting time metrics
- Live updates via socket connection

Queue Actions:
- waiting → called
- called → seated

Security:
- Staff login required
- Separate session from Admin


------------------------------------------------------------
3) DISPLAY MODULE
------------------------------------------------------------

Purpose:
Public queue display screen (TV or monitor).

Access:
http://<LOCAL-IP>:3000/display
(or portrait/landscape variants)

Features:
- Now Serving hero number
- Waiting queue tiles
- Priority styling
- Regular tile background: rgb(141, 6, 1)
- Priority tile color: green
- Automatic live updates
- Video mode with cloud media-library playback
- Uploaded videos are normalized to web-safe MP4 on the server when FFmpeg is available

VOICE CALLING FEATURE:

When Staff presses CALL:
1) Chime plays
2) 1-second pause
3) Voice announcement plays

When Staff presses CALL AGAIN:
- Same sequence replays

Audio:
- Local audio files only
- No internet required
- No TTS
- Stored inside project audio folder

Works for:
- Regular groups
- Priority group P

============================================================


------------------------------------------------------------
4) ADMIN MODULE
------------------------------------------------------------

Purpose:
System management and reporting.

Access:
http://<LOCAL-IP>:3000/admin

Features:
- Admin login (separate session)
- Branch configuration
- Display orientation setting
- Media library management for General Media and Branch Media
- Media upload conversion to web-safe MP4 through FFmpeg
- Reporting dashboard
- Summary metrics:
    • Waitlist count per group
    • Pax totals per group
    • Priority totals
    • Seated counts
    • Average time to called
    • Average time to seated
- CSV export

Reporting filters:
- Date-based
- Historical data selection


============================================================
DATABASE
============================================================

Engine:
SQLite (local file database)

Core Data:
- queues
- users
- branches
- logs

Data is stored locally on the Server PC.

Backup recommended:
Manual backup of database file.


============================================================
REAL-TIME SYSTEM
============================================================

Uses:
- Socket communication between Staff and Display

Triggers:
- Call queue
- Call again
- Update status
- Live hero number update


============================================================
OFFLINE CAPABILITY
============================================================

System fully works without internet.

Requirements:
- Local router active
- Devices connected to same network
- Server PC running

If internet drops:
- System continues operating
- No data loss


============================================================
INSTALLATION SUMMARY
============================================================

1) Install built .exe on Server PC
2) Launch application
3) Note local IP (example 192.168.1.x)
4) Connect devices to same WiFi
5) Access modules via browser

No cloud setup required.


============================================================
EXPECTED SYSTEM BEHAVIOR CHECKLIST
============================================================

GUEST
[✓] Can register queue
[✓] Priority override works
[✓] Large queue confirmation

STAFF
[✓] Login works
[✓] Call works
[✓] Call Again works
[✓] Called count increments
[✓] Wait times compute
[✓] Timestamp visible

DISPLAY
[✓] Hero number updates
[✓] Tiles update live
[✓] Chime plays
[✓] Voice plays
[✓] 1-second pause works
[✓] Priority styling works

ADMIN
[✓] Login works
[✓] Reports generate
[✓] CSV export works
[✓] Display settings save


============================================================
KNOWN LIMITATIONS
============================================================

- Single-branch per installation
- No cloud backup
- No SMS notifications
- No customer accounts
- No payment integration
- No loyalty system
- No centralized multi-branch dashboard


============================================================
TROUBLESHOOTING
============================================================

If Staff cannot connect:
- Check local IP
- Check firewall
- Confirm server is running

If Display has no audio:
- Check audio file path
- Check display-core.js
- Check browser console

If Display video has MEDIA_ELEMENT_ERROR / Format error:
- Confirm the uploaded file was re-uploaded after FFmpeg conversion was deployed.
- Converted cloud files should end in *-websafe.mp4.
- Check the media URL headers:
  curl -sD - -o /dev/null "https://onegourmetph.com/qsys/media/library/<id>/<file>?branchCode=<branch>"
- Expected headers include:
  Content-Type: video/mp4
  Cross-Origin-Resource-Policy: cross-origin
  Access-Control-Allow-Origin: *
- Check codecs inside the container:
  docker exec og-qsys-app ffprobe -hide_banner -v error -show_entries stream=index,codec_type,codec_name,profile,pix_fmt,width,height -of json "/var/lib/qsys/media-library/.../<file>-websafe.mp4"
- Expected video codec is h264 with yuv420p. Expected audio codec is aac.

If Admin summary fails:
- Check server logs
- Verify database integrity

If LAN works but internet down:
- Normal behavior (system is offline-based)


============================================================
PRODUCT POSITIONING
============================================================

This is a fully standalone restaurant queue system
designed for:

- Restaurants
- Food courts
- Clinics
- Government counters
- Small to medium establishments

Strength:
Reliable offline performance.

============================================================
END OF FILE
============================================================
