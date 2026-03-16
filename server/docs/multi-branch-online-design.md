# Multi-Branch Online Design

## Goal
Move QSYS Online from the current single-branch runtime model to an online multi-branch model without breaking the live `/qsys` deployment, current auth flows, or existing queue/report data.

This design assumes:

- one deployed QSYS Online service
- one organization/customer can operate multiple branches
- guest, staff, admin, and reporting all become branch-aware
- licensing becomes organization-centric, with branch entitlements under that organization

## Current State

The current online app is still fundamentally single-branch.

Key characteristics in the existing code:

- `branch_config` is a single row keyed by `id=1`
- `installation_state` is a single row keyed by `id=1`
- helpers like `getBranchCode()` and `getBranchName()` return one active branch globally
- nearly all queue, report, and admin queries use the current global branch helper
- route surfaces such as `/guest`, `/staff`, `/admin`, and `/super-admin` do not carry branch identity in the URL
- activation and renewal flows bind the installation to a single `branchCode`

This works for one branch, but it will not scale safely to multi-branch usage because:

- one global branch context cannot support multiple concurrent branch users
- one branch-bound license does not fit online org licensing
- admin and staff sessions need branch selection and branch access rules
- guest QR flows need stable branch-specific URLs

## Target Architecture

Use a three-level model:

1. platform/internal level
2. organization level
3. branch level

### Platform/Internal Level

Reserved for:

- internal `SUPER_ADMIN`
- provider setup
- license issuance and support tools
- organization creation, entitlement updates, branch slot management

### Organization Level

Represents the owning customer/business account.

Each organization has:

- `orgId`
- legal/display name
- status
- created/updated timestamps
- org-wide settings
- org-wide license entitlement

### Branch Level

Represents an operating site under the organization.

Each branch has:

- `branchId`
- `orgId`
- `branchCode`
- `branchName`
- timezone
- status: active, suspended, archived
- optional feature overrides
- per-branch business date
- per-branch display/device configuration

All queueing, reporting, and branch administration should ultimately become `branchId`-scoped.

## Licensing Model

### Recommendation

Do not keep the long-term model as "one installation = one branch license".

For online QSYS, the better licensing model is:

- one organization license
- one or more branch entitlements under that license
- optional add-on feature bundles

### License Layers

#### 1. Organization License

Stores:

- `licenseAccountId`
- `orgId`
- `licenseId`
- status
- issuedAt
- expiresAt
- renewal metadata
- signed payload / token hash / audit history

#### 2. Entitlements

Stores what the organization is allowed to use:

- `maxBranches`
- feature bundles
- optional limits:
  - displays
  - active staff
  - exports
  - advanced reporting

#### 3. Branch Allocations

Stores which branches are consuming branch slots:

- `allocationId`
- `orgId`
- `branchId`
- `licenseId`
- allocatedAt
- releasedAt
- status

This supports:

- enforcing branch count limits
- branch suspension without data loss
- branch transfer/reassignment workflows
- future billing alignment

### Activation Strategy

Keep the current activation token machinery only as a migration bridge.

Current state:

- `installation_state`
- `activation_token_usage`
- `activation_token_revocations`

Future state:

- activation is organization-level
- branch association is an entitlement/allocation decision
- server-side entitlement state is the main source of truth

That means:

- signed activation or renewal tokens can still be used
- but they should activate or renew the organization license, not hard-bind the whole app to one branch forever

## Routing Model

### Recommendation

Use branch-aware path routing for public and operator-facing pages.

Preferred pattern:

- `/qsys/b/:branchCode/guest`
- `/qsys/b/:branchCode/staff`
- `/qsys/b/:branchCode/admin`

Optional admin/global routes:

- `/qsys/org`
- `/qsys/super-admin`
- `/qsys/internal-tools`

### Why Branch-In-Path

Benefits:

- guest QR codes become branch-safe
- browser tabs are explicit about branch context
- staff/admin can work across multiple branches without ambiguous global state
- reports and exports can be tied clearly to a branch URL
- easier future caching and analytics segmentation

### Compatibility Bridge

During migration, keep existing routes working:

- `/qsys/guest`
- `/qsys/staff`
- `/qsys/admin`

Behavior during transition:

- if the user has exactly one allowed branch, redirect to that branch route
- if multiple branches are allowed, show a branch picker
- guest can redirect from legacy route to a configured default branch

## Session and Access Model

### Current Model

Current sessions effectively assume one active branch because branch identity is global.

### Target Model

Keep role sessions separate, but make branch selection explicit.

Suggested session shape:

- `staffUser`
  - identity
  - allowedBranches
  - selectedBranchId
- `adminUser`
  - identity
  - allowedBranches
  - selectedBranchId
  - org-wide admin flag if applicable
- `superAdminUser`
  - internal/platform identity

### Roles

Suggested role model:

- `SUPER_ADMIN`
  - internal/provider/platform tools
- `ORG_ADMIN`
  - manage all branches in an organization
- `BRANCH_ADMIN`
  - manage assigned branches
- `STAFF`
  - operate assigned branches

The current `ADMIN` role can be migrated into:

- `ORG_ADMIN` for multi-branch organizations
- or `BRANCH_ADMIN` for branch-limited admins

## Data Model Changes

### New Tables

Add:

- `organizations`
- `branches`
- `user_branch_access`
- `branch_settings`
- `branch_business_dates`
- `organization_licenses`
- `license_entitlements`
- `license_branch_allocations`

### Migration Strategy for Existing Tables

Do not remove `branchCode` immediately.

Recommended path:

1. add `branchId` where branch-scoped data exists
2. backfill `branchId` using the current single branch
3. update queries to prefer `branchId`
4. keep `branchCode` for display, CSV export, and compatibility

Tables likely requiring `branchId`:

- `queue_items`
- `daily_group_stats`
- audit/export/report tables that currently filter only by `branchCode`
- display/device tables
- branch-scoped settings tables

### Why Keep `branchCode`

`branchCode` is still useful for:

- public URLs
- operator recognition
- QR labels
- exports
- backward-compatible reporting

But it should stop being the sole foreign key for the system.

## Request-Scoped Branch Context

### Current Problem

Much of the server uses:

- `getBranchCode()`
- `getBranchName()`

That assumes one branch for the entire process.

### Target

Introduce request-scoped branch resolution.

Suggested helpers:

- `resolveRequestBranch(req)`
- `requireBranchContext(req, res, next)`
- `getRequestBranchId(req)`
- `getRequestBranchCode(req)`
- `getRequestBranchName(req)`

Resolution order:

1. route param branch code
2. explicit session-selected branch
3. only-allowed branch fallback
4. fail with branch selection required

This is the core refactor that should happen before most multi-branch feature work.

## UX Changes

### Guest

Guest should become branch-specific.

Preferred entry:

- branch QR points to `/qsys/b/:branchCode/guest`

Guest should not rely on one global branch config anymore.

### Staff

If the user belongs to one branch:

- go straight into that branch

If the user belongs to multiple branches:

- show a branch picker
- persist selected branch in session
- optionally allow switching branches from the staff header

### Admin

Branch-limited admin:

- opens branch-specific admin dashboard

Org admin:

- sees branch switcher
- can access branch management
- can view org-wide overview and cross-branch summaries

### Super Admin

Remains outside branch context except where explicitly managing one.

Primary responsibilities:

- organization licensing
- branch allocation
- feature provisioning
- provider/internal tools

## Reporting Model

### Branch Reports

Keep current reporting behavior as branch-scoped by default.

### Org Reports

Add later as separate surfaces:

- cross-branch totals
- branch comparison
- branch trends
- export by branch or by org

Do not merge org-level reports into current branch reports too early. That would complicate the migration.

## Display and Device Model

Displays and paired devices should become branch-bound records:

- one device belongs to one branch
- pairing flows must attach to `branchId`
- display state endpoints should resolve branch from the active session or explicit route context

## Security Notes

Multi-branch increases the need for strict access controls.

Must enforce:

- users only operate within assigned branches
- admin endpoints validate branch access, not just role
- branch switching is auditable
- org-level licensing changes remain internal/super-admin controlled

Search hiding and noindex rules are useful, but they are not the access control model.

## Recommended Rollout Plan

### Phase 1. Foundation

Add the new org/branch/license tables and create migration bootstrap:

- create one default organization
- create one default branch from current `branch_config`
- map current users to that branch
- preserve current app behavior

No public route changes yet.

### Phase 2. Request-Scoped Branch Context

Refactor server helpers so branch can be resolved per request rather than globally.

This is the most important technical milestone.

### Phase 3. Branch-Aware Sessions and Routing

Add:

- branch picker
- `/b/:branchCode/...` routes
- legacy route redirect/fallback logic

### Phase 4. Licensing Migration

Move from single installation activation to organization license plus branch allocations.

Keep current activation state only as a migration bridge until the new org license state is stable.

### Phase 5. Admin and Reporting Expansion

Add:

- org admin views
- branch management
- org-level reporting
- branch allocation management

## Implementation Order Recommendation

For this codebase, implement in this order:

1. schema foundation
2. request-scoped branch context helpers
3. user-to-branch access mapping
4. branch picker and branch-aware routes
5. branch-aware staff/admin/guest flows
6. licensing migration
7. org-level reporting and management

## Immediate Next Step

Before writing migration code, create a branch-context refactor plan against the current `server/server.js` hot spots:

- `branch_config id=1`
- `installation_state id=1`
- `getBranchCode()`
- `getBranchName()`
- role/session middleware
- guest/staff/admin route surfaces

That should be the first technical implementation document following this design note.
