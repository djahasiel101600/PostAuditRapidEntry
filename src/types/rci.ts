export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export type MonthName = (typeof MONTHS)[number];

export type WorkspaceRole = 'admin' | 'auditor' | 'encoder';

export type AuditAttributeState = 'ok' | 'exclamation' | 'wrong' | 'na' | 'flag';

export interface AuditAttributesMap {
  a1: AuditAttributeState;
  a2: AuditAttributeState;
  a3: AuditAttributeState;
  a4: AuditAttributeState;
  a5: AuditAttributeState;
  a6: AuditAttributeState;
  a7: AuditAttributeState;
}

export const AUDIT_ATTRIBUTE_LABELS: Array<{
  key: keyof AuditAttributesMap;
  num: number;
  shortTag?: string;
  label: string;
}> = [
  { key: 'a1', num: 1, label: 'DV and supporting documents submitted' },
  {
    key: 'a2',
    num: 2,
    shortTag: 'E',
    label: 'E - Sufficient appropriation/allotment available and duly obligated',
  },
  {
    key: 'a3',
    num: 3,
    shortTag: 'L',
    label: 'L - Transaction legal and conformed with applicable laws, rules, and regulations',
  },
  {
    key: 'a4',
    num: 4,
    shortTag: 'A',
    label: 'A - Expenditure duly approved by the Head of Office or his authorized representative',
  },
  {
    key: 'a5',
    num: 5,
    shortTag: 'S',
    label: 'S - Transaction supported with complete, valid, proper and legal documents',
  },
  { key: 'a6', num: 6, label: 'Amount claimed proper and correctly computed' },
  {
    key: 'a7',
    num: 7,
    label: 'Transaction properly classified and recorded in the books of accounts',
  },
];

export interface DvSignatoriesMap {
  a?: AuditAttributeState;
  c?: AuditAttributeState;
  d?: AuditAttributeState;
}

export const DV_SIGNATORY_LABELS: Array<{
  key: keyof DvSignatoriesMap;
  letter: string;
  label: string;
}> = [
  { key: 'a', letter: 'A', label: 'DV Box A — Certified: Expenses/Cash Advance necessary, lawful and incured under my direct supervision' },
  {
    key: 'c',
    letter: 'C',
    label: 'DV Box C — Certified: supporting documents complete, proper and cash available.',
  },
  {
    key: 'd',
    letter: 'D',
    label: 'DV Box D — Approved for Payment',
  },
];

export type DebitAccountRole = 'settlement_debit' | 'unrelated_debit';

export type CreditAccountRole =
  | 'withholding_tax'
  | 'retention_payable'
  | 'other_deduction'
  | 'cash_bank_payment'
  | 'other_liability'
  | 'other_credit';

export type AccountRole = DebitAccountRole | CreditAccountRole | 'unclassified';

export type AccountRoleSource =
  | 'line_override'
  | 'coa_default'
  | 'system_default'
  | 'unclassified';

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = {
  settlement_debit: 'Settlement / Expense Debit',
  unrelated_debit: 'Unrelated / Non-Settlement Debit',
  withholding_tax: 'Withholding Tax Payable',
  retention_payable: 'Retention Payable',
  other_deduction: 'Other Deduction',
  cash_bank_payment: 'Cash / Bank Payment',
  other_liability: 'Other Liability',
  other_credit: 'Other Accounting Credit',
  unclassified: 'Unclassified (Manual Review)',
};

export interface JournalLine {
  accountCode: string;
  accountTitle: string;
  debit: number;
  credit: number;
  accountRole?: AccountRole;
  roleSource?: AccountRoleSource;
}

export type RfqStatus = '3plus' | 'under3' | 'na';

export interface ProcurementMeta {
  poSubmittedToCoaDate?: string;
  /** @deprecated legacy combined "No / Date" string — read-only fallback for pre-split records */
  poNoDate?: string;
  poNo?: string;
  poDate?: string;
  procurementMethod?: string;
  philgepsDate?: string;
  /** @deprecated legacy combined "No / Date" string — read-only fallback for pre-split records */
  prNoDate?: string;
  prNo?: string;
  prDate?: string;
  abstractDate?: string;
  rfqCount?: string;
  rfqStatus?: RfqStatus;
  iarNo?: string;
  iarDate?: string;
  orInvoiceRef?: string;
}

export type TestOfControlsStatus = 'allowed' | 'suspended' | 'disallowed';

export interface TestOfControlsRecord {
  status?: TestOfControlsStatus;
  particulars?: string;
}

export type PaymentMode = 'check' | 'ada';

export type CancelledCheckAttachment = 'attached' | 'missing' | 'na';

export const CANCELLED_CHECK_ATTACHMENT_LABELS: Record<CancelledCheckAttachment, string> = {
  attached: 'Original cancelled check attached',
  missing: 'Original cancelled check missing',
  na: 'N/A (no original check)',
};

export type TransactionStatus = 'draft' | 'posted' | 'lacking' | 'audited';

export type MathReconciliationStatus =
  | 'not_applicable'
  | 'pending_jev'
  | 'reconciled'
  | 'discrepancy'
  | 'manual_review';

export type TaxVerificationStatus =
  | 'not_applicable'
  | 'none_withheld'
  | 'pending_base'
  | 'incomplete_evidence'
  | 'verified'
  | 'variance'
  | 'manual_review';

export type DocumentaryVerificationStatus =
  | 'not_applicable'
  | 'incomplete'
  | 'complete'
  | 'lacking';

export type ClerkReviewStatus =
  | 'draft'
  | 'pending_review'
  | 'for_verification'
  | 'lacking'
  | 'audited';

export type TaxBaseType =
  | 'vatable_sales'
  | 'gross_inclusive_vat'
  | 'gross_total'
  | 'contract_or_custom'
  | 'exempt_excluded';

export type TaxRoundingMethod = 'half_up_2dp' | 'truncate_2dp';

export interface TaxRuleOverrideRecord {
  timestamp: string;
  actorUid: string;
  actorName: string;
  previousSummary: string;
  newSummary: string;
  reason: string;
}

export interface TaxRulePreset {
  id: string;
  name: string;
  version: string;
  effectiveFrom: string;
  effectiveTo?: string;
  applicableClassification: string;
  birReference: string;
  defaultBirAccountCode: string;
  defaultBirAccountTitle: string;
  rate: number;
  defaultTaxBaseType: TaxBaseType;
  roundingMethod: TaxRoundingMethod;
  computationRule: string;
  overrideHistory?: TaxRuleOverrideRecord[];
}

export interface WorkspaceTaxPreset extends TaxRulePreset {
  workspaceId: string;
  authorizedUids: string[];
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TaxVerificationComponent {
  id: string;
  birLineIndex?: number;
  birAccountCode: string;
  birAccountTitle: string;
  taxClassification: string;
  applicableRate: number;
  supportingDocRef: string;
  hasCompleteEvidence: boolean;
  classificationUncertain?: boolean;
  taxBaseType: TaxBaseType;
  taxBaseAmount?: number | null;
  rulePresetId?: string;
  ruleVersion?: string;
  ruleEffectiveDate?: string;
  birReference?: string;
  roundingMethod: TaxRoundingMethod;
  computationRule: string;
  expectedWithholding: number;
  actualWithholding: number;
  difference: number;
  ruleOverrideHistory?: TaxRuleOverrideRecord[];
}

export interface GrossBasisOverride {
  selectedSource: 'declared_jev_gross' | 'computed_settlement_debits';
  reason: string;
  actorUid: string;
  actorName: string;
  timestamp: string;
}

export type VerificationAuditCategory =
  | 'account_role_override'
  | 'tax_rule_override'
  | 'gross_basis_override'
  | 'legacy_v2_upgrade'
  | 'clerk_review_decision'
  | 'cancelled_check_flag'
  | 'cancelled_check_evidence';

export interface VerificationAuditEvent {
  id: string;
  timestamp: string;
  actorUid: string;
  actorName: string;
  category: VerificationAuditCategory;
  targetRef?: string;
  previousValue?: string;
  newValue?: string;
  reason: string;
}

export interface LegacySnapshot {
  grossAmount: number;
  netAmount: number;
  taxWithheld: number;
  status: TransactionStatus;
  capturedAt: string;
  capturedByUid: string;
}

export interface TransactionRecord {
  id: string;
  workspaceId: string;
  month: MonthName;
  sequenceNo: number;
  adaCheckDate: string;
  adaCheckNo: string;
  paymentMode?: PaymentMode;
  dvNo: string;
  dateReceived?: string;
  /** @deprecated legacy combined OR "No / Date" string — read-only fallback for pre-split records. */
  orNoDate?: string;
  orNo?: string;
  orDate?: string;
  asaNo?: string;
  /** @deprecated legacy combined JEV "No / Date" string — read-only fallback for pre-split records. */
  jevNoDate?: string;
  jevNo?: string;
  jevDate?: string;
  payeeName: string;
  natureOfTransaction: string;
  // Legacy-compatible summary fields (grossAmount = JEV Gross, netAmount = Check/ADA Net, taxWithheld = Due to BIR)
  grossAmount: number;
  netAmount: number;
  taxWithheld: number;
  // Layer A (Agency RCI) & Layer B (Agency JEV Declared) explicit v2 fields
  rciAmount?: number;
  declaredJevGross?: number;
  grossBasisOverride?: GrossBasisOverride;
  // Layer C (Supporting Tax Components)
  taxComponents?: TaxVerificationComponent[];
  // Layer D (Decoupled System Verification Statuses)
  mathStatus?: MathReconciliationStatus;
  taxStatus?: TaxVerificationStatus;
  documentaryStatus?: DocumentaryVerificationStatus;
  // Layer E (Clerk Processor Review & Trail + Legacy Versioning)
  clerkReviewStatus?: ClerkReviewStatus;
  verificationAuditTrail?: VerificationAuditEvent[];
  amountModelVersion?: number;
  legacySnapshot?: LegacySnapshot;
  templateId?: string;
  journalLines: JournalLine[];
  isBalanced: boolean;
  attributes: AuditAttributesMap;
  procurement?: ProcurementMeta;
  dvSignatories?: DvSignatoriesMap;
  testOfControls?: TestOfControlsRecord;
  isCancelled?: boolean;
  cancellationReason?: string;
  cancelledCheckAttachment?: CancelledCheckAttachment;
  remarks?: string;
  status: TransactionStatus;
  submittedToCoaDate?: string;
  authorizedUids: string[];
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type TaxMode =
  | 'none'
  | 'vat5'
  | 'vat5_ewt2'
  | 'vat5_ewt1'
  | 'pt3'
  | 'pt3_ewt1'
  | 'pt3_ewt2'
  | 'ewt2'
  | 'custom';

export interface EntryTemplate {
  id: string;
  workspaceId: string;
  name: string;
  shortcutKey: string;
  category: string;
  defaultNature: string;
  taxMode: TaxMode;
  vatRate: number;
  ewtRate: number;
  requiresProcurement: boolean;
  debitAccountCode: string;
  debitAccountTitle: string;
  creditCashAccountCode: string;
  creditCashAccountTitle: string;
  autoMatchKeywords?: string;
  authorizedUids: string[];
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PayeeRecord {
  id: string;
  workspaceId: string;
  name: string;
  tin?: string;
  defaultTemplateId?: string;
  defaultNature?: string;
  authorizedUids: string[];
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Workspace {
  id: string;
  name: string;
  agencyCode: string;
  fiscalYear: number;
  ownerUid: string;
  memberUids: string[];
  defaultCheckPrefix?: string;
  defaultDvPrefix?: string;
  coaInitialized?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface WorkspaceMember {
  uid: string;
  workspaceId: string;
  workspaceOwnerUid: string;
  displayName: string;
  role: WorkspaceRole;
  inviteId?: string;
  joinedAt?: unknown;
  updatedAt?: unknown;
}

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceOwnerUid: string;
  invitedEmail: string;
  role: 'auditor' | 'encoder';
  status: 'pending' | 'accepted';
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UserWorkspaceLink {
  id: string;
  uid: string;
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  joinedAt?: unknown;
}

export type ViewModule =
  | 'entry'
  | 'ledger'
  | 'drafts'
  | 'lacking'
  | 'schedule'
  | 'dashboard'
  | 'settings';

export interface CoaAccount {
  code: string;
  title: string;
  normalSide: 'debit' | 'credit';
  accountClass?: AccountRole;
  id?: string;
  isDefault?: boolean;
}

export interface WorkspaceCoaAccount extends CoaAccount {
  id: string;
  workspaceId: string;
  authorizedUids: string[];
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

