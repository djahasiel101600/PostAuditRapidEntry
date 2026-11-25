import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchDraftTransactionInput,
  isBatchHeaderRow,
  parseDelimitedRow,
} from '../src/lib/batchImportParser';
import { buildWorkingPaperExportData } from '../src/lib/excelExport';
import {
  composeSlashPair,
  normalizePairDate,
  readPair,
  splitSlashPair,
} from '../src/lib/slashPair';
import {
  applyTaxRounding,
  applyTaxToCents,
  computeReconciliationSummary,
  createLegacySnapshot,
  createVerificationAuditEvent,
  DEFAULT_TAX_RULE_PRESETS,
  defaultAttributes,
  defaultDvSignatories,
  deriveBaseForRule,
  deriveClerkReviewStatus,
  describeBaseRuleWarning,
  describeTaxComputation,
  evaluateDocumentaryStatus,
  evaluateTaxVerification,
  isLegacyTransaction,
  normalizePaymentMode,
  paymentModeLabel,
  resolveJournalLineRole,
  sanitizeDvSignatories,
  sanitizeProcurement,
  sanitizeTestOfControls,
  suggestPresetIdForBirTitle,
} from '../src/lib/taxAndLedger';
import type { CoaAccount, DvSignatoriesMap, JournalLine, TaxVerificationComponent, TransactionRecord } from '../src/types/rci';

const WORKSPACE_COA: CoaAccount[] = [
  { code: '50204020', title: 'Electricity Expenses', normalSide: 'debit', accountClass: 'settlement_debit' },
  { code: '50203010', title: 'Office Supplies Expenses', normalSide: 'debit', accountClass: 'settlement_debit' },
  { code: '10102020', title: 'Cash in Bank - Local Currency, Current Account', normalSide: 'credit', accountClass: 'cash_bank_payment' },
  { code: '20201010', title: 'Due to BIR - 5%', normalSide: 'credit', accountClass: 'withholding_tax' },
  { code: '20201010', title: 'Due to BIR - 2%', normalSide: 'credit', accountClass: 'withholding_tax' },
  { code: '20401040', title: 'Guaranty/Security Deposits Payable (Retention)', normalSide: 'credit', accountClass: 'retention_payable' },
  { code: '20201020', title: 'Due to GSIS - Life & Retirement', normalSide: 'credit', accountClass: 'other_liability' },
  { code: '20999010', title: 'Reclassification Clearing', normalSide: 'credit', accountClass: 'other_credit' },
  { code: '10305010', title: 'Receivable Memo Adjustment', normalSide: 'debit', accountClass: 'unrelated_debit' },
];

test('ANECO Electricity regression test: RCI Net, JEV Gross, BIR 5% on VATable Sales, and independent Clerk review', () => {
  const anecoPreset = DEFAULT_TAX_RULE_PRESETS.find((p) => p.id === 'trp-vat5-vatable-sales');
  assert.ok(anecoPreset, 'Expected versioned 5% VATable Sales preset');

  const journalLines: JournalLine[] = [
    { accountCode: '50204020', accountTitle: 'Electricity Expenses', debit: 15229.46, credit: 0 },
    { accountCode: '10102020', accountTitle: 'Cash in Bank - Local Currency, Current Account', debit: 0, credit: 14779.01 },
    { accountCode: '20201010', accountTitle: 'Due to BIR - 5%', debit: 0, credit: 450.45 },
  ];

  const recon = computeReconciliationSummary({
    rciAmount: 14779.01,
    declaredJevGross: 15229.46,
    journalLines,
    coaAccounts: WORKSPACE_COA,
  });

  assert.equal(recon.computedSettlementDebitTotal, 15229.46);
  assert.equal(recon.reconciliationGrossSource, 'agreed');
  assert.equal(recon.grossBasisDisagreement, false);
  assert.equal(recon.totalWithholdingTax, 450.45);
  assert.equal(recon.totalApplicableDeductions, 450.45);
  assert.equal(recon.expectedNetAmount, 14779.01);
  assert.equal(recon.rciVsExpectedNetDelta, 0);
  assert.equal(recon.totalCashBankPayment, 14779.01);
  assert.equal(recon.cashVsRciDelta, 0);
  assert.equal(recon.isBalanced, true);
  assert.equal(recon.mathStatus, 'reconciled');

  const anecoComponent: TaxVerificationComponent = {
    id: 'tax-aneco-5pct',
    birLineIndex: 2,
    birAccountCode: '20201010',
    birAccountTitle: 'Due to BIR - 5%',
    taxClassification: anecoPreset.applicableClassification,
    applicableRate: 0.05,
    supportingDocRef: 'ANECO Billing Invoice #2026-01',
    hasCompleteEvidence: true,
    taxBaseType: 'vatable_sales',
    taxBaseAmount: 9008.93,
    rulePresetId: anecoPreset.id,
    ruleVersion: anecoPreset.version,
    ruleEffectiveDate: anecoPreset.effectiveFrom,
    birReference: anecoPreset.birReference,
    roundingMethod: anecoPreset.roundingMethod,
    computationRule: anecoPreset.computationRule,
    expectedWithholding: 450.45,
    actualWithholding: 450.45,
    difference: 0,
  };

  const taxEval = evaluateTaxVerification({
    journalLines,
    taxComponents: [anecoComponent],
    attributes: defaultAttributes(),
    coaAccounts: WORKSPACE_COA,
  });

  assert.equal(taxEval.totalExpectedTax, 450.45);
  assert.equal(taxEval.totalAllocatedActualTax, 450.45);
  assert.equal(taxEval.unallocatedBirCredit, 0);
  assert.equal(taxEval.doubleCountingConflict, false);
  assert.equal(taxEval.taxStatus, 'verified');

  // Mathematical reconciliation never auto-approves Clerk Processor Audit Review
  const clerkStatus = deriveClerkReviewStatus('posted', defaultAttributes());
  assert.equal(clerkStatus, 'pending_review');
  assert.notEqual(clerkStatus, 'audited');
});

test('Tax verification supports configurable non-ANECO electricity/utility bases without hardcoding VATable Sales', () => {
  const gross = 11200;
  const vatExclBase = applyTaxRounding(gross / 1.12, 'half_up_2dp'); // 10,000.00
  const lines: JournalLine[] = [
    { accountCode: '50204020', accountTitle: 'Electricity Expenses', debit: 11200, credit: 0 },
    { accountCode: '10102020', accountTitle: 'Cash in Bank - Local Currency, Current Account', debit: 0, credit: 10500 },
    { accountCode: '20201010', accountTitle: 'Due to BIR - 5%', debit: 0, credit: 500 },
    { accountCode: '20201010', accountTitle: 'Due to BIR - 2%', debit: 0, credit: 200 },
  ];

  const taxEval = evaluateTaxVerification({
    journalLines: lines,
    taxComponents: [
      {
        id: 'c-5',
        birLineIndex: 2,
        birAccountCode: '20201010',
        birAccountTitle: 'Due to BIR - 5%',
        taxClassification: '5% Withholding VAT',
        applicableRate: 0.05,
        supportingDocRef: 'Utility Invoice #882',
        hasCompleteEvidence: true,
        taxBaseType: 'gross_inclusive_vat',
        taxBaseAmount: vatExclBase,
        roundingMethod: 'half_up_2dp',
        computationRule: '(Gross / 1.12) * 5%',
        expectedWithholding: 500,
        actualWithholding: 500,
        difference: 0,
      },
      {
        id: 'c-2',
        birLineIndex: 3,
        birAccountCode: '20201010',
        birAccountTitle: 'Due to BIR - 2%',
        taxClassification: '2% EWT Services',
        applicableRate: 0.02,
        supportingDocRef: 'Utility Invoice #882',
        hasCompleteEvidence: true,
        taxBaseType: 'gross_inclusive_vat',
        taxBaseAmount: vatExclBase,
        roundingMethod: 'half_up_2dp',
        computationRule: '(Gross / 1.12) * 2%',
        expectedWithholding: 200,
        actualWithholding: 200,
        difference: 0,
      },
    ],
    attributes: defaultAttributes(),
    coaAccounts: WORKSPACE_COA,
  });

  assert.equal(taxEval.taxStatus, 'verified');
  assert.equal(taxEval.totalExpectedTax, 700);
  assert.equal(taxEval.totalAllocatedActualTax, 700);
});

test('Batch Paste parses Amount (Net of Tax) header and creates zero-JEV Draft rows', () => {
  const headerCols = parseDelimitedRow(
    'Date\tCheck/ADA No\tDV No\tPayee\tNature\tAmount (Net of Tax)',
  );
  assert.equal(isBatchHeaderRow(headerCols), true);

  const draft = buildBatchDraftTransactionInput({
    sequenceNo: 10,
    month: 'January',
    adaCheckDate: '2026-01-12',
    adaCheckNo: '3967199',
    dvNo: '2026-01-099',
    payeeName: 'ANECO',
    natureOfTransaction: 'Electricity billing January',
    rawAmountString: '"14,779.01"',
    suggestedTemplateId: 'tpl-utilities',
  });

  assert.equal(draft.rciAmount, 14779.01);
  assert.equal(draft.netAmount, 14779.01);
  assert.equal(draft.grossAmount, 0);
  assert.equal(draft.declaredJevGross, 0);
  assert.equal(draft.taxWithheld, 0);
  assert.equal(draft.journalLines.length, 0, 'Must NOT fabricate Cash/Bank or Debit JEV lines on paste');
  assert.equal(draft.forceDraft, true);
  assert.equal(draft.mathStatus, 'pending_jev');
  assert.equal(draft.taxStatus, 'pending_base');
  assert.equal(draft.clerkReviewStatus, 'draft');
  assert.equal(draft.amountModelVersion, 2);
});

test('Journal account classification distinguishes deductions vs Other Liability / Other Credit and flags unclassified', () => {
  // Retention reduces Expected Net; Other Liability / Other Credit do NOT reduce Expected Net
  const linesWithMixedCredits: JournalLine[] = [
    { accountCode: '50203010', accountTitle: 'Office Supplies Expenses', debit: 10000, credit: 0 },
    { accountCode: '10305010', accountTitle: 'Receivable Memo Adjustment', debit: 500, credit: 0 }, // unrelated_debit
    { accountCode: '10102020', accountTitle: 'Cash in Bank - Local Currency, Current Account', debit: 0, credit: 8500 },
    { accountCode: '20201010', accountTitle: 'Due to BIR - 5%', debit: 0, credit: 500 }, // withholding_tax
    { accountCode: '20401040', accountTitle: 'Guaranty/Security Deposits Payable (Retention)', debit: 0, credit: 1000 }, // retention_payable
    { accountCode: '20999010', accountTitle: 'Reclassification Clearing', debit: 0, credit: 500 }, // other_credit (offsets unrelated_debit)
  ];

  const recon = computeReconciliationSummary({
    rciAmount: 8500,
    declaredJevGross: 10000,
    journalLines: linesWithMixedCredits,
    coaAccounts: WORKSPACE_COA,
  });

  assert.equal(recon.computedSettlementDebitTotal, 10000);
  assert.equal(recon.unrelatedDebitTotal, 500);
  assert.equal(recon.totalWithholdingTax, 500);
  assert.equal(recon.totalRetentionPayable, 1000);
  assert.equal(recon.totalApplicableDeductions, 1500);
  assert.equal(recon.totalOtherCredits, 500);
  assert.equal(recon.expectedNetAmount, 8500);
  assert.equal(recon.isBalanced, true);
  assert.equal(recon.mathStatus, 'reconciled');

  // Unmapped custom account triggers manual_review instead of silently treating it as deduction
  const unknownLine: JournalLine = {
    accountCode: '29999999',
    accountTitle: 'Unmapped Clearing Liability',
    debit: 0,
    credit: 200,
  };
  assert.equal(resolveJournalLineRole(unknownLine, WORKSPACE_COA).role, 'unclassified');

  const reconUnclassified = computeReconciliationSummary({
    rciAmount: 800,
    declaredJevGross: 1000,
    journalLines: [
      { accountCode: '50203010', accountTitle: 'Office Supplies Expenses', debit: 1000, credit: 0 },
      { accountCode: '10102020', accountTitle: 'Cash in Bank - Local Currency, Current Account', debit: 0, credit: 800 },
      unknownLine,
    ],
    coaAccounts: WORKSPACE_COA,
  });
  assert.equal(reconUnclassified.mathStatus, 'manual_review');
  assert.deepEqual(reconUnclassified.unclassifiedLineIndices, [2]);
});

test('Three-way JEV Gross disagreement triggers manual_review unless explicitly overridden with audit trail', () => {
  const lines: JournalLine[] = [
    { accountCode: '50204020', accountTitle: 'Electricity Expenses', debit: 15000, credit: 0 },
    { accountCode: '10102020', accountTitle: 'Cash in Bank - Local Currency, Current Account', debit: 0, credit: 14550 },
    { accountCode: '20201010', accountTitle: 'Due to BIR - 5%', debit: 0, credit: 450 },
  ];

  const disagreed = computeReconciliationSummary({
    rciAmount: 14550,
    declaredJevGross: 15200, // Disagrees with computed 15,000.00
    journalLines: lines,
    coaAccounts: WORKSPACE_COA,
  });

  assert.equal(disagreed.grossBasisDisagreement, true);
  assert.equal(disagreed.reconciliationGrossSource, 'disagreement_unresolved');
  assert.equal(disagreed.reconciliationGrossAmount, null);
  assert.equal(disagreed.mathStatus, 'manual_review');

  // With audited override selecting computed_settlement_debits
  const overridden = computeReconciliationSummary({
    rciAmount: 14550,
    declaredJevGross: 15200,
    grossBasisOverride: {
      selectedSource: 'computed_settlement_debits',
      reason: 'DV face sheet had ₱200 clerical typo; confirmed invoice gross is ₱15,000.00',
      actorUid: 'aud-1',
      actorName: 'Auditor Reyes',
      timestamp: '2026-01-15T08:00:00Z',
    },
    journalLines: lines,
    coaAccounts: WORKSPACE_COA,
  });

  assert.equal(overridden.grossBasisDisagreement, true);
  assert.equal(overridden.grossBasisOverridden, true);
  assert.equal(overridden.reconciliationGrossAmount, 15000);
  assert.equal(overridden.mathStatus, 'reconciled');
});

test('Tax verification prevents double-counting BIR credit lines and handles edge cases deterministically', () => {
  const lines: JournalLine[] = [
    { accountCode: '50204020', accountTitle: 'Electricity Expenses', debit: 15229.46, credit: 0 },
    { accountCode: '10102020', accountTitle: 'Cash in Bank - Local Currency, Current Account', debit: 0, credit: 14779.01 },
    { accountCode: '20201010', accountTitle: 'Due to BIR - 5%', debit: 0, credit: 450.45 },
  ];

  // Double-counting attempt: two components both pointing at line index 2 (450.45)
  const doubleCountEval = evaluateTaxVerification({
    journalLines: lines,
    taxComponents: [
      {
        id: 't1',
        birLineIndex: 2,
        birAccountCode: '20201010',
        birAccountTitle: 'Due to BIR - 5%',
        taxClassification: '5% WVAT Part A',
        applicableRate: 0.05,
        supportingDocRef: 'INV-1',
        hasCompleteEvidence: true,
        taxBaseType: 'vatable_sales',
        taxBaseAmount: 9008.93,
        roundingMethod: 'half_up_2dp',
        computationRule: 'Base * 5%',
        expectedWithholding: 450.45,
        actualWithholding: 450.45,
        difference: 0,
      },
      {
        id: 't2',
        birLineIndex: 2,
        birAccountCode: '20201010',
        birAccountTitle: 'Due to BIR - 5%',
        taxClassification: '5% WVAT Part B',
        applicableRate: 0.05,
        supportingDocRef: 'INV-2',
        hasCompleteEvidence: true,
        taxBaseType: 'vatable_sales',
        taxBaseAmount: 9008.93,
        roundingMethod: 'half_up_2dp',
        computationRule: 'Base * 5%',
        expectedWithholding: 450.45,
        actualWithholding: 450.45,
        difference: 0,
      },
    ],
    coaAccounts: WORKSPACE_COA,
  });
  assert.equal(doubleCountEval.doubleCountingConflict, true);
  assert.equal(doubleCountEval.taxStatus, 'manual_review');

  // No tax components with existing BIR line => pending_base
  assert.equal(
    evaluateTaxVerification({ journalLines: lines, taxComponents: [], coaAccounts: WORKSPACE_COA }).taxStatus,
    'pending_base',
  );

  // Missing taxBaseAmount => pending_base (must NOT pass as 0)
  assert.equal(
    evaluateTaxVerification({
      journalLines: lines,
      taxComponents: [
        {
          id: 'missing-base',
          birLineIndex: 2,
          birAccountCode: '20201010',
          birAccountTitle: 'Due to BIR - 5%',
          taxClassification: '5% WVAT',
          applicableRate: 0.05,
          supportingDocRef: 'INV-1',
          hasCompleteEvidence: true,
          taxBaseType: 'vatable_sales',
          taxBaseAmount: null,
          roundingMethod: 'half_up_2dp',
          computationRule: 'Base * 5%',
          expectedWithholding: 0,
          actualWithholding: 450.45,
          difference: 450.45,
        },
      ],
      coaAccounts: WORKSPACE_COA,
    }).taxStatus,
    'pending_base',
  );

  // Incomplete supporting evidence => incomplete_evidence even when arithmetic matches
  assert.equal(
    evaluateTaxVerification({
      journalLines: lines,
      taxComponents: [
        {
          id: 'no-evid',
          birLineIndex: 2,
          birAccountCode: '20201010',
          birAccountTitle: 'Due to BIR - 5%',
          taxClassification: '5% WVAT',
          applicableRate: 0.05,
          supportingDocRef: '',
          hasCompleteEvidence: false,
          taxBaseType: 'vatable_sales',
          taxBaseAmount: 9008.93,
          roundingMethod: 'half_up_2dp',
          computationRule: 'Base * 5%',
          expectedWithholding: 450.45,
          actualWithholding: 450.45,
          difference: 0,
        },
      ],
      coaAccounts: WORKSPACE_COA,
    }).taxStatus,
    'incomplete_evidence',
  );

  // Uncertain classification => manual_review
  assert.equal(
    evaluateTaxVerification({
      journalLines: lines,
      taxComponents: [
        {
          id: 'uncertain-cls',
          birLineIndex: 2,
          birAccountCode: '20201010',
          birAccountTitle: 'Due to BIR - 5%',
          taxClassification: '5% WVAT',
          applicableRate: 0.05,
          supportingDocRef: 'INV-1',
          hasCompleteEvidence: true,
          classificationUncertain: true,
          taxBaseType: 'vatable_sales',
          taxBaseAmount: 9008.93,
          roundingMethod: 'half_up_2dp',
          computationRule: 'Base * 5%',
          expectedWithholding: 450.45,
          actualWithholding: 450.45,
          difference: 0,
        },
      ],
      coaAccounts: WORKSPACE_COA,
    }).taxStatus,
    'manual_review',
  );
});

test('Discrepancy detection preserves submitted figures without silent overwrites and detects Cash vs RCI / Expected Net vs RCI', () => {
  const lines: JournalLine[] = [
    { accountCode: '50204020', accountTitle: 'Electricity Expenses', debit: 15229.46, credit: 0 },
    { accountCode: '10102020', accountTitle: 'Cash in Bank - Local Currency, Current Account', debit: 0, credit: 14779.01 },
    { accountCode: '20201010', accountTitle: 'Due to BIR - 5%', debit: 0, credit: 450.45 },
  ];

  // Suppose RCI says 14700.00 while JEV Cash credit says 14779.01
  const disc = computeReconciliationSummary({
    rciAmount: 14700.0,
    declaredJevGross: 15229.46,
    journalLines: lines,
    coaAccounts: WORKSPACE_COA,
  });

  assert.equal(disc.mathStatus, 'discrepancy');
  assert.equal(disc.rciVsExpectedNetDelta, 79.01);
  assert.equal(disc.cashVsRciDelta, 79.01);
  assert.equal(disc.rciAmount, 14700.0);
  assert.equal(disc.totalCashBankPayment, 14779.01);
});

test('Legacy compatibility & snapshot protection plus Export & Documentary separation', () => {
  const legacyTx: TransactionRecord = {
    id: 'tx-legacy-1',
    workspaceId: 'ws-1',
    month: 'January',
    sequenceNo: 1,
    adaCheckDate: '2026-01-08',
    adaCheckNo: '3967117',
    dvNo: '2026-01-001',
    payeeName: 'SIARELCO',
    natureOfTransaction: 'Utility',
    grossAmount: 3500,
    netAmount: 3281.25,
    taxWithheld: 218.75,
    journalLines: [
      { accountCode: '20101010', accountTitle: 'Accounts Payable', debit: 3500, credit: 0 },
      { accountCode: '10102020', accountTitle: 'Cash in Bank - Local Currency, Current Account', debit: 0, credit: 3281.25 },
      { accountCode: '20201010', accountTitle: 'Due to BIR - 5%', debit: 0, credit: 156.25 },
      { accountCode: '20201010', accountTitle: 'Due to BIR - 2%', debit: 0, credit: 62.5 },
    ],
    isBalanced: true,
    attributes: defaultAttributes(),
    status: 'posted',
    authorizedUids: ['u1'],
    createdByUid: 'u1',
  };

  assert.equal(isLegacyTransaction(legacyTx), true);
  const snap = createLegacySnapshot(legacyTx, 'u-auditor', '2026-02-01T00:00:00Z');
  assert.deepEqual(snap, {
    grossAmount: 3500,
    netAmount: 3281.25,
    taxWithheld: 218.75,
    status: 'posted',
    capturedAt: '2026-02-01T00:00:00Z',
    capturedByUid: 'u-auditor',
  });

  const auditEvt = createVerificationAuditEvent({
    actorUid: 'u-auditor',
    actorName: 'Auditor Cruz',
    category: 'account_role_override',
    targetRef: 'line:2',
    previousValue: 'other_liability',
    newValue: 'other_deduction',
    reason: 'Confirmed payroll deduction from payee claim',
  });
  assert.equal(auditEvt.category, 'account_role_override');
  assert.equal(auditEvt.reason, 'Confirmed payroll deduction from payee claim');

  const draftV2: TransactionRecord = {
    ...legacyTx,
    id: 'tx-draft-v2',
    sequenceNo: 2,
    adaCheckNo: '3967118',
    rciAmount: 14779.01,
    netAmount: 14779.01,
    grossAmount: 0,
    taxWithheld: 0,
    journalLines: [],
    isBalanced: false,
    status: 'draft',
    mathStatus: 'pending_jev',
    taxStatus: 'pending_base',
    documentaryStatus: 'incomplete',
    clerkReviewStatus: 'draft',
    amountModelVersion: 2,
  };

  const docStatus = evaluateDocumentaryStatus({
    attributes: defaultAttributes(),
    isDraft: false,
    taxComponents: [
      {
        id: 'c',
        birAccountCode: '20201010',
        birAccountTitle: 'Due to BIR - 5%',
        taxClassification: '5% WVAT',
        applicableRate: 0.05,
        supportingDocRef: 'OR #123',
        hasCompleteEvidence: true,
        taxBaseType: 'vatable_sales',
        taxBaseAmount: 9008.93,
        roundingMethod: 'half_up_2dp',
        computationRule: 'Base * 5%',
        expectedWithholding: 450.45,
        actualWithholding: 450.45,
        difference: 0,
      },
    ],
  });
  assert.equal(docStatus, 'complete');

  const { wpRows, rciRows } = buildWorkingPaperExportData([legacyTx, draftV2]);
  assert.equal(rciRows[0]['RCI Check/ADA Amount (Net of Tax)'], 3281.25);
  assert.equal(rciRows[0]['JEV Gross Amount'], 3500);
  assert.equal(rciRows[0]['Math Reconciliation'], 'Legacy');

  assert.equal(rciRows[1]['RCI Check/ADA Amount (Net of Tax)'], 14779.01);
  assert.equal(rciRows[1]['JEV Gross Amount'], 'Pending JEV');
  assert.equal(rciRows[1]['Total Tax Withheld'], 'Pending JEV');
  assert.equal(rciRows[1]['Math Reconciliation'], 'pending_jev');
  const draftWpRow = wpRows.find((r) => r['ADA/Check No'] === '3967118');
  assert.equal(draftWpRow?.['Account Title'], 'Pending JEV encoding');
});

test('deriveBaseForRule strips 12% VAT for VAT-inclusive rules and passes through direct gross', () => {
  assert.equal(deriveBaseForRule('vatable_sales', 25600), 22857.14);
  assert.equal(deriveBaseForRule('gross_inclusive_vat', 25600), 22857.14);
  assert.equal(deriveBaseForRule('gross_total', 25600), 25600);
  assert.equal(deriveBaseForRule('contract_or_custom', 25600), null);
  assert.equal(deriveBaseForRule('exempt_excluded', 25600), null);
  assert.equal(deriveBaseForRule('vatable_sales', 0), null);
  assert.equal(deriveBaseForRule('gross_total', -50), null);
  assert.equal(deriveBaseForRule('vatable_sales', Number.NaN), null);
});

test('Centavo-safe rounding: half-up vs truncate on tax edges', () => {
  assert.equal(applyTaxRounding(1142.8571, 'half_up_2dp'), 1142.86);
  assert.equal(applyTaxRounding(1142.8571, 'truncate_2dp'), 1142.85);
  assert.equal(applyTaxRounding(22857.142857, 'half_up_2dp'), 22857.14);
  assert.equal(applyTaxRounding(22857.142857, 'truncate_2dp'), 22857.14);
  // Integer-centavo path: ₱22,857.14 × 5%
  assert.equal(applyTaxToCents(2285714, 0.05, 'half_up_2dp'), 114286);
  assert.equal(applyTaxToCents(2285714, 0.05, 'truncate_2dp'), 114285);
  assert.equal(applyTaxToCents(2285714, 0.05) / 100, 1142.86);
  assert.equal(applyTaxToCents(0, 0.05), 0);
  assert.equal(applyTaxToCents(2285714, Number.NaN), 0);
});

test('describeTaxComputation renders human formula text for tooltips', () => {
  const vatComponent = {
    taxBaseType: 'gross_inclusive_vat' as const,
    taxBaseAmount: null,
    applicableRate: 0.05,
    roundingMethod: 'half_up_2dp' as const,
  };
  assert.equal(
    describeTaxComputation(vatComponent, 25600),
    '₱25,600.00 ÷ 1.12 = ₱22,857.14 × 5% = ₱1,142.86 (Half-Up 2dp)',
  );

  const directComponent = {
    taxBaseType: 'gross_total' as const,
    taxBaseAmount: 25600,
    applicableRate: 0.03,
    roundingMethod: 'half_up_2dp' as const,
  };
  assert.equal(
    describeTaxComputation(directComponent, 25600),
    '₱25,600.00 × 3% = ₱768.00 (Half-Up 2dp)',
  );

  const emptyComponent = {
    taxBaseType: 'vatable_sales' as const,
    taxBaseAmount: null,
    applicableRate: 0.05,
    roundingMethod: 'half_up_2dp' as const,
  };
  assert.equal(describeTaxComputation(emptyComponent), 'Enter Base₱ · × 5% (Half-Up 2dp)');
});

test('suggestPresetIdForBirTitle maps BIR line rates to versioned rule presets', () => {
  assert.equal(suggestPresetIdForBirTitle('Due to BIR - 5%'), 'trp-vat5-vatable-sales');
  assert.equal(suggestPresetIdForBirTitle('Due to BIR - 3%'), 'trp-pt3-direct');
  assert.equal(suggestPresetIdForBirTitle('Due to BIR - 2%'), 'trp-ewt2-vat-excl');
  assert.equal(suggestPresetIdForBirTitle('Due to BIR - 1%'), 'trp-ewt1-vat-excl');
  assert.equal(suggestPresetIdForBirTitle('Due to GSIS - Life & Retirement'), null);
  assert.equal(suggestPresetIdForBirTitle(''), null);
});

test('describeBaseRuleWarning flags VAT-stripped bases on direct-gross rules only', () => {
  assert.ok(describeBaseRuleWarning({ taxBaseType: 'gross_total', taxBaseAmount: 22857.14 }, 25600));
  assert.equal(describeBaseRuleWarning({ taxBaseType: 'gross_total', taxBaseAmount: 25600 }, 25600), null);
  assert.equal(describeBaseRuleWarning({ taxBaseType: 'gross_total', taxBaseAmount: null }, 25600), null);
  assert.equal(describeBaseRuleWarning({ taxBaseType: 'vatable_sales', taxBaseAmount: 22857.14 }, 25600), null);
  assert.equal(describeBaseRuleWarning({ taxBaseType: 'gross_total', taxBaseAmount: 22857.14 }, 0), null);
});

test('splitSlashPair splits at the separator before a date-like tail, falling back to the last slash', () => {
  assert.deepEqual(splitSlashPair('PO-2026-014 / 01-05-2026'), {
    left: 'PO-2026-014',
    right: '01-05-2026',
  });
  assert.deepEqual(splitSlashPair('PO-2026-014/01-05-2026'), {
    left: 'PO-2026-014',
    right: '01-05-2026',
  });
  assert.deepEqual(splitSlashPair('PO-2026-014 / 1/5/2026'), {
    left: 'PO-2026-014',
    right: '1/5/2026',
  });
  assert.deepEqual(splitSlashPair('A/B-1/2'), { left: 'A/B-1', right: '2' });
  assert.deepEqual(splitSlashPair('PO-2026-014'), { left: 'PO-2026-014', right: '' });
  assert.deepEqual(splitSlashPair(''), { left: '', right: '' });
  assert.deepEqual(splitSlashPair(undefined), { left: '', right: '' });
});

test('normalizePairDate accepts common date formats and preserves unparseable text', () => {
  assert.deepEqual(normalizePairDate('1-5-2026'), { value: '01-05-2026', ok: true });
  assert.deepEqual(normalizePairDate('01-05-2026'), { value: '01-05-2026', ok: true });
  assert.deepEqual(normalizePairDate('1/5/2026'), { value: '01-05-2026', ok: true });
  assert.deepEqual(normalizePairDate('2026-01-05'), { value: '01-05-2026', ok: true });
  assert.deepEqual(normalizePairDate('01-05-26'), { value: '01-05-2026', ok: true });
  assert.deepEqual(normalizePairDate(''), { value: '', ok: true });

  const invalid = normalizePairDate('02-30-2026');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.value, '02-30-2026');
  const text = normalizePairDate('pending');
  assert.equal(text.ok, false);
  assert.equal(text.value, 'pending');
});

test('composeSlashPair and readPair rebuild the display string with legacy fallback', () => {
  assert.equal(composeSlashPair('PO-1', '01-05-2026'), 'PO-1 / 01-05-2026');
  assert.equal(composeSlashPair('PO-1', ''), 'PO-1');
  assert.equal(composeSlashPair('', '01-05-2026'), '01-05-2026');
  assert.equal(composeSlashPair('', ''), '');

  assert.deepEqual(readPair('PO-9', '01-02-2026', 'ignored / 12-31-2025'), {
    left: 'PO-9',
    right: '01-02-2026',
  });
  assert.deepEqual(readPair(undefined, undefined, 'PR-1 / 01-02-2026'), {
    left: 'PR-1',
    right: '01-02-2026',
  });
  assert.deepEqual(readPair('', '', undefined), { left: '', right: '' });
});

test('sanitizeDvSignatories whitelists A/B/C keys and normalizes states', () => {
  assert.deepEqual(defaultDvSignatories(), { a: 'ok', b: 'ok', c: 'ok' });
  assert.deepEqual(sanitizeDvSignatories({ a: 'ok', b: 'exclamation', c: 'na' }), {
    a: 'ok',
    b: 'exclamation',
    c: 'na',
  });
  assert.deepEqual(
    sanitizeDvSignatories({ a: 'ok', d: 'ok' } as unknown as DvSignatoriesMap),
    { a: 'ok' },
  );
  assert.deepEqual(
    sanitizeDvSignatories({ a: 'flag', b: 'bogus' } as unknown as DvSignatoriesMap),
    { a: 'exclamation', b: 'ok' },
  );
  assert.equal(sanitizeDvSignatories(undefined), undefined);
  assert.equal(sanitizeDvSignatories({}), undefined);
});

test('sanitizeTestOfControls guards status and slices particulars to 2000 chars', () => {
  assert.deepEqual(sanitizeTestOfControls({ status: 'suspended', particulars: '  DV #1 missing OR  ' }), {
    status: 'suspended',
    particulars: 'DV #1 missing OR',
  });
  assert.equal(sanitizeTestOfControls({ status: 'maybe' as never }), undefined);
  assert.equal(sanitizeTestOfControls({ particulars: '   ' }), undefined);
  const long = sanitizeTestOfControls({ particulars: 'x'.repeat(2500) });
  assert.equal(long?.particulars?.length, 2000);
});

test('sanitizeProcurement splits legacy No / Date pairs into independent fields', () => {
  const fromLegacy = sanitizeProcurement({
    poNoDate: 'PO-1 / 01-05-2026',
    prNoDate: 'PR-2 / 01-04-2026',
  });
  assert.deepEqual(fromLegacy, {
    poNo: 'PO-1',
    poDate: '01-05-2026',
    prNo: 'PR-2',
    prDate: '01-04-2026',
  });
  assert.equal(fromLegacy && 'poNoDate' in fromLegacy, false);
  assert.equal(fromLegacy && 'prNoDate' in fromLegacy, false);

  const fromSplit = sanitizeProcurement({
    poNo: ' PO-9 ',
    poDate: '02-03-2026',
    iarNo: 'IAR-3',
    iarDate: '01-06-2026',
  });
  assert.deepEqual(fromSplit, {
    poNo: 'PO-9',
    poDate: '02-03-2026',
    iarNo: 'IAR-3',
    iarDate: '01-06-2026',
  });
});

test('normalizePaymentMode maps to check/ada and legacy values to check', () => {
  assert.equal(normalizePaymentMode(undefined), 'check');
  assert.equal(normalizePaymentMode(null), 'check');
  assert.equal(normalizePaymentMode(''), 'check');
  assert.equal(normalizePaymentMode('check'), 'check');
  assert.equal(normalizePaymentMode('ada'), 'ada');
  assert.equal(normalizePaymentMode('ADA '), 'ada');
  assert.equal(normalizePaymentMode('cash'), 'check');

  assert.equal(paymentModeLabel(undefined), 'Check');
  assert.equal(paymentModeLabel('check'), 'Check');
  assert.equal(paymentModeLabel('ada'), 'ADA');
  assert.equal(paymentModeLabel('ADA'), 'ADA');
});
