# RCI Post-Audit Workflow & High-Workload Optimization Plan

A comprehensive P0, P1, and P2 upgrade to streamline daily high-volume RCI voucher encoding, eliminate vertical and horizontal scroll friction, prevent misleading exception resolution, and scale Firestore batch operations and working-paper tables to 500+ disbursements per day—while strictly preserving agency-submitted RCI amounts, Legacy v1 records, and five-layer audit invariants.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> All core workflow and UI architecture choices below reflect your confirmed preferences from review.

- **Scope Confirmed**: Implement **all P0, P1, and P2 improvements** incrementally across Rapid Entry, Drafts, Lacking Queue, Monthly Ledger, COA Schedule, Batch Paste, and Templates & Team.
- **Rapid Entry Right Inspector Layout**: Reorganize into **tabbed sections (`JEV & Tax` | `ELAS & Trail` | `Audit History`)** with a **pinned Reconciliation & 4-Status Summary Strip** at the top so status and primary actions remain visible without dual-scrolling.
- **Drafts & Tax Component Initialization**: Opening **Drafts** automatically loads the first pending draft in the active month, and adding or generating `Due to BIR` JEV lines **automatically scaffolds matching Tax Verification Component stubs** linked by line index and invoice reference.
- **Lacking Queue Resolution Guard**: **Disable `Resolve` (`Clear Flags & Post`)** on any voucher with active v2 math discrepancies, tax variances, unbalanced JEV lines, or duplicate Check/DV serials, enabling it strictly when only ELAS Attributes (1–7) remain flagged.

---

### 1. Overview & Core Concept

- **What It Does**: Eliminates repetitive click loops in the Draft-to-JEV post-audit pipeline, reorganizes dense accounting controls into focused workspace tabs, replaces sequential document updates with chunked Firestore batch writes, and adds table pagination, sticky identity columns, and bulk auditor sign-off.
- **Target Audience / Persona**: Commission on Audit (COA) Clerk Processors, Agency Accounting Encoders, and Auditors handling 200–500 disbursements daily across monthly working papers.
- **Key Value**: Cuts per-voucher encoding clicks (especially for Batch-Pasted Drafts and multi-component BIR tax verification), prevents false resolution of financial/tax discrepancies, and keeps browser rendering responsive at 5,000+ monthly vouchers.

---

### 2. User Experience & Visual Design

#### Key User Flows

1. **Batch Paste → Drafts → Posted Voucher Loop**
   - Clerk opens **Batch Paste**, selects the **Target Month** inside the modal, pastes Excel/TSV rows, reviews flagged zero/malformed amounts or duplicate Check/DV numbers, fixes any duplicate serials **inline in the preview table**, and clicks **Import Drafts** with a live batch progress indicator (`Importing X / Y...`).
   - Switching to **Drafts** immediately loads the first pending Draft into the Rapid Entry workspace.
   - If the Draft carries a template hint and has `0 JEV lines`, an inline prompt offers **Apply Hinted Template** and **Solve Gross from RCI Net** (explicit opt-in calculation populating `JEV Gross`, never mutating agency-submitted `RCI Net`).
   - Entering `JEV Gross` (or optional inline **VATable Sales**) generates balanced JEV lines and **auto-scaffolds Tax Verification Component stubs** per `Due to BIR` credit line, pre-filled with the voucher's `OR / Invoice Ref` and matching BIR rule preset.
   - Posting (`Ctrl+Enter`) validates balance, saves v2 verification state, and auto-advances to the next Draft.

2. **Rapid Entry Tabbed Inspector & `< 1280px` Ergonomics**
   - Top of the 440px right inspector pins the **Balance Badge**, **RCI vs. JEV Summary Strip**, **Three-Way Gross Basis Disagreement Alert** (when triggered), and the **4 Decoupled Status Cards** (`Math Reconciliation`, `Tax Verification`, `Documentary`, `Clerk Review`).
   - Below the pinned strip, three single-line tabs switch cleanly without vertical bloat:
     - **JEV & Tax**: `Entry Made (Dr / Cr & Role)` lines + `Tax Verification Components` + 1-click `Sync from BIR Lines`.
     - **ELAS & Trail**: `Audit Attributes (1–7)`, `Remarks`, and the `9-Field Procurement / COA Trail`.
     - **Audit History**: Chronological `Verification Audit Trail` entries with actor, timestamp, and reason.
   - On viewports `< 1280px`, the stacked inspector is height-capped (`max-h-[48vh]`) so the left register table never collapses.

3. **Exception Triage (`Lacking Queue`)**
   - Rows with math discrepancies, tax variances, incomplete tax evidence, unbalanced lines, or duplicate Check numbers keep **Resolve** disabled with a clear inline cue directing the clerk to **Edit in Rapid Entry**.
   - Rows whose sole exception is ELAS Attributes (1–7) enable **Resolve (`Clear Flags & Post`)** as before.

4. **High-Volume Working Paper (`Monthly Ledger`) & Transmittal (`COA Schedule`)**
   - **Monthly Ledger** adds v2 reconciliation filter chips (`All`, `Math Δ`, `Tax Δ`, `Pending JEV`, `Legacy v1`), `50 / 100 / All` pagination (keeping multi-line JEV vouchers intact across page boundaries), `sticky left` columns (`No.`, `Date`, `Check No`, `Payee`) during horizontal `Show Purchases` scrolling, and multi-row checkboxes with **Sign Off Selected as Audited** for Auditors/Admins.
   - **COA Schedule** executes bulk transmittal assignment in chunked Firestore batches with a live progress counter.
   - **Templates & Team** organizes its six modules into three sub-tabs (**Templates & Payees** | **COA & Tax Rules** | **Workspaces & Team**), hides/locks catalog-creation forms from Encoders to match security rules, and adds a Chart of Accounts picker to Tax Rule Presets.
   - **Header Export Scope**: Replaces the ambiguous top-bar `Export .xlsx` button with an explicit scope choice (**Export Active Month** vs. **Export Full Fiscal Year**).

#### Visual Identity & Component Discipline

- **Aesthetic Direction**: Utilitarian financial working-paper aesthetic—crisp white cards (`#FFFFFF`) over a light cool slate canvas (`#F8FAFC`), hairline `1px` structural borders (`#E2E8F0`), single-elevation surfaces, and zero nested card shadows.
- **60-30-10 Color & Semantic Signaling**: High-contrast dark slate (`#0F172A`) reserved for primary actions and active tabs; emerald (`#15803D`), amber (`#B45309`), and crimson (`#DC2626`) used strictly for verified/pending/discrepancy data states paired with explicit text labels or icons—never color alone.
- **Typography & Tabular Discipline**: `Plus Jakarta Sans` for section headings and navigation, `DM Sans` for compact 12px–14px controls, and `JetBrains Mono` with `tabular-nums` for all monetary values, Check/DV serials, rates, and counts.
- **Zero-Pill & Single-Line Controls**: Interactive filter tabs use clean segmented button groups; static statuses and counts use unboxed inline typography with `·` separators; all buttons and tab labels enforce `whitespace-nowrap shrink-0`.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Auto-Scaffolded Tax Components Without Mutating Agency RCI Amounts**
  - *Chosen Approach*: Automatically generate `TaxVerificationComponent` stubs whenever `Due to BIR` credit lines exist (matched by `birLineIndex` and rate keyword), while leaving `taxBaseAmount` either explicitly entered via the optional `VATable Sales` field or pending verification until confirmed.
  - *Why*: Eliminates 4–6 clicks per voucher on standard VAT/EWT transactions without silently inventing unverified tax bases or altering the RCI Check/ADA figure.
  - *Alternatives Considered*: Requiring manual `+ Component` clicks for every line (too slow at 500 vouchers/day) or silently inferring `VATable Sales = Gross / 1.12` (violates independent invoice verification).

- **Decision 2: Client-Side Pagination vs. Month-Scoped Firestore Queries**
  - *Chosen Approach*: Keep the workspace-level transaction cache for instant cross-month duplicate Check/DV detection and full-year Dashboard KPIs, while paginating the rendered DOM tables (`50` vouchers/page default, grouped safely by voucher in Monthly Ledger).
  - *Why*: Eliminates DOM rendering lag at thousands of rows without breaking workspace-wide duplicate Check/DV guards or 12-month Dashboard rollups.
  - *Alternatives Considered*: Restricting Firestore `onSnapshot` to `selectedMonth` only (would break cross-month duplicate serial detection and fiscal-year KPIs without extra aggregate queries).

- **Decision 3: Chunked `writeBatch` Updates With Live Progress**
  - *Chosen Approach*: Route both **COA Schedule** transmittal updates and **Monthly Ledger** bulk Auditor sign-offs through a shared chunked `writeBatch` helper (8 docs/batch) with progress feedback (`updated / total`).
  - *Why*: Respects Firestore security-rule `get()` evaluation budgets per batch while replacing hundreds of sequential single-doc waits with batched writes under existing security rules (no rule changes required).

- **Decision 4: Opt-In "Solve Gross from RCI Net" Helper**
  - *Chosen Approach*: Provide an explicit button on template-hinted Drafts to reverse-calculate an initial `JEV Gross` from `RCI Net` and the template's tax rates, leaving `RCI Net` untouched and highlighting `JEV Gross` for clerk verification against the physical JEV/DV.
  - *Why*: Speeds up JEV drafting from RCI sheets while keeping the clerk responsible for confirming the agency's JEV figures.

---

### 4. Technical Architecture & Data Strategy

#### System & Workflow Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Workspace Context & Firestore Batch Layer                │
│  • Workspace Transaction Cache + Cross-Month Duplicate Check/DV Index        │
│  • Chunked Batch Writer (Create / Update with live progress callback)        │
│  • Role & Rule Gatekeepers (Admin / Auditor / Encoder permissions)           │
└───────────────┬──────────────────────┬───────────────────────┬───────────────┘
                │                      │                       │
                ▼                      ▼                       ▼
┌──────────────────────────┐ ┌─────────────────────┐ ┌─────────────────────────┐
│  Rapid Entry & Drafts    │ │ Monthly Ledger      │ │ Lacking & COA Schedule  │
│  • Auto-load 1st Draft   │ │ • 50/100/All Pages  │ │ • ELAS-only Resolve     │
│  • Batch Paste (Target   │ │ • Sticky Left Cols  │ │   gate on discrepancies │
│    Month + Inline Dup    │ │ • M:Δ / T:Δ Filters │ │ • Batch COA Transmittal │
│    Edit + Progress)      │ │ • Bulk Auditor Sign │ │   via Chunked Write     │
│  • Opt-in Solve Gross &  │ └─────────────────────┘ └─────────────────────────┘
│    VATable Sales Input   │
│  • Tabbed Inspector:     │ ┌─────────────────────────────────────────────────┐
│    [Pinned Status Strip] │ │ Templates & Team (Role-Gated Sub-Tabs)          │
│    1. JEV & Tax (Auto)   │ │ • [Templates & Payees] [COA & Tax] [Workspaces] │
│    2. ELAS & Procurement │ │ • Tax Preset Editor linked to COA Picker        │
│    3. Audit Trail        │ │ • Encoder view-only lock on Catalog Forms       │
└──────────────────────────┘ └─────────────────────────────────────────────────┘
```

#### Data Model & State Enhancements

- **No Breaking Schema or Rule Changes**: All new batch updates (`submittedToCoaDate`, `status`, `clerkReviewStatus`, `verificationAuditTrail`) use fields and role permissions already permitted in the deployed Firestore Security Rules.
- **Draft Scaffolding & Tax Sync State**:
  - `taxComponents` auto-sync helper inspects `reconciliationSummary.classifiedLines` for `withholding_tax` credits, preserves any user-edited `taxComponents` (matching by `birLineIndex` or ID), appends missing component stubs for unallocated BIR lines using the best-matching `TaxRulePreset`, and avoids double-counting.
  - Optional `vatableSalesInput` state in Rapid Entry feeds `taxBaseAmount` on `vatable_sales` tax components cleanly without altering `declaredJevGross` or `rciAmount`.
- **Pagination State**:
  - **Rapid Entry Register** and **Monthly Ledger** compute `totalPages`, clamp `currentPage` whenever filters or `selectedMonth` change, and slice at the **voucher array** level before expanding `journalLines` into multi-row table groups.

#### Interactive Component & State Mapping

- **Batch Paste Modal**:
  - Adds `batchTargetMonth` state (defaulting to `selectedMonth`), `batchAmountErrors` detection for unparseable/zero amounts, and `batchFieldOverrides[rowIndex]` so inline edits to `adaCheckNo` and `dvNo` immediately recompute workspace + intra-batch duplicate warnings before calling `batchCreateTransactions` with progress callbacks.
- **Drafts Mode (`onlyDrafts`)**:
  - `useEffect` watches `onlyDrafts`, `monthTransactions`, and `editingTx`; when `editingTx` is null and drafts exist in `selectedMonth`, it invokes `onEditTx(monthTransactions[0])`.
  - When `editingTx` has `journalLines.length === 0` and a `templateId`, action buttons trigger `applyTemplate(hintedTpl)` or `solveGrossFromRciNet(rciAmount, hintedTpl)` explicitly.
- **Rapid Entry Tabbed Inspector**:
  - `inspectorTab` state (`'jev_tax' | 'elas_proc' | 'audit'`) switches the lower inspector body while keeping the Balance badge, RCI/JEV summary, Gross Basis Disagreement alert, and 4 Decoupled Status cards pinned above.
  - `Post Entry` / `Save Draft` / `Clear` actions remain accessible via keyboard (`Ctrl+Enter`) and a compact footer bar when stacked below `1280px`.
- **Lacking Queue Resolution Guard**:
  - Computes `canQuickResolve = !hasMathDiscrepancy && !hasTaxVariance && !isDup && !isUnbalanced && (exclamationAttrs.length > 0 || wrongAttrs.length > 0 || tx.status === 'lacking')`.
  - Disables `Resolve` when `canQuickResolve` is false and surfaces a concise tooltip explaining which discrepancy requires editing in Rapid Entry.
- **Monthly Ledger Bulk Sign-Off & Sticky Table**:
  - Adds `reconFilter` (`'all' | 'math_issue' | 'tax_issue' | 'pending_jev' | 'legacy'`) and `selectedLedgerIds` (cleared on month/page/filter change).
  - For Auditors/Admins, **Sign Off Selected as Audited** filters eligible non-audited rows, appends a `clerk_review_decision` audit event per row, and commits via `batchUpdateTransactions` with progress feedback.
  - Applies fixed left widths and `sticky left-[...]` classes to `No.`, `Date`, `Check No`, and `Payee` header/data cells (`rowSpan` first-row cells) with matching background opacity so horizontal scroll keeps row identity locked.
- **Templates & Team Sub-Tabs**:
  - `settingsTab` (`'templates_payees' | 'coa_tax' | 'workspaces_team'`) segments the layout.
  - Creation forms (`Add Template`, `Add COA Code`, `COA Import`, `New Tax Rule Preset`) are gated behind `canManageCatalog` (`admin || auditor`), rendering an explicit read-only banner for Encoders.
  - Tax Rule Preset form integrates `CoaAccountPicker` for `defaultBirAccountCode` and `defaultBirAccountTitle`.

#### Verification Plan

- Add unit tests covering:
  - Auto-scaffolding Tax Verification Components from BIR lines without double-counting or overwriting existing edits.
  - Reverse `solveGrossFromRciNet` helper accuracy across VAT (`5% + 2%`, `5% + 1%`, `5%`), Non-VAT (`3%`, `3% + 1%`, `3% + 2%`), and `2% EWT` modes.
  - `Lacking Queue` `canQuickResolve` gating logic and `Monthly Ledger` reconciliation filter predicates.
- Verify build and lint checks (`compile_applet`, `lint_applet`, and domain test suite) and manually inspect key flows across desktop (`1440px`) and smaller (`< 1280px`) viewports.
