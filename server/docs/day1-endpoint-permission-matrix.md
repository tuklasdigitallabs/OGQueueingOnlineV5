# Day 1 Endpoint-Permission Matrix

This matrix captures the effective guard model implemented in `server/server.js` for Week 1 Day 1.

## Admin API

| Endpoint | Method | Guard |
|---|---|---|
| `/api/admin/auth/login` | POST | Public (rate limited) |
| `/api/admin/auth/me` | GET | `requireAuth` |
| `/api/admin/auth/logout` | POST | Session scope clear |
| `/api/admin/stream` | GET | `requireAuth` |
| `/api/admin/business-date` | GET | `requireAuth` |
| `/api/admin/close-day` | POST | `requirePerm("DAY_CLOSE")` |
| `/api/admin/branch` | GET | `requireAuth` |
| `/api/admin/branch` | POST | `requirePerm("SETTINGS_MANAGE")` |
| `/api/admin/settings` | GET | `requirePerm("SETTINGS_MANAGE")` |
| `/api/admin/settings` | POST | `requirePerm("SETTINGS_MANAGE")` |
| `/api/admin/users` | GET | `requirePerm("USERS_MANAGE")` |
| `/api/admin/users/create` | POST | `requirePerm("USERS_MANAGE")` |
| `/api/admin/users/update` | POST | `requirePerm("USERS_MANAGE")` |
| `/api/admin/users/delete` | POST | `requirePerm("USERS_MANAGE")` |
| `/api/admin/users/reset-pin` | POST | `requirePerm("USERS_MANAGE")` |
| `/api/admin/permissions` | GET | `requirePerm("PERMISSIONS_MANAGE")` |
| `/api/admin/permissions` | POST | `requirePerm("PERMISSIONS_MANAGE")` |
| `/api/admin/audit` | GET | `requirePerm("AUDIT_VIEW")` |
| `/api/admin/stats/today` | GET | `requireAuth` |
| `/api/admin/stats/ema14` | GET | `requireAuth` |
| `/api/admin/reports/*` | GET | `REPORT_EXPORT_CSV` or `AUDIT_VIEW` |
| `/api/admin/upload/status` | GET | `requirePerm("SETTINGS_MANAGE")` |
| `/api/admin/upload/test` | POST | `requirePerm("SETTINGS_MANAGE")` |
| `/api/admin/upload` | POST | `requirePerm("REPORT_EXPORT_CSV")` |
| `/api/admin/system/*` backup/restore | POST | `requirePerm("SETTINGS_MANAGE")` |
| `/api/admin/gdrive/oauth/start` | POST | `requirePerm("SETTINGS_MANAGE")` |
| `/api/admin/gdrive/oauth/callback` | GET | `requirePerm("SETTINGS_MANAGE")` |
| `/api/admin/gdrive/oauth/clear` | POST | `requirePerm("SETTINGS_MANAGE")` |

## Staff API

| Endpoint | Method | Guard |
|---|---|---|
| `/api/staff/auth/login` | POST | Public (rate limited) |
| `/api/staff/auth/me` | GET | `requireAuth` |
| `/api/staff/auth/logout` | POST | Session scope clear |
| `/api/staff/call-next` | POST | `requirePerm("QUEUE_CALL_NEXT")` |
| `/api/staff/call-again` | POST | `requirePerm("QUEUE_CALL_NEXT")` |
| `/api/staff/call-specific` | POST | `requirePerm("QUEUE_CALL_NEXT")` + override step-up logic |
| `/api/staff/seat-called` | POST | `requirePerm("QUEUE_SEAT")` |
| `/api/staff/skip` | POST | `requirePerm("QUEUE_SKIP")` |
| `/api/staff/clear-called` | POST | `requirePerm("QUEUE_CLEAR_CALLED")` |

## Public/Display API (not permission gated by admin/staff perms)

- `/api/queue/create` uses IP rate limiting.
- `/api/display/*` uses display token auth (`requireDisplayAuth`).
- `/api/public/*` and page routes are intentionally public/read-only where applicable.

## Day 1 Guard Changes Applied

- Added `requirePerm("SETTINGS_MANAGE")` to `/api/admin/gdrive/oauth/callback`.
- Tightened `/api/staff/call-specific` from `requireAuth` to `requirePerm("QUEUE_CALL_NEXT")`.
