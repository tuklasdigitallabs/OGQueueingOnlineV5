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
- Move between admin sections and confirm the logged-in user remains visible in the sidebar nav area.

Expected results:
- Licensing summary tiles render without changing existing license status details.
- The branch selector uses a searchable dropdown instead of a plain select.
- Existing branch license creation and license status actions still work.
- The logged-in user badge stays visible across admin sections after session context loads.
- Super Admin licensing tools are available even when optional licensing feature flags are not provisioned.

Known limitations:
- Manual browser verification is still required for exact visual layout.
