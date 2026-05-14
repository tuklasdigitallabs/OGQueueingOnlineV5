# Phase Test Instructions

## Admin Licensing Dashboard Update

Scope:
- Licensing section layout update in `server/static/admin.html`.
- Logged-in user display added to the admin sidebar navigation area.

Validation flows:
- Log in to the admin app as `SUPER_ADMIN`.
- Open Licensing.
- Confirm the top of the section shows tiles for total licenses, expiring soon in 30 days, branches with no licenses, and activated/non-activated counts.
- Confirm the branch selector appears below the tiles and filters branches while typing.
- Select a branch, click Generate Activation License, and confirm license number/key fields populate.
- Confirm Revoke Token and Release For Transfer remain accessible in Licensing.
- Move between admin sections and confirm the logged-in user remains visible in the sidebar nav area.

Expected results:
- Licensing summary tiles render without changing existing license status details.
- The branch selector uses a searchable dropdown instead of a plain select.
- Existing branch license creation, token revoke, transfer release, and license status actions still work.
- The logged-in user badge stays visible across admin sections after session context loads.

Known limitations:
- Manual browser verification is still required for exact visual layout.
