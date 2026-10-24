# Phase Test Instructions

## Launcher Dashboard Organization

Scope:
- Visual organization and responsive layout in `server/static/launcher.html`.
- Existing launcher behavior and JavaScript bindings remain unchanged.

Validation flows:
- Open the Electron launcher and confirm the status summary appears first.
- Confirm Enabled at startup appears beside the top-right online status with Yes/No options.
- Select Yes and No, restart the launcher, and confirm the saved option remains selected.
- On Windows, confirm Yes enables and No disables the Electron login item.
- Confirm Open Display is the primary action and Shutdown App is visually separated.
- Confirm Display Setup is grouped into Branch, Display, Media, and Screen sections.
- Change branch, experience, orientation, playback source, local file, and target monitor.
- Save, reload, open, and shut down using the existing controls.
- Resize the launcher from desktop width to a narrow window and confirm sections stack without clipping or horizontal scrolling.

Expected results:
- All existing launcher controls continue to work.
- Status and primary actions are immediately visible.
- Related configuration fields are visually grouped and consistently spaced.

Known limitations:
- Exact visual balance should be checked in the packaged Electron window.

## Online Queue Grouping Update

Scope:
- A/B/C grouping in `server/server.js`, guest formatting, Admin dashboard, reports, schema comments, and demo seeding.
- Group A is 1-2 pax, Group B is 3-5 pax, and Group C is 6++ pax.
- Priority and regular numbering remain separate within each group.

Validation flows:
- Register regular and priority guests at pax 1, 2, 3, 5, 6, and 10.
- Confirm pax 1-2 receive A/PA, pax 3-5 receive B/PB, and pax 6+ receive C/PC.
- Confirm regular and priority counters start independently at 01.
- Open Admin Dashboard and confirm only A, B, and C appear with the new pax labels.
- Generate report previews and CSV files and confirm the pax buckets are `1-2`, `3-5`, and `6++`.
- Run the demo seed and confirm it creates only A/B/C records.

Expected results:
- D/PD is not generated, displayed, accepted by staff actions, or included in current reports.
- CSV preserves `1-2` and `3-5` as text values.
- Existing branch isolation and realtime updates remain unchanged.

Known limitations:
- Existing development records using D/PD should be cleared or reseeded before UI testing.

## Online Staff Queue Workflow Update

Scope:
- Clickable A/B/C summary cards and compact Lucide action toolbar in `server/static/staff.html`.
- Expandable ticket rows with Remove from Queue and Seat Guest.
- Server-side direct-seat and remove endpoints in `server/server.js`.
- Ten-ticket filtered pagination.

Validation flows:
- Click each summary card and confirm the ticket list filters to the selected group without scrolling.
- Confirm the toolbar shows local Lucide icons for all seven existing staff actions.
- Search and change status filters, then confirm the current page resets to page 1.
- Confirm the queue search field does not show browser autocomplete, saved-form, or password-manager suggestions.
- Create 11 or more tickets in one group and confirm only 10 appear per page with previous, next, and numbered controls.
- Expand a WAITING or CALLED row and confirm both row actions appear.
- Remove a ticket and confirm it becomes SKIPPED, creates `QUEUE_REMOVE`, and offers a 30-second Undo.
- Seat the current called ticket and the next eligible waiting ticket without an override reason.
- Seat a different waiting ticket and confirm a reason is required by both the UI and server.
- Confirm normal direct seating audits as `QUEUE_SEAT` and out-of-order seating audits as `QUEUE_SEAT_OVERRIDE`.
- Test the actions with users lacking `QUEUE_SKIP` or `QUEUE_SEAT`.

Expected results:
- Pagination appears only when filtered results exceed 10.
- Row expansion does not move or scroll the page.
- Permission checks, audit records, realtime refresh, and Undo remain active.

Known limitations:
- Confirmation and override-reason entry currently use browser dialogs.

## Online Landscape and Portrait Displays

Scope:
- Three-group landscape and portrait layouts.
- One global Now Serving panel.
- Stable priority and regular visible membership with hidden P/R counts.
- Guest queue QR only; Wi-Fi QR is not shown.

Validation flows:
- Open both display orientations with video enabled and disabled.
- Confirm Group A shows 1-2 pax, B shows 3-5 pax, and C shows 6++ pax.
- Confirm landscape shows up to 5 priority and 10 regular tickets per group.
- Confirm portrait shows up to 10 priority and 20 regular tickets per group.
- Add overflow tickets and confirm hidden counts exclude visible tickets.
- Call, seat, skip, or remove a visible ticket and confirm the oldest hidden ticket of the same type fills the opening.
- Reload and reconnect the display and confirm visible ticket membership remains stable.
- Change from a larger saved capacity to the current capacity and confirm no extra columns appear.
- Confirm only the Scan to Join Queue QR is displayed and it opens the current branch guest registration page.
- In landscape, confirm Now Serving and the guest QR use a 60/40 vertical split.
- Confirm the landscape queue instruction is above the QR and the QR fills the remaining tile space.
- In portrait, confirm Now Serving, video, and guest QR use a 30/45/25 vertical split.
- Confirm the portrait queue instruction is above the QR and the QR fills the remaining tile space without overlapping.
- Confirm Priority/Regular tiles retain equal outer spacing on their left and right edges in both orientations.
- Confirm the latest called ticket across A/B/C appears in the global panel with priority green and regular maroon.
- Confirm queue-only mode removes video and reallocates the available space.

Expected results:
- No D/PD, ellipsis tiles, Wi-Fi QR, clipping, overlap, text selection, or horizontal scrolling appears.
- Recall replays the existing pulse and announcement behavior.

Known limitations:
- Exact TV typography and media crop should be visually checked on the target landscape and portrait resolutions.

## Guest Ticket Live Status

Scope:
- Mobile ticket confirmation layout in `server/static/ticket.html`.
- Branch/group live status endpoint in `server/server.js`.
- Socket.IO refresh, five-second polling fallback, almost-there messaging, and opt-in call alerts.

Validation flows:
- Register a guest and confirm the browser opens `/static/ticket.html?id=<ticket-id>`.
- Confirm the page shows the queue code, guest, branch, pax, and priority-aware group badge.
- Confirm Now Serving is the CALLED ticket from the same branch, business date, and A/B/C group.
- Confirm waiting position orders priority tickets first and then queue number ascending.
- Confirm Position in Group starts at 1 and Ahead of You is position minus one.
- Move the ticket into positions 3, 2, and 1 and confirm the almost-there banner appears.
- Call, seat, skip, remove, and Undo the ticket and confirm the page updates through Socket.IO.
- Disconnect Socket.IO while HTTP remains available and confirm five-second polling continues updating the page.
- Disconnect the network and confirm the connection indicator and warning banner change appropriately.
- Enable call alerts, use Test Alert, and confirm supported sound, vibration, and browser notifications.
- Call the guest ticket and confirm alerts fire only after the guest has opted in.

Expected results:
- Ticket status shows WAITING, CALLED, SEATED, or SKIPPED accurately.
- Same-group position excludes tickets from other branches, business dates, and groups.
- Cached ticket details remain visible while the page reconnects.

Known limitations:
- Browser notifications require permission and generally require HTTPS.
- Mobile browsers may require an explicit tap each session before sound playback is allowed.

## Admin Licensing Dashboard Update

Scope:
- Licensing section layout update in `server/static/admin.html`.
- Branch license conflict rule update in `server/server.js`.
- Logged-in user display added to the admin sidebar navigation area.

Validation flows:
- Log in to the admin app as `SUPER_ADMIN`.
- Open Licensing.
- Confirm the top of the section shows tiles for total licenses, expiring soon in 30 days, branches with no licenses, and activated/non-activated counts.
- Confirm the branch selector appears below the tiles and filters branches while typing.
- Confirm there is no duplicate logged-in user badge in the upper-right top bar.
- Confirm Licensing uses tabs for Dashboard, Create, Branch Licenses, and License History.
- Select a branch, click Generate Activation License, and confirm license number/key fields populate.
- Confirm the generated branch license form defaults Initial Status to `Active`.
- Confirm the old activation token revoke / transfer release strip is no longer visible in Licensing.
- Confirm activating a new YL-GLO license is not blocked by another `ISSUED` YL-GLO draft.
- Confirm Branches shows YL-GLO as `ACTIVATED` after its active registry license is set.
- Confirm a newly created time-bound license with the default `Active` status lets the assigned staff user log in.
- Confirm Branches shows `Perpetual` under Days Till Renewal for perpetual licenses.
- Confirm Admin and Super Admin users can enter the admin panel even if branch operational/license state is unavailable.
- Move between admin sections and confirm the logged-in user remains visible in the sidebar nav area.

Expected results:
- Licensing summary tiles render without changing existing license status details.
- The branch selector uses a searchable dropdown instead of a plain select.
- Existing branch license creation and license status actions still work.
- Branches reflects active registry license status before stale branch cache values.
- Time-bound branch license creation activates the branch by default unless `Issued` is deliberately selected.
- Admin and Super Admin branch lists use active branch records for admin access instead of blocking on operational license state.
- The logged-in user badge stays visible across admin sections after session context loads.
- Super Admin licensing tools are available even when optional licensing feature flags are not provisioned.

Known limitations:
- Manual browser verification is still required for exact visual layout.

## Admin System Tabs Update

Scope:
- System section tabbed layout in `server/static/admin.html`.
- System database, API health, and store online status endpoints in `server/server.js`.

Validation flows:
- Open Admin > System.
- Confirm tabs are visible: Overview, Database, API Health, Stores, Diagnostics.
- Confirm Overview shows branch, business date, API health summary, and online store summary.
- Open Database and confirm DB path, size, SQLite info, integrity check, and table counts load.
- Open API Health and confirm endpoint checks show OK/FAIL rows.
- Open Stores and confirm each branch shows online/offline plus staff/admin/display counts.
- Log in to Staff for a branch, refresh Stores, and confirm that branch shows online within the recent-session window.
- Open Diagnostics and confirm backup status plus existing support bundle, integrity check, self-test, and seed buttons are still accessible.

Expected results:
- System page is organized by tabs instead of separate crowded cards.
- Database and API health status load without requiring optional feature flags.
- Store online status uses recent staff/admin sessions and connected display sockets.
- Existing diagnostics actions still work.

Known limitations:
- Store online status is based on sessions touched in the last 2 minutes; idle browser tabs may show offline until they make another request.

## Admin Reports Tabs Update

Scope:
- Reports section tabbed layout in `server/static/admin.html`.
- Generated report preview cleanup in `server/static/admin.html`.

Validation flows:
- Open Admin > Reports.
- Confirm tabs are visible: Builder, Generated View, Insights, Schedule.
- Confirm Builder contains the report type, date scope, quick presets, wait reference, and generate/export/print actions.
- Generate Custom Summary and confirm the app switches to Generated View.
- Confirm Custom Summary uses a clean report header, summary stats, and right-aligned numeric columns.
- Generate Raw Data (Tickets) and confirm status/priority values render as compact badges with numeric values aligned.
- Generate Daily Summary and confirm the table remains paged and grouped by date.
- Confirm Insights and Schedule tabs remain available only when the corresponding report features are provisioned.

Expected results:
- Reports controls are separated from generated output and optional report tools.
- Generated report previews look cleaner and more professional without changing CSV exports.
- Existing generate, export, print, pagination, insights, and schedule actions still work.

Known limitations:
- Audit Logs remains CSV-only and does not show a preview in Generated View.

## Offline UI parity on QSYS Online — 2026-10-24

Required setup:
- A running test instance with two active, licensed branches; Admin, supervisor (`AUDIT_VIEW`), and limited-permission Staff accounts; regular and priority test tickets; and a configured display video. Use test data and do not reset a live queue.

Scope:
- Ticket confirmation priority guidance; Guest keeps its existing online registration design and branch-aware protections.
- Staff light tablet layout, Current Call panel, More actions, queue filters/reset, stale-data warning, duplicate-action guard, preferences, and branch-scoped recent activity for users with `AUDIT_VIEW`.
- Admin light visual system, grouped navigation, dashboard charts, and filtering of the latest loaded audit events.
- Landscape and portrait Display layouts from offline QSYS with a single branch-specific guest QR. Online display auth, media, sockets, and audio remain in the existing core.

Validation flows:
- On a phone, register a regular ticket and a priority ticket through the Guest page. Confirm branch code, status, and ticket confirmation; the priority ticket should show the eligibility note. Retry after a network interruption and confirm the existing recovery messages.
- On a tablet, open Staff in at least two branches. Select each group; check Current Call, counts, queue search, status filters, Longest Wait, Reset filters, and ten-row paging. Confirm the search field does not trigger password-manager suggestions.
- As Staff, call, recall, seat, skip, clear, and override tickets; confirm the existing permission and out-of-order reason checks still apply. Disconnect the server for more than 15 seconds and confirm a stale warning prevents ticket changes until a successful refresh. Try two quick clicks on one action and confirm only one request succeeds.
- Set the long-wait threshold and refresh Staff. Confirm the preference persists for that user and branch, highlights only waiting rows, and leaves queue order unchanged. As a supervisor with `AUDIT_VIEW`, open Recent activity and verify it contains only the selected branch's queue actions. Check the limited-access staff message.
- On Admin desktop and tablet, navigate every section, including Branches and Licensing. Open Dashboard charts; change dates and group, then switch branches and confirm the chart label and data change without showing the previous branch. Test an invalid range and an empty date range. Filter the latest loaded audit events by text and date.
- Open both Display orientations with video on and off. Confirm the large Now Serving ticket, A/B/C waiting columns, hidden counts, resizing, video playback, recall animation/chime, and branch-specific guest QR. Confirm no Wi-Fi QR appears and guest scans open the intended branch.

Expected results:
- The five flows match the approved offline visual direction while retaining online branch routing, licensing, permissions, and queue rules.
- Admin chart and Staff activity requests reveal data only for the signed-in user's selected branch.
- No existing records or database schema are changed by this update.

Known limitations:
- Isolated local browser screenshots confirmed Admin Dashboard, Staff, and both Display orientations with video on and off. User screenshots from branch YL-MOA also confirmed Guest registration, Ticket confirmation, Staff, Admin, and landscape Display. Staff queue actions, multiple live branches, and kiosk audio still require predeployment acceptance testing.
- The Wi-Fi QR remains protected and is intentionally absent from Display.

Recovery:
- Verify `.restore-points/online-ui-before-offline-parity-2026-10-24.tar.gz` with its `.sha256` file, then restore only affected source paths from that archive. Do not restore a production database for this UI change.
