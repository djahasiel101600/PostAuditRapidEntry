# Security Specification & Payload-First TDD (`security_spec.md`)

## 1. Data Invariants
1. **Identity & Email Verification**: All writes require `request.auth != null` and `request.auth.token.email_verified == true`.
2. **PII Isolation**: User email addresses reside strictly inside `/users/{uid}/private/profile` (and pending `/invites`), never inside `/members` or `/transactions`.
3. **Workspace Membership Gate**: Only verified members listed in `/workspaces/{workspaceId}/members/{uid}` may read single documents or mutate transactions, templates, or payees within that workspace.
4. **Query Isolation (Zero `get()` in `allow list`)**: Every `allow list` rule evaluates `resource.data` directly (`uid == request.auth.uid` or `request.auth.uid in resource.data.authorizedUids` / `memberUids`), preventing unauthorized scraping and O(n) rule lookups.
5. **Bounded Arrays & String Lengths**: Every string enforces explicit `.size()` bounds; `memberUids`, `authorizedUids`, and `journalLines` are bounded to `<= 20` entries.
6. **Immutable Provenance & Server Timestamps**: `createdByUid` / `ownerUid` and `createdAt` cannot change after creation; `createdAt` and `updatedAt` must equal `request.time`.
7. **Terminal Audit Locking**: Transactions in `audited` status cannot be modified by standard `encoder` roles—only workspace `auditor` / `admin` roles may unlock or amend audited entries.

## 2. Dirty Dozen Attack Payloads (Expected: `PERMISSION_DENIED`)
1. **Unauthenticated Write**: Creating a transaction without `request.auth`.
2. **Unverified Email Write**: Creating a transaction with `email_verified: false`.
3. **Shadow Field Injection**: Updating a transaction while injecting an undeclared `isApprovedByAdmin: true` ghost key.
4. **Privilege Escalation on Member Doc**: An `encoder` updating their own `/members/{uid}` document from `role: 'encoder'` to `role: 'admin'`.
5. **Self-Assigned Admin on Join**: An invited user accepting a `'encoder'` invite while trying to create `/members/{uid}` with `role: 'admin'`.
6. **Cross-Workspace Poisoning**: Creating a transaction under `/workspaces/wsA/transactions/tx1` with payload `workspaceId: 'wsB'`.
7. **PII Blanket Read**: Authenticated user A reading `/users/userB/private/profile`.
8. **Blanket Collection Scrape**: Querying `/workspaces/wsA/transactions` without a filter matching `authorizedUids` or `createdByUid`.
9. **ID Poisoning**: Creating a transaction with a 500-character document ID containing spaces or `$` characters.
10. **Client Timestamp Forgery**: Creating a transaction with `createdAt` set to a backdated client timestamp instead of `request.time`.
11. **Terminal Audit Tampering**: An `encoder` modifying `grossAmount` on a transaction whose `existing().status == 'audited'`.
12. **Unbounded Array / Resource Exhaustion**: Submitting `journalLines` with 25 elements (`> 20`) or a `natureOfTransaction` string exceeding 500 characters.
