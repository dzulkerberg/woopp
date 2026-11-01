# WOOPP 6.0 Firestore Security Specification

## 1. Data & Relational Invariants
1. **Global Default-Deny & Strict Tenant Isolation**:
   - Top-level `match /{document=**} { allow read, write: if false; }` blocks all undeclared paths. Zero broad wildcard overrides exist anywhere in the ruleset.
   - Only a non-anonymous authenticated owner (`request.auth != null`, `request.auth.uid == userId`, `request.auth.token.firebase.sign_in_provider != 'anonymous'`) may read or mutate documents under `/users/{userId}/...`.
2. **Legacy & Production Workspace Preservation**:
   - `/users/{userId}/tracker/main` (legacy v1) and `/users/{userId}/tracker/v5_workspace` (WOOPP 5.0/6.0 Projects, Machines, Print Queue, Smart ETA, Inventory, and `catalogItems` snapshots) remain intact, schema-guarded, and non-deletable (`allow delete: if false`).
3. **Two-Way Atomic SKU Integrity (`catalogProducts` <-> `catalogSkus`)**:
   - Creating `/users/{userId}/catalogProducts/{productId}` requires in the same atomic transaction/batch:
     - `!exists(/databases/$(database)/documents/users/$(userId)/catalogSkus/$(incoming().sku))` (prevents hijacking an already-reserved SKU).
     - `getAfter(/databases/$(database)/documents/users/$(userId)/catalogSkus/$(incoming().sku))` exists and has `sku == incoming().sku`, `productId == productId`, and `ownerId == userId`.
   - Creating `/users/{userId}/catalogSkus/{sku}` requires in the same atomic transaction/batch:
     - `!exists(/databases/$(database)/documents/users/$(userId)/catalogProducts/$(incoming().productId))` (prevents attaching orphaned/secondary SKUs to an already-existing product).
     - `getAfter(/databases/$(database)/documents/users/$(userId)/catalogProducts/$(incoming().productId))` exists and has `id == incoming().productId`, `sku == sku`, and `ownerId == userId`.
   - `catalogSkus` documents cannot be updated or deleted (`allow update, delete: if false`), and `catalogProducts.sku` is strictly immutable on `update` (`incoming().sku == existing().sku`).
4. **Bounded HTTPS-Only Image, Option, Variant & Nested `optionValues` Batch Validation**:
   - Every image URL across `catalogCategories.imageUrl`, all `catalogProducts.images[0..11]` (max 12), and all `catalogProducts.variants[0..11].imageUrl` (max 12) must be an external `https://` URL (`size() <= 2048`, valid domain host, no whitespace, no `http://`, no `data:` base64 blobs, and no coerced `'null'` strings).
   - Every `List.join()` string batch enforces `joined.split(delim) == list` so CEL's implicit `ToString` coercion (`int`, `float`, `bool`, `null`, `path` -> `string`) and embedded-delimiter / trailing-empty-element split tricks (`["A\nB", ""]`) are strictly rejected across all positions (`options[0..3]`, `options[0..3].values[0..11]`, `variants[0..11]`, and `variants[0..11].optionValues`).
   - Every `variants[0..11].optionValues` map is validated for `0..4` entries, trimmed single-line string keys (`1..60` chars, no `\n`/`\r`), and genuine trimmed single-line string values (`1..80` chars, no `\n`/`\r`, no numeric/boolean/null/list/map values).
   - Eager parameter memoization (zero multi-referenced `let` thunks) keeps worst-case evaluation (12 HTTPS images, 4 option groups x 12 values, 12 full variants x 4 `optionValues`) safely below Cloud Firestore's 1,000-expression limit.
5. **Query-Enforced List Isolation (`allow list`)**:
   - All `allow list` rules on `catalogCategories`, `catalogProducts`, `catalogSkus`, and `catalogPlateSettings` enforce `isAuthorizedWorkspaceAdmin(userId) && resource.data.ownerId == request.auth.uid` with zero `get()`/`exists()` calls inside `list`.
   - All frontend collection queries include `where('ownerId', '==', ownerId)` to satisfy Firestore's static query analyzer on both empty and populated collections.
6. **Same-Owner Category References & Safe Category Archiving**:
   - Product creation requires `/users/$(userId)/catalogCategories/$(incoming().categoryId)` to exist with `ownerId == userId` and `status == 'active'`.
   - Product updates where `incoming().categoryId == existing().categoryId` succeed as long as the category belongs to `userId` (even if `status == 'archived'`, preserving historical product references).
   - Product updates reassigning `incoming().categoryId != existing().categoryId` require the destination category to belong to `userId` and have `status == 'active'`.
   - Category Plate Settings (`catalogPlateSettings/{categoryId}`) require the corresponding category to exist under the same `userId`.

## 2. Adversarial "Dirty Dozen" Payloads (All Must Return `PERMISSION_DENIED`)
1. **Unauthenticated or Anonymous Access**: Reading or writing any `tracker/*` or `catalog*` document with `auth == null` or `sign_in_provider == 'anonymous'`.
2. **Cross-Tenant Read/List/Write**: Authenticated `uid = "user_A"` reading, listing, or writing `/users/user_B/catalogProducts/*` or `/users/user_B/tracker/v5_workspace`.
3. **Unfiltered List Query**: Authenticated owner listing `users/{uid}/catalogProducts` without `where('ownerId', '==', uid)`.
4. **Standalone Product Without SKU Reservation**: Creating `catalogProducts/prod-1` via `setDoc` without atomically creating `catalogSkus/{sku}`.
5. **Orphaned SKU Without Product / Pointing to Existing Product**: Creating `catalogSkus/WOOPP-12345678` alone, or pointing `productId` to an already-existing product.
6. **Mismatched Atomic Batch**: Creating `catalogProducts/prod-A` (`sku: WOOPP-11112222`) alongside `catalogSkus/WOOPP-11112222` whose `productId` is `prod-B`.
7. **Duplicate SKU Hijack**: Creating `catalogProducts/prod-new` referencing an already-reserved `catalogSkus/WOOPP-EXISTING`.
8. **SKU Mutation on Update**: Updating an existing `catalogProducts/prod-1` to change `sku` from `WOOPP-AAAAAAAA` to `WOOPP-BBBBBBBB`.
9. **Non-Zero Index Bad Image Injection**: Submitting valid `https://` at `images[0]` while injecting `data:image/png;base64,...` or `http://insecure.example.com/a.jpg` at `images[5]`, `images[11]`, or `variants[3].imageUrl`.
10. **Invalid / Cross-User / Archived Category Assignment**: Creating a new product referencing a non-existent `categoryId`, another user's category, or an `archived` category (or moving an existing product into an `archived` category).
11. **Shadow / Ghost Field Injection**: Adding `"isAdmin": true` or `"printable": true` to `catalogProducts`, `catalogCategories`, or `v5_workspace`.
12. **Destructive Delete Attempt**: Calling `deleteDoc` on `tracker/main`, `tracker/v5_workspace`, `catalogCategories/{id}`, `catalogProducts/{id}`, `catalogSkus/{sku}`, or `catalogPlateSettings/{id}`.
