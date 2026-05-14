# Phase Test Instructions

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
- Confirm the old activation token revoke / transfer release strip is no longer visible in Licensing.
- Confirm activating a new YL-GLO license is not blocked by another `ISSUED` YL-GLO draft.
- Confirm Branches shows YL-GLO as `ACTIVATED` after its active registry license is set.
- Confirm Branches shows `Perpetual` under Days Till Renewal for perpetual licenses.
- Confirm Admin and Super Admin users can enter the admin panel even if branch operational/license state is unavailable.
- Move between admin sections and confirm the logged-in user remains visible in the sidebar nav area.

Expected results:
- Licensing summary tiles render without changing existing license status details.
- The branch selector uses a searchable dropdown instead of a plain select.
- Existing branch license creation and license status actions still work.
- Branches reflects active registry license status before stale branch cache values.
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
