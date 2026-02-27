# QSys 2-Week Implementation Plan (Execution-Ready)

## Goal
Ship a stable, corporate-ready MVP upgrade for Admin + Staff with:
- hardened access control,
- reliable reports,
- cleaner UX and encoding fixes,
- operational backup/restore maturity,
- better observability and maintainability.

## How To Use This File
When ready, send this file back and say:  
`Start executing docs/implementation-plan-2weeks.md from Day 1.`

I will then implement tasks in order, validate each day’s scope, and report progress.

---

## Scope (2 weeks)

### Track A: Security and Permissions
- Ensure all admin/staff endpoints are permission-gated consistently.
- Align UI feature visibility with server permissions (`/auth/me`).
- Add explicit denied-state UX (disabled controls + reason text).

### Track B: Reports Reliability and Standards
- Normalize report filter behavior (single/range/last days/last hours).
- Standardize CSV schemas and metadata headers.
- Add export auditing (`who exported what, when, filters`).
- Fix any remaining report text/encoding inconsistencies.

### Track C: Backup/Restore Operations
- Keep default internal backups.
- Support export to selected folder.
- Add restore safety checks and post-restore verification.
- Add backup retention policy (configurable).

### Track D: Code Quality and Maintainability
- Add concise section comments in critical modules.
- Remove dead/legacy report code paths.
- Consolidate duplicate helper logic where safe.

### Track E: Observability
- Add structured logs for backup/restore/report actions.
- Add lightweight health diagnostics in admin system area.

---

## Week 1

## Day 1 - Baseline and Access Audit
- Inventory all admin/staff routes and required permissions.
- Produce endpoint-permission matrix.
- Add missing route guards.
- Verify no regressions for login and key flows.

### Acceptance
- No report/admin mutation endpoint is accessible without proper permission.
- Manual smoke: staff/admin login, queue actions, setup, reports export.

## Day 2 - UI Permission Alignment
- Load current user perms once and gate UI actions.
- Disable/hide unauthorized buttons in Admin/Staff.
- Add consistent toast/message for denied attempts.

### Acceptance
- Unauthorized actions cannot be triggered from UI.
- Role behavior matches backend permission matrix.

## Day 3 - Reports Filter Consistency
- Ensure `last_hours` / `sinceMs` handling is consistent across all report endpoints.
- Verify date-range and rolling-window behavior with test data.

### Acceptance
- Same filter inputs produce expected subset across all report types.

## Day 4 - CSV Schema Standardization
- Standardize headers/order for tickets, daily summary, custom summary, audit CSV.
- Add metadata rows: generatedAt, generatedBy, branchCode, filters.
- Ensure actor fields are included where available.

### Acceptance
- CSV files are consistent, machine-readable, and audit-friendly.

## Day 5 - Report UX Cleanup
- Remove stale/legacy report code paths.
- Align labels with actual computed metrics.
- Fix visible encoding/mojibake in Reports area.

### Acceptance
- Reports tab uses a single coherent flow and accurate wording.

---

## Week 2

## Day 6 - Backup/Restore Hardening
- Add pre-restore checks (backup exists, file valid, size > 0).
- Add restore backup-of-current before overwrite (safety net).
- Improve error surfaces in UI.

### Acceptance
- Restore path is safe, recoverable, and user-visible.

## Day 7 - Backup Retention and Housekeeping
- Add retention policy (example: keep latest 30 backups).
- Add optional manual cleanup endpoint/action.
- Audit-log cleanup actions.

### Acceptance
- Backup directory does not grow unbounded.

## Day 8 - Admin System Diagnostics
- Add system panel fields: DB path, backup count, last backup time, last restore time.
- Add health checks for writable directories and DB readiness.

### Acceptance
- Admin can quickly identify operational state without logs.

## Day 9 - Staff Reliability Pass
- Review queue action race points (call/seat/skip/override).
- Tighten transaction boundaries and user feedback.
- Add concise comments for critical logic paths.

### Acceptance
- Multi-station behavior remains deterministic in manual tests.

## Day 10 - QA, Regression, and Release Notes
- End-to-end smoke checklist.
- Verify reports, backups, restore restart behavior.
- Produce change summary and operator notes.

### Acceptance
- Ready for controlled rollout.

---

## Deliverables
- Updated `server.js` routes and guards.
- Updated `static/admin.html` and `static/staff.html` permission-aware UX.
- Stable report exports with consistent schemas.
- Backup/restore operations with safety checks + retention.
- Inline comments in critical sections.
- Operator-facing release notes.

---

## Non-Goals (for this 2-week window)
- Full multi-branch tenancy redesign.
- External cloud sync implementation.
- Major UI redesign/system-wide component refactor.

---

## Test Checklist (minimum)
- Admin with full permissions can run all actions.
- Staff cannot access admin-only routes/actions.
- Report filters return expected row ranges.
- Audit CSV includes actor fields when present.
- Backup creates file; export copies file; open-folder works.
- Restore succeeds and app relaunches.
- No critical console/server errors during smoke run.

---

## Execution Rules
- Prefer incremental commits by day/task.
- No destructive DB operations without explicit backup.
- Keep comments short, intent-focused, and stable.
- Validate behavior after each major patch.

