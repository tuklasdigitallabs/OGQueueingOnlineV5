============================================================
QSYS OFFLINE – COMPLETE SYSTEM README
Standalone Local Queue Management System
Electron + Node.js + Express + SQLite
============================================================

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
