# Multi-Branch Phase 1: Branch Context Refactor Plan

## Purpose

This document turns the multi-branch design into the first concrete implementation phase for the current codebase.

Phase 1 is intentionally narrow:

- no public multi-branch launch yet
- no org-wide admin UI yet
- no full licensing migration yet

Instead, this phase builds the server-side foundation so the app can stop assuming one global branch for the entire process.

## Current Single-Branch Hot Spots

The current code depends on one active branch from global helpers:

- `branch_config` single row: `server/server.js`
- `getBranchCode()`: around `server/server.js:1157`
- `getBranchName()`: around `server/server.js:1160`
- `getBranchConfigSafe()`: around `server/server.js:1147`

These helpers are used in many places:

- guest and QR routes
- staff queue actions
- admin stats and reports
- display/device APIs
- licensing status responses
- queue recovery and forecast tools
- socket hello payloads

The problem is not just the data model. It is that branch identity is currently process-global rather than request-scoped.

## Phase 1 Deliverables

This phase should produce:

1. new branch foundation tables
2. migration bootstrap from the current single branch
3. request-scoped branch resolution helpers
4. branch access mapping for users
5. minimal branch selection flow for authenticated users
6. compatibility layer so existing routes still work

## Non-Goals for Phase 1

Do not do these yet:

- remove `branchCode` from existing tables
- remove `branch_config`
- remove `installation_state`
- launch `/b/:branchCode/...` publicly as the only route style
- implement org-wide reporting rollups
- fully replace current activation model

## Schema Work

### New Tables

Add these tables first.

#### `organizations`

Fields:

- `orgId TEXT PRIMARY KEY`
- `orgCode TEXT UNIQUE`
- `orgName TEXT NOT NULL`
- `status TEXT NOT NULL`
- `createdAt INTEGER NOT NULL`
- `updatedAt INTEGER NOT NULL`

#### `branches`

Fields:

- `branchId TEXT PRIMARY KEY`
- `orgId TEXT NOT NULL`
- `branchCode TEXT NOT NULL`
- `branchName TEXT NOT NULL`
- `timezone TEXT NOT NULL`
- `status TEXT NOT NULL`
- `isDefault INTEGER NOT NULL DEFAULT 0`
- `createdAt INTEGER NOT NULL`
- `updatedAt INTEGER NOT NULL`

Indexes/constraints:

- unique `(orgId, branchCode)`
- index on `orgId`

#### `user_branch_access`

Fields:

- `id TEXT PRIMARY KEY`
- `userId TEXT NOT NULL`
- `branchId TEXT NOT NULL`
- `roleScope TEXT NOT NULL`
- `createdAt INTEGER NOT NULL`

Indexes/constraints:

- unique `(userId, branchId)`
- index on `branchId`

#### `branch_business_dates`

Fields:

- `branchId TEXT PRIMARY KEY`
- `businessDate TEXT NOT NULL`
- `updatedAt INTEGER NOT NULL`

This separates business date from global branch config.

#### `branch_settings`

Fields:

- `branchId TEXT NOT NULL`
- `key TEXT NOT NULL`
- `value TEXT`
- `updatedAt INTEGER NOT NULL`

Constraint:

- primary key `(branchId, key)`

### Transitional Columns

For existing branch-scoped tables, add `branchId` later in a controlled migration.

Do not do that in the first table bootstrap step unless required for a specific route refactor.

## Bootstrap Migration

### Goal

Create a default organization and default branch from the current single-branch system.

### Bootstrap Source of Truth

Use existing values from:

- `branch_config id=1`
- current `branchCode`
- current `branchName`
- current timezone

### Bootstrap Steps

1. create one organization, for example:
   - `orgCode = DEFAULT`
   - `orgName = current branch name or "Default Organization"`

2. create one branch under that organization:
   - `branchCode = current branch code`
   - `branchName = current branch name`
   - `isDefault = 1`

3. assign all current users to that default branch in `user_branch_access`

4. copy current business date into `branch_business_dates`

This keeps the app behavior unchanged while introducing the new branch model.

## Request-Scoped Branch Resolution

### New Core Helpers

Introduce these helpers:

- `listUserBranchAccess(userId)`
- `getBranchById(branchId)`
- `getBranchByCode(branchCode)`
- `getDefaultBranch()`
- `resolveRequestBranch(req)`
- `requireResolvedBranch(req, res, next)`
- `getResolvedBranch(req)`

### Resolution Order

Use this order:

1. explicit route param `req.params.branchCode`
2. explicit query param only for transitional internal use
3. session-selected branch
4. if user has exactly one assigned branch, use it
5. fallback to default branch only for legacy public compatibility where appropriate
6. otherwise return branch selection required

### Request Attachment

Once resolved, attach branch context to the request:

- `req.qsysBranch = { branchId, orgId, branchCode, branchName, timezone, status }`

This object becomes the new branch source of truth for request handling.

## Transitional Compatibility Helpers

### Why Needed

There are too many current usages of `getBranchCode()` and `getBranchName()` to replace in one edit safely.

### Transitional Approach

Keep the old helpers temporarily, but introduce request-scoped variants:

- `getRequestBranchCode(req)`
- `getRequestBranchName(req)`
- `getRequestBranchTimezone(req)`

Then refactor routes gradually from:

- `getBranchCode()`

to:

- `getRequestBranchCode(req)`

### Temporary Fallback Behavior

Until all routes are migrated:

- legacy code may still use the default branch
- branch-aware code must use `req.qsysBranch`

This should be visible and deliberate, not hidden.

## User Access and Session Changes

### Session Fields

Extend authenticated sessions with:

- `selectedBranchId`
- `allowedBranchIds`

Suggested shapes:

- `req.session.staffUser.selectedBranchId`
- `req.session.adminUser.selectedBranchId`

### Login Behavior

On login:

1. load all assigned branches for the user
2. if exactly one branch is assigned:
   - set `selectedBranchId`
3. if multiple branches are assigned:
   - leave `selectedBranchId` unset until branch picker selection

### Super Admin

Do not force branch selection into `superAdminUser` yet.

Super admin should remain platform-scoped unless operating on a branch-specific screen.

## Branch Picker

### Goal

Support users with multiple branch assignments without breaking existing login flows.

### Initial Version

Create a simple post-login branch picker page for:

- staff
- admin

Trigger it only if the user has more than one assigned branch and no selected branch yet.

### Phase 1 Scope

This can be very small:

- list assigned branches
- choose one
- store `selectedBranchId` in session
- redirect to existing legacy route

No need for polished multi-branch admin UI yet.

## Route Refactor Order

Do not refactor all routes at once.

### Step 1. Safe Read Routes

Refactor first:

- `/api/admin/business-date`
- `/api/health`
- `/api/public/business-date`
- `/api/staff/auth/me`
- `/api/admin/auth/me`
- `/api/admin/branch`

These are lower-risk and establish the branch context flow.

### Step 2. Guest and QR

Refactor:

- `/guest`
- `/qr/guest`
- `/api/guest/ticket`

These need stable branch context for future branch-in-path QR routing.

### Step 3. Staff Read Surfaces

Refactor:

- `/staff`
- `/api/staff/queue-tools`
- list/read endpoints used by the staff page

### Step 4. Staff Mutations

Refactor:

- `call-next`
- `call-again`
- `call-specific`
- `seat-called`
- `skip`
- `clear-called`
- `undo-last`
- `reopen-ticket`

These are the highest-risk branch-sensitive mutations.

### Step 5. Admin Reports and Exports

Refactor all report endpoints from global branch helper usage to request branch context.

## Display and Device Plan

### Phase 1 Rule

Keep current display/device behavior operational, but start reading branch from request context where possible.

Initial focus:

- display state endpoints
- pair/revoke device endpoints
- display hello payload

Do not redesign pairing UX yet.

## Licensing Transition for Phase 1

Do not replace `installation_state` yet.

Instead:

- keep current activation working
- add `organizations` and `branches` foundation
- prepare for later mapping from one install activation to org license state

### Transitional Rule

During Phase 1:

- one activated installation maps to one default organization
- one activated branch maps to one default branch

That lets us move forward without breaking the live license state.

## Concrete Code Areas to Touch First

In `server/server.js`, prioritize these areas:

### Schema/bootstrap area

Current hot spots:

- around `branch_config`
- around `installation_state`
- server startup bootstrap around `startServer(...)`

Add:

- `ensureOrganizationSchema(db)`
- `ensureBranchSchema(db)`
- `ensureUserBranchAccessSchema(db)`
- `bootstrapDefaultOrganizationAndBranch(db)`

### Branch helper area

Current hot spots:

- `getBranchConfigSafe()`
- `getBranchCode()`
- `getBranchName()`

Add:

- request-scoped branch helpers
- user branch lookup helpers

### Auth/session area

Current hot spots:

- staff login route
- admin login route
- session auth/me endpoints
- page guards like `requireStaffPage`, `requireAdminPage`

Add:

- branch assignment loading
- selected branch persistence
- branch selection requirement logic

## Suggested Implementation Sequence

### Commit 1

Schema foundation and bootstrap only:

- new tables
- default org/branch bootstrap
- no behavior change yet

### Commit 2

Request branch helper layer:

- `req.qsysBranch`
- helper functions
- no major page changes yet

### Commit 3

Login/session branch selection:

- store allowed branches
- set default selected branch
- branch picker if needed

### Commit 4

Refactor low-risk read routes to use request branch context

### Commit 5

Refactor staff/admin mutations and reports

## Success Criteria for Phase 1

Phase 1 is complete when:

- every logged-in request can resolve a branch from request/session context
- users can belong to more than one branch in the data model
- legacy single-branch users continue working without noticing a breaking change
- default org/default branch bootstrap succeeds on old databases
- no live `/qsys` route breaks for the current single-branch deployment

## Immediate Next Engineering Task

Implement Commit 1:

- schema foundation
- bootstrap of default organization and default branch
- user-to-default-branch assignments

That is the safest starting point for multi-branch support in the current codebase.
