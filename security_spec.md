# WOOPP 5.0 Firestore Security Specification

## 1. Data Invariants
1. **Strict Account Isolation**: Only the authenticated user whose `request.auth.uid == userId` may read or write documents under `/users/{userId}/tracker/*`.
2. **Legacy Preservation**: `/users/{userId}/tracker/main` remains readable by its owner for non-destructive v1-to-v5 migration and legacy compatibility, and validates legacy structure if updated.
3. **Owner Integrity**: Every `/users/{userId}/tracker/v5_workspace` write must carry `ownerId == request.auth.uid` and `ownerId == userId`, and `ownerId` is immutable across updates.
4. **Strict Key & Volumetric Boundaries**: No shadow/ghost keys may be injected into `v5_workspace`. Arrays (`projects`, `machines`, `jobs`, `colors`, `presets`, `log`) are bounded to prevent Denial-of-Wallet attacks.
5. **Path Hardening**: `{userId}` must match `^[a-zA-Z0-9_\-]+$` and `size() <= 128`.

## 2. Dirty Dozen Adversarial Payloads (Must Return PERMISSION_DENIED)
1. Unauthenticated read on `/users/user_1/tracker/v5_workspace`.
2. Cross-tenant read: `auth.uid = "attacker"` reading `/users/victim/tracker/v5_workspace`.
3. Cross-tenant write: `auth.uid = "attacker"` writing `/users/victim/tracker/v5_workspace`.
4. Owner spoofing: `auth.uid = "user_1"` creating `v5_workspace` with `ownerId: "user_2"`.
5. Owner mutation: `auth.uid = "user_1"` updating `v5_workspace` changing `ownerId` from `"user_1"` to `"user_2"`.
6. Shadow/Ghost field injection: Adding `"isAdmin": true` to `v5_workspace`.
7. Schema version tampering: Setting `schemaVersion: "five"` (string instead of number `5`).
8. Missing required keys: Creating `v5_workspace` with only `{"ownerId": "user_1"}`.
9. Resource poisoning on arrays: Submitting `jobs` as a string instead of a bounded list, or exceeding max bound (`> 2000` items).
10. Arbitrary collection write: Writing to `/public_dump/doc1` (blocked by global default-deny).
11. ID poisoning: Writing to `/users/invalid$id!with/spaces/tracker/v5_workspace`.
12. Unverified email write attempt when email verification is false on restricted paths (note: existing Email/Password users in `woopp-tracker` may not have `email_verified: true`, so owner UID isolation + strict schema validation protects legacy Email/Password accounts without locking out existing unverified accounts).
