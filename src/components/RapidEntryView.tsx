import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ClipboardPaste,
  Copy,
  FileSpreadsheet,
  History,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { AuditAttributeCell } from './AuditAttributeCell';
import { CoaAccountPicker } from './CoaAccountPicker';
import { useAuthWorkspace, type CreateTransactionInput } from '../contexts/AuthWorkspaceContext';
import {
  buildBatchDraftTransactionInput,
  isBatchHeaderRow,
  matchTemplateForBatchRow,
  normalizePasteDate,
  parseDelimitedRow,
} from '../lib/batchImportParser';
import {
  applyTaxRounding,
  buildLinesFromTemplate,
  calculateTaxSplit,
  computeBalanceSummary,
  computeReconciliationSummary,
  countAttributesByType,
  countFlaggedAttributes,
  createVerificationAuditEvent,
  defaultAttributes,
  deriveClerkReviewStatus,
  evaluateDocumentaryStatus,
  evaluateTaxVerification,
  formatPeso,
  getDisplayRciNetAmount,
  hasFlaggedAttribute,
  incrementCodeString,
  isLegacyTransaction,
  resolveJournalLineRole,
  round2,
  sanitizeTaxComponents,
  sanitizeVerificationAuditTrail,
} from '../lib/taxAndLedger';
import {
  ACCOUNT_ROLE_LABELS,
  AUDIT_ATTRIBUTE_LABELS,
  MONTHS,
  type AccountRole,
  type AuditAttributesMap,
  type ClerkReviewStatus,
  type EntryTemplate,
  type GrossBasisOverride,
  type JournalLine,
  type MonthName,
  type ProcurementMeta,
  type RfqStatus,
  type TaxBaseType,
  type TaxRoundingMethod,
  type TaxVerificationComponent,
  type TransactionRecord,
  type TransactionStatus,
  type VerificationAuditEvent,
} from '../types/rci';

interface RapidEntryViewProps {
  editingTx: TransactionRecord | null;
  onEditTx: (tx: TransactionRecord) => void;
  onClearEditing: () => void;
  onlyDrafts?: boolean;
}

const DEBIT_ROLE_OPTIONS: AccountRole[] = ['settlement_debit', 'unrelated_debit', 'unclassified'];
const CREDIT_ROLE_OPTIONS: AccountRole[] = [
  'cash_bank_payment',
  'withholding_tax',
  'retention_payable',
  'other_deduction',
  'other_liability',
  'other_credit',
  'unclassified',
];

const TAX_BASE_TYPE_LABELS: Record<TaxBaseType, string> = {
  vatable_sales: 'Invoice VATable Sales',
  gross_inclusive_vat: 'VAT-Inclusive Gross / 1.12',
  gross_total: 'Non-VAT / Direct Gross',
  contract_or_custom: 'Contract / Custom Base',
  exempt_excluded: 'Exempt / Excluded',
};

const MATH_STATUS_LABELS = {
  pending_jev: { label: 'Pending JEV', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  reconciled: { label: 'Reconciled', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  discrepancy: { label: 'Discrepancy', cls: 'text-red-700 bg-red-50 border-red-200' },
  manual_review: { label: 'Manual Review', cls: 'text-amber-800 bg-amber-50 border-amber-300' },
} as const;

const TAX_STATUS_LABELS = {
  not_applicable: { label: 'Not Applicable', cls: 'text-slate-600 bg-slate-100 border-slate-200' },
  none_withheld: { label: 'None Withheld', cls: 'text-slate-600 bg-slate-100 border-slate-200' },
  pending_base: { label: 'Pending Tax Base', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  incomplete_evidence: { label: 'Incomplete Evidence', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  verified: { label: 'Tax Verified', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  variance: { label: 'Tax Variance', cls: 'text-red-700 bg-red-50 border-red-200' },
  manual_review: { label: 'Manual Review', cls: 'text-amber-800 bg-amber-50 border-amber-300' },
} as const;

const DOC_STATUS_LABELS = {
  incomplete: { label: 'Incomplete', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  complete: { label: 'Complete', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  lacking: { label: 'Lacking', cls: 'text-red-700 bg-red-50 border-red-200' },
} as const;

// Resizable inspector panel (xl+ side-by-side layout only)
const SPLIT_WIDTH_KEY = 'rci_split_panel_width';
const SPLIT_MIN_WIDTH = 300;
const SPLIT_MAX_WIDTH = 700;
const SPLIT_DEFAULT_WIDTH = 440;

function clampSplitWidth(value: number): number {
  return Math.min(SPLIT_MAX_WIDTH, Math.max(SPLIT_MIN_WIDTH, Math.round(value)));
}

export const RapidEntryView: React.FC<RapidEntryViewProps> = ({
  editingTx,
  onEditTx,
  onClearEditing,
  onlyDrafts = false,
}) => {
  const {
    user,
    activeWorkspace,
    activeRole,
    transactions,
    templates,
    payees,
    coaAccounts,
    taxPresets,
    selectedMonth,
    setSelectedMonth,
    createTransaction,
    batchCreateTransactions,
    updateTransaction,
    upgradeLegacyTransactionToV2,
    deleteTransaction,
    createCoaAccount,
    ensurePayeeExists,
    batchEnsurePayees,
  } = useAuthWorkspace();

  const fiscalYear = activeWorkspace?.fiscalYear || 2026;
  const shortYear = String(fiscalYear).slice(-2);
  const canAudit = activeRole === 'admin' || activeRole === 'auditor';
  const actorUid = user?.uid || 'system';
  const actorName = user?.displayName || user?.email || 'Clerk Processor';

  const monthTransactions = useMemo(() => {
    const filtered = transactions.filter((t) => t.month === selectedMonth);
    if (onlyDrafts) return filtered.filter((t) => t.status === 'draft');
    return filtered;
  }, [transactions, selectedMonth, onlyDrafts]);

  const allMonthTxs = useMemo(
    () => transactions.filter((t) => t.month === selectedMonth),
    [transactions, selectedMonth],
  );

  const nextDefaults = useMemo(() => {
    const monthIndex = String(MONTHS.indexOf(selectedMonth) + 1).padStart(2, '0');
    const checkPrefix = (activeWorkspace?.defaultCheckPrefix || '3967').trim() || '3967';
    const customDvPrefix = (activeWorkspace?.defaultDvPrefix || '').trim();
    const dvPrefix =
      customDvPrefix && customDvPrefix !== `${fiscalYear}-01-`
        ? customDvPrefix
        : `${fiscalYear}-${monthIndex}-`;
    if (allMonthTxs.length === 0) {
      return {
        seq: 1,
        checkNo: `${checkPrefix}101`,
        dvNo: `${dvPrefix}001`,
        date: `${fiscalYear}-${monthIndex}-08`,
      };
    }
    const sorted = [...allMonthTxs].sort((a, b) => a.sequenceNo - b.sequenceNo);
    const last = sorted[sorted.length - 1];
    return {
      seq: last.sequenceNo + 1,
      checkNo: incrementCodeString(last.adaCheckNo),
      dvNo: incrementCodeString(last.dvNo),
      date: last.adaCheckDate || `${fiscalYear}-${monthIndex}-08`,
    };
  }, [
    allMonthTxs,
    selectedMonth,
    fiscalYear,
    activeWorkspace?.defaultCheckPrefix,
    activeWorkspace?.defaultDvPrefix,
  ]);

  const duplicateIndex = useMemo(() => {
    const checks = new Map<string, string[]>();
    const dvs = new Map<string, string[]>();
    for (const tx of transactions) {
      const ck = tx.adaCheckNo.trim();
      if (ck) checks.set(ck, [...(checks.get(ck) || []), tx.id]);
      const dv = tx.dvNo.trim();
      if (dv) dvs.set(dv, [...(dvs.get(dv) || []), tx.id]);
    }
    return { checks, dvs };
  }, [transactions]);

  // Rapid Entry Form State
  const [autoIncrement, setAutoIncrement] = useState(true);
  const [sequenceNo, setSequenceNo] = useState<number>(nextDefaults.seq);
  const [adaCheckDate, setAdaCheckDate] = useState<string>(nextDefaults.date);
  const [adaCheckNo, setAdaCheckNo] = useState<string>(nextDefaults.checkNo);
  const [dvNo, setDvNo] = useState<string>(nextDefaults.dvNo);
  const [dateReceived, setDateReceived] = useState<string>('');
  const [orNoDate, setOrNoDate] = useState<string>('');
  const [asaNo, setAsaNo] = useState<string>('');
  const [jevNoDate, setJevNoDate] = useState<string>('');
  const [payeeName, setPayeeName] = useState<string>('');
  const [natureOfTransaction, setNatureOfTransaction] = useState<string>('');

  // Layer A (RCI Net) & Layer B (Declared JEV Gross) separated cleanly
  const [rciAmountInput, setRciAmountInput] = useState<string>('');
  const [rciManuallyEdited, setRciManuallyEdited] = useState<boolean>(false);
  const [grossInput, setGrossInput] = useState<string>('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  // Draggable width for the accounting split inspector (persisted per browser)
  const [splitWidth, setSplitWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(SPLIT_WIDTH_KEY);
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed)) return clampSplitWidth(parsed);
    } catch {
      // ignore storage failure
    }
    return SPLIT_DEFAULT_WIDTH;
  });
  const [splitDragging, setSplitDragging] = useState(false);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleSplitMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      splitDragRef.current = { startX: e.clientX, startWidth: splitWidth };
      setSplitDragging(true);
    },
    [splitWidth],
  );

  const resetSplitWidth = useCallback(() => {
    setSplitWidth(SPLIT_DEFAULT_WIDTH);
  }, []);

  useEffect(() => {
    if (!splitDragging) return;
    const onMove = (e: MouseEvent) => {
      const drag = splitDragRef.current;
      if (!drag) return;
      // Panel is docked right: dragging left widens it
      setSplitWidth(clampSplitWidth(drag.startWidth + (drag.startX - e.clientX)));
    };
    const onUp = () => {
      splitDragRef.current = null;
      setSplitDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [splitDragging]);

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_WIDTH_KEY, String(splitWidth));
    } catch {
      // ignore storage failure
    }
  }, [splitWidth]);

  const [journalLines, setJournalLines] = useState<JournalLine[]>([
    {
      accountCode: '20101010',
      accountTitle: 'Accounts Payable',
      debit: 0,
      credit: 0,
      accountRole: 'settlement_debit',
      roleSource: 'coa_default',
    },
    {
      accountCode: '10102020',
      accountTitle: 'Cash in Bank - Local Currency, Current Account',
      debit: 0,
      credit: 0,
      accountRole: 'cash_bank_payment',
      roleSource: 'coa_default',
    },
  ]);

  // Layer B/C/E v2 Verification State
  const [grossBasisOverride, setGrossBasisOverride] = useState<GrossBasisOverride | undefined>(
    undefined,
  );
  const [overrideBasisSource, setOverrideBasisSource] = useState<
    'declared_jev_gross' | 'computed_settlement_debits'
  >('computed_settlement_debits');
  const [overrideBasisReason, setOverrideBasisReason] = useState<string>('');
  const [taxComponents, setTaxComponents] = useState<TaxVerificationComponent[]>([]);
  const [taxExplicitNotApplicable, setTaxExplicitNotApplicable] = useState<boolean>(false);
  const [clerkReviewStatus, setClerkReviewStatus] = useState<ClerkReviewStatus>('pending_review');
  const [verificationAuditTrail, setVerificationAuditTrail] = useState<VerificationAuditEvent[]>(
    [],
  );
  const [legacyUpgradeReason, setLegacyUpgradeReason] = useState<string>(
    'Post-audit v2 reconciliation verification',
  );
  const [upgradingLegacy, setUpgradingLegacy] = useState<boolean>(false);
  const [showAuditTrail, setShowAuditTrail] = useState<boolean>(false);
  const [showTaxComponents, setShowTaxComponents] = useState<boolean>(true);

  const [attributes, setAttributes] = useState<AuditAttributesMap>(defaultAttributes());
  const [remarks, setRemarks] = useState<string>('complete');
  const [procurement, setProcurement] = useState<ProcurementMeta>({});
  const [showProcurement, setShowProcurement] = useState<boolean>(false);
  const [showAllVoucherFields, setShowAllVoucherFields] = useState<boolean>(false);

  const [submitting, setSubmitting] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{
    tone: 'emerald' | 'amber' | 'red';
    text: string;
  } | null>(null);

  // Batch Paste Modal State (always creates zero-JEV Drafts)
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [batchTemplateId, setBatchTemplateId] = useState<string>('__auto__');
  const [batchLearnPayees, setBatchLearnPayees] = useState<boolean>(true);
  const [batchRowOverrides, setBatchRowOverrides] = useState<Record<number, string>>({});

  const [rememberPayeeTemplate, setRememberPayeeTemplate] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [lastCommittedId, setLastCommittedId] = useState<string | null>(null);

  const checkNoInputRef = useRef<HTMLInputElement>(null);
  const payeeInputRef = useRef<HTMLInputElement>(null);

  const isEditingLegacy = Boolean(editingTx && isLegacyTransaction(editingTx));

  useEffect(() => {
    if (!editingTx) {
      setSequenceNo(nextDefaults.seq);
      setAdaCheckDate(nextDefaults.date);
      setAdaCheckNo(nextDefaults.checkNo);
      setDvNo(nextDefaults.dvNo);
    }
  }, [
    selectedMonth,
    editingTx,
    nextDefaults.seq,
    nextDefaults.date,
    nextDefaults.checkNo,
    nextDefaults.dvNo,
  ]);

  useEffect(() => {
    setPayeeName('');
    setNatureOfTransaction('');
    setRciAmountInput('');
    setRciManuallyEdited(false);
    setGrossInput('');
    setSelectedTemplateId('');
    setJournalLines([
      {
        accountCode: '20101010',
        accountTitle: 'Accounts Payable',
        debit: 0,
        credit: 0,
        accountRole: 'settlement_debit',
        roleSource: 'coa_default',
      },
      {
        accountCode: '10102020',
        accountTitle: 'Cash in Bank - Local Currency, Current Account',
        debit: 0,
        credit: 0,
        accountRole: 'cash_bank_payment',
        roleSource: 'coa_default',
      },
    ]);
    setGrossBasisOverride(undefined);
    setOverrideBasisReason('');
    setTaxComponents([]);
    setTaxExplicitNotApplicable(false);
    setClerkReviewStatus('pending_review');
    setVerificationAuditTrail([]);
    setAttributes(defaultAttributes());
    setRemarks('complete');
    setProcurement({});
    setShowProcurement(false);
    setDateReceived('');
    setOrNoDate('');
    setAsaNo('');
    setJevNoDate('');
    setFeedbackMsg(null);
    setSearchQuery('');
    setLastCommittedId(null);
    setBatchText('');
    setBatchRowOverrides({});
  }, [activeWorkspace?.id]);

  // Populate form when editingTx changes
  useEffect(() => {
    if (!editingTx) return;
    setSelectedMonth(editingTx.month);
    setSequenceNo(editingTx.sequenceNo);
    setAdaCheckDate(editingTx.adaCheckDate);
    setAdaCheckNo(editingTx.adaCheckNo);
    setDvNo(editingTx.dvNo);
    setDateReceived(editingTx.dateReceived || '');
    setOrNoDate(editingTx.orNoDate || '');
    setAsaNo(editingTx.asaNo || '');
    setJevNoDate(editingTx.jevNoDate || '');
    setPayeeName(editingTx.payeeName);
    setNatureOfTransaction(editingTx.natureOfTransaction);

    const rciNet = getDisplayRciNetAmount(editingTx);
    setRciAmountInput(rciNet > 0 ? String(rciNet) : '');
    setRciManuallyEdited(true);

    const jevGross = editingTx.declaredJevGross ?? editingTx.grossAmount;
    setGrossInput(jevGross > 0 ? String(jevGross) : '');
    setSelectedTemplateId(editingTx.templateId || '');
    setJournalLines(editingTx.journalLines.length > 0 ? editingTx.journalLines : []);
    setGrossBasisOverride(editingTx.grossBasisOverride);
    setOverrideBasisSource(
      editingTx.grossBasisOverride?.selectedSource || 'computed_settlement_debits',
    );
    setOverrideBasisReason(editingTx.grossBasisOverride?.reason || '');
    setTaxComponents(editingTx.taxComponents || []);
    setTaxExplicitNotApplicable(editingTx.taxStatus === 'not_applicable');
    setClerkReviewStatus(
      editingTx.clerkReviewStatus || deriveClerkReviewStatus(editingTx.status, editingTx.attributes),
    );
    setVerificationAuditTrail(editingTx.verificationAuditTrail || []);
    setAttributes(editingTx.attributes);
    setRemarks(editingTx.remarks || '');
    setProcurement(editingTx.procurement || {});
    setShowProcurement(
      Boolean(editingTx.procurement && Object.keys(editingTx.procurement).length > 0),
    );
    payeeInputRef.current?.focus();
  }, [editingTx, setSelectedMonth]);

  const activeTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || null,
    [templates, selectedTemplateId],
  );

  const parsedRciAmount = round2(Math.max(0, parseFloat(rciAmountInput) || 0));
  const parsedDeclaredJevGross = round2(Math.max(0, parseFloat(grossInput) || 0));

  const balanceSummary = useMemo(() => computeBalanceSummary(journalLines), [journalLines]);

  const reconciliationSummary = useMemo(
    () =>
      computeReconciliationSummary({
        rciAmount: parsedRciAmount,
        declaredJevGross: parsedDeclaredJevGross,
        grossBasisOverride,
        journalLines,
        coaAccounts,
      }),
    [parsedRciAmount, parsedDeclaredJevGross, grossBasisOverride, journalLines, coaAccounts],
  );

  const taxEvaluation = useMemo(
    () =>
      evaluateTaxVerification({
        journalLines: reconciliationSummary.classifiedLines,
        taxComponents,
        attributes,
        coaAccounts,
        explicitNotApplicable: taxExplicitNotApplicable,
      }),
    [
      reconciliationSummary.classifiedLines,
      taxComponents,
      attributes,
      coaAccounts,
      taxExplicitNotApplicable,
    ],
  );

  const docStatus = useMemo(
    () =>
      evaluateDocumentaryStatus({
        attributes,
        procurement,
        taxComponents,
        isDraft:
          reconciliationSummary.mathStatus === 'pending_jev' || !reconciliationSummary.isBalanced,
      }),
    [
      attributes,
      procurement,
      taxComponents,
      reconciliationSummary.mathStatus,
      reconciliationSummary.isBalanced,
    ],
  );

  const isDuplicateCheck = useMemo(() => {
    const trimmed = adaCheckNo.trim();
    if (!trimmed) return false;
    const ids = duplicateIndex.checks.get(trimmed) || [];
    if (editingTx) return ids.some((id) => id !== editingTx.id);
    return ids.length > 0;
  }, [adaCheckNo, duplicateIndex.checks, editingTx]);

  const isDuplicateDv = useMemo(() => {
    const trimmed = dvNo.trim();
    if (!trimmed) return false;
    const ids = duplicateIndex.dvs.get(trimmed) || [];
    if (editingTx) return ids.some((id) => id !== editingTx.id);
    return ids.length > 0;
  }, [dvNo, duplicateIndex.dvs, editingTx]);

  const appendAuditEvent = useCallback(
    (
      category: VerificationAuditEvent['category'],
      reason: string,
      opts?: { targetRef?: string; previousValue?: string; newValue?: string },
    ) => {
      const evt = createVerificationAuditEvent({
        actorUid,
        actorName,
        category,
        reason,
        targetRef: opts?.targetRef,
        previousValue: opts?.previousValue,
        newValue: opts?.newValue,
      });
      setVerificationAuditTrail((prev) => sanitizeVerificationAuditTrail([...prev, evt]));
    },
    [actorUid, actorName],
  );

  const applyTemplate = useCallback(
    (tpl: EntryTemplate, grossOverride?: number) => {
      setSelectedTemplateId(tpl.id);
      if (
        !natureOfTransaction.trim() ||
        templates.some((t) => t.defaultNature === natureOfTransaction.trim())
      ) {
        setNatureOfTransaction(tpl.defaultNature);
      }
      setShowProcurement(tpl.requiresProcurement);
      const grossVal =
        grossOverride !== undefined ? grossOverride : parseFloat(grossInput) || 0;
      const calc = buildLinesFromTemplate(grossVal, tpl);
      setJournalLines(calc.journalLines);
      if (!rciManuallyEdited) {
        setRciAmountInput(calc.netAmount > 0 ? String(calc.netAmount) : '');
      }
    },
    [grossInput, natureOfTransaction, templates, rciManuallyEdited],
  );

  const handleGrossChange = (raw: string) => {
    setGrossInput(raw);
    const grossVal = parseFloat(raw) || 0;
    const calc = activeTemplate
      ? buildLinesFromTemplate(grossVal, activeTemplate)
      : calculateTaxSplit(grossVal, 'none');
    setJournalLines(calc.journalLines);
    if (!rciManuallyEdited) {
      setRciAmountInput(calc.netAmount > 0 ? String(calc.netAmount) : '');
    }
  };

  const handleRciChange = (raw: string) => {
    setRciManuallyEdited(true);
    setRciAmountInput(raw);
  };

  const handlePayeeChange = (val: string) => {
    setPayeeName(val);
    const matched = payees.find((p) => p.name.toLowerCase() === val.trim().toLowerCase());
    if (matched) {
      if (matched.defaultNature && !natureOfTransaction.trim()) {
        setNatureOfTransaction(matched.defaultNature);
      }
      if (matched.defaultTemplateId) {
        const tpl = templates.find((t) => t.id === matched.defaultTemplateId);
        if (tpl) applyTemplate(tpl);
      }
    }
  };

  const resetRowForNext = useCallback(
    (justPostedCheck: string, justPostedDv: string, justPostedSeq: number) => {
      onClearEditing();
      setPayeeName('');
      setNatureOfTransaction('');
      setRciAmountInput('');
      setRciManuallyEdited(false);
      setGrossInput('');
      setGrossBasisOverride(undefined);
      setOverrideBasisReason('');
      setTaxComponents([]);
      setTaxExplicitNotApplicable(false);
      setClerkReviewStatus('pending_review');
      setVerificationAuditTrail([]);
      setAttributes(defaultAttributes());
      setRemarks('complete');
      setProcurement({});
      setDateReceived('');
      setOrNoDate('');
      setAsaNo('');
      setJevNoDate('');
      if (autoIncrement) {
        setSequenceNo(justPostedSeq + 1);
        setAdaCheckNo(incrementCodeString(justPostedCheck));
        setDvNo(incrementCodeString(justPostedDv));
      }
      if (activeTemplate) {
        const emptyCalc = buildLinesFromTemplate(0, activeTemplate);
        setJournalLines(emptyCalc.journalLines);
      } else {
        setJournalLines([
          {
            accountCode: '20101010',
            accountTitle: 'Accounts Payable',
            debit: 0,
            credit: 0,
            accountRole: 'settlement_debit',
            roleSource: 'coa_default',
          },
          {
            accountCode: '10102020',
            accountTitle: 'Cash in Bank - Local Currency, Current Account',
            debit: 0,
            credit: 0,
            accountRole: 'cash_bank_payment',
            roleSource: 'coa_default',
          },
        ]);
      }
      requestAnimationFrame(() => {
        payeeInputRef.current?.focus();
      });
    },
    [activeTemplate, autoIncrement, onClearEditing],
  );

  const handleCommit = useCallback(
    async (forceDraft = false) => {
      if (submitting) return;
      if (!payeeName.trim()) {
        setFeedbackMsg({ tone: 'red', text: 'Payee name is required before committing.' });
        payeeInputRef.current?.focus();
        return;
      }
      if (!forceDraft && !balanceSummary.isBalanced) {
        setFeedbackMsg({
          tone: 'amber',
          text: `Journal is unbalanced by ₱${formatPeso(Math.abs(balanceSummary.delta))}. Balance lines or Save as Draft.`,
        });
        return;
      }

      setSubmitting(true);
      setFeedbackMsg(null);
      try {
        const monthIndex = String(MONTHS.indexOf(selectedMonth) + 1).padStart(2, '0');
        const computedJev =
          jevNoDate.trim() ||
          (journalLines.length > 0
            ? `${fiscalYear}-${monthIndex}-${String(sequenceNo).padStart(3, '0')} / ${adaCheckDate.slice(5)}`
            : '');

        const effectiveGross =
          reconciliationSummary.reconciliationGrossAmount ?? parsedDeclaredJevGross;
        const effectiveTax = reconciliationSummary.totalWithholdingTax;
        const effectiveNet = parsedRciAmount;

        if (editingTx) {
          const flagged = hasFlaggedAttribute(attributes);
          let nextStatus: TransactionStatus =
            forceDraft || journalLines.length === 0 || !balanceSummary.isBalanced
              ? 'draft'
              : flagged
                ? 'lacking'
                : 'posted';

          if (
            nextStatus === 'posted' &&
            canAudit &&
            clerkReviewStatus === 'audited'
          ) {
            nextStatus = 'audited';
          }

          if (isEditingLegacy) {
            // Preserve legacy amountModelVersion & snapshot untouched unless user explicitly clicks Upgrade
            await updateTransaction(editingTx.id, {
              month: selectedMonth,
              sequenceNo,
              adaCheckDate,
              adaCheckNo,
              dvNo,
              dateReceived,
              orNoDate,
              asaNo,
              jevNoDate: computedJev,
              payeeName: payeeName.trim(),
              natureOfTransaction: natureOfTransaction.trim() || 'Disbursement voucher entry',
              grossAmount: parsedDeclaredJevGross || editingTx.grossAmount,
              netAmount: effectiveNet,
              taxWithheld: effectiveTax,
              templateId: selectedTemplateId || undefined,
              journalLines,
              isBalanced: balanceSummary.isBalanced,
              attributes,
              procurement: showProcurement ? procurement : undefined,
              remarks,
              status: nextStatus,
            });
          } else {
            const nextClerkStatus: ClerkReviewStatus =
              nextStatus === 'draft'
                ? 'draft'
                : nextStatus === 'audited'
                  ? 'audited'
                  : clerkReviewStatus === 'audited'
                    ? deriveClerkReviewStatus(nextStatus, attributes)
                    : clerkReviewStatus;

            await updateTransaction(editingTx.id, {
              month: selectedMonth,
              sequenceNo,
              adaCheckDate,
              adaCheckNo,
              dvNo,
              dateReceived,
              orNoDate,
              asaNo,
              jevNoDate: computedJev,
              payeeName: payeeName.trim(),
              natureOfTransaction: natureOfTransaction.trim() || 'Disbursement voucher entry',
              grossAmount: effectiveGross,
              netAmount: effectiveNet,
              taxWithheld: effectiveTax,
              rciAmount: effectiveNet,
              declaredJevGross: parsedDeclaredJevGross,
              grossBasisOverride,
              taxComponents: sanitizeTaxComponents(taxEvaluation.components),
              mathStatus: reconciliationSummary.mathStatus,
              taxStatus: taxEvaluation.taxStatus,
              documentaryStatus: docStatus,
              clerkReviewStatus: nextClerkStatus,
              verificationAuditTrail,
              amountModelVersion: 2,
              templateId: selectedTemplateId || undefined,
              journalLines,
              isBalanced: balanceSummary.isBalanced,
              attributes,
              procurement: showProcurement ? procurement : undefined,
              remarks,
              status: nextStatus,
            });
          }

          if (rememberPayeeTemplate && selectedTemplateId) {
            void ensurePayeeExists(
              payeeName.trim(),
              selectedTemplateId,
              natureOfTransaction.trim(),
              true,
            );
          }
          setLastCommittedId(editingTx.id);
          if (onlyDrafts && nextStatus !== 'draft') {
            const nextDraft = monthTransactions.find(
              (t) => t.id !== editingTx.id && t.status === 'draft',
            );
            if (nextDraft) {
              setFeedbackMsg({
                tone: 'emerald',
                text: `Posted #${sequenceNo} (${payeeName.trim()}) — loaded next draft #${nextDraft.sequenceNo}.`,
              });
              onEditTx(nextDraft);
            } else {
              setFeedbackMsg({
                tone: 'emerald',
                text: `Posted #${sequenceNo} (${payeeName.trim()}) — all drafts in ${selectedMonth} resolved.`,
              });
              resetRowForNext(adaCheckNo, dvNo, sequenceNo);
            }
          } else {
            setFeedbackMsg({
              tone: 'emerald',
              text: `Updated Check #${adaCheckNo} (${payeeName.trim()}).`,
            });
            resetRowForNext(adaCheckNo, dvNo, sequenceNo);
          }
        } else {
          const initialClerkStatus: ClerkReviewStatus = forceDraft
            ? 'draft'
            : clerkReviewStatus === 'audited'
              ? deriveClerkReviewStatus('posted', attributes)
              : clerkReviewStatus;

          const newId = await createTransaction({
            month: selectedMonth,
            sequenceNo,
            adaCheckDate,
            adaCheckNo,
            dvNo,
            dateReceived,
            orNoDate,
            asaNo,
            jevNoDate: computedJev,
            payeeName: payeeName.trim(),
            natureOfTransaction: natureOfTransaction.trim() || 'Disbursement voucher entry',
            grossAmount: effectiveGross,
            netAmount: effectiveNet,
            taxWithheld: effectiveTax,
            rciAmount: effectiveNet,
            declaredJevGross: parsedDeclaredJevGross,
            grossBasisOverride,
            taxComponents: sanitizeTaxComponents(taxEvaluation.components),
            mathStatus: reconciliationSummary.mathStatus,
            taxStatus: taxEvaluation.taxStatus,
            documentaryStatus: docStatus,
            clerkReviewStatus: initialClerkStatus,
            verificationAuditTrail,
            amountModelVersion: 2,
            templateId: selectedTemplateId || undefined,
            journalLines,
            attributes,
            procurement: showProcurement ? procurement : undefined,
            remarks,
            forceDraft,
          });
          void ensurePayeeExists(
            payeeName.trim(),
            selectedTemplateId || undefined,
            natureOfTransaction.trim(),
            rememberPayeeTemplate && Boolean(selectedTemplateId),
          );
          setLastCommittedId(newId);
          setFeedbackMsg({
            tone: forceDraft ? 'amber' : 'emerald',
            text: forceDraft
              ? `Saved Check #${adaCheckNo} to Drafts.`
              : `Posted #${sequenceNo} · Check #${adaCheckNo} · RCI ₱${formatPeso(effectiveNet)}.`,
          });
          resetRowForNext(adaCheckNo, dvNo, sequenceNo);
        }
      } catch (err) {
        setFeedbackMsg({
          tone: 'red',
          text: err instanceof Error ? err.message : 'Failed to save transaction.',
        });
      } finally {
        setSubmitting(false);
      }
    },
    [
      submitting,
      payeeName,
      balanceSummary,
      selectedMonth,
      jevNoDate,
      journalLines,
      fiscalYear,
      sequenceNo,
      adaCheckDate,
      reconciliationSummary,
      parsedDeclaredJevGross,
      parsedRciAmount,
      editingTx,
      attributes,
      canAudit,
      clerkReviewStatus,
      isEditingLegacy,
      updateTransaction,
      adaCheckNo,
      dvNo,
      dateReceived,
      orNoDate,
      asaNo,
      natureOfTransaction,
      selectedTemplateId,
      showProcurement,
      procurement,
      remarks,
      grossBasisOverride,
      taxEvaluation,
      docStatus,
      verificationAuditTrail,
      rememberPayeeTemplate,
      onlyDrafts,
      monthTransactions,
      onEditTx,
      resetRowForNext,
      createTransaction,
      ensurePayeeExists,
    ],
  );

  const duplicatePreviousRow = useCallback(() => {
    const source = monthTransactions[monthTransactions.length - 1];
    if (!source) return;
    setPayeeName(source.payeeName);
    setNatureOfTransaction(source.natureOfTransaction);
    const rci = getDisplayRciNetAmount(source);
    setRciAmountInput(rci > 0 ? String(rci) : '');
    setRciManuallyEdited(true);
    const gross = source.declaredJevGross ?? source.grossAmount;
    setGrossInput(gross > 0 ? String(gross) : '');
    setSelectedTemplateId(source.templateId || '');
    setJournalLines(source.journalLines);
    setTaxComponents(source.taxComponents || []);
    setRemarks(source.remarks || 'complete');
    setFeedbackMsg({
      tone: 'emerald',
      text: `Cloned details from #${source.sequenceNo} (${source.payeeName}).`,
    });
    payeeInputRef.current?.focus();
  }, [monthTransactions]);

  // Global keyboard shortcuts inside Rapid Entry
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleCommit(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicatePreviousRow();
        return;
      }
      if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        onClearEditing();
        payeeInputRef.current?.focus();
        return;
      }
      if (e.altKey && ['1', '2', '3', '4', '5', '6'].includes(e.key)) {
        const match = templates.find((t) => t.shortcutKey.toLowerCase() === `alt+${e.key}`);
        if (match) {
          e.preventDefault();
          applyTemplate(match);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCommit, duplicatePreviousRow, onClearEditing, templates, applyTemplate]);

  // Batch Paste Excel/CSV Parser — strictly creates ZERO-JEV Drafts with RCI Amount (Net of Tax) only
  const batchParseResult = useMemo(() => {
    if (!batchText.trim()) return { rows: [], skippedHeader: false };
    const rawLines = batchText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let skippedHeader = false;
    const parsedColRows: string[][] = [];
    rawLines.forEach((line, i) => {
      const cols = parseDelimitedRow(line);
      if (i === 0 && isBatchHeaderRow(cols)) {
        skippedHeader = true;
        return;
      }
      parsedColRows.push(cols);
    });

    const monthIndex = String(MONTHS.indexOf(selectedMonth) + 1).padStart(2, '0');
    const explicitBatchTpl =
      batchTemplateId !== '__auto__' && batchTemplateId !== '__draft__'
        ? templates.find((t) => t.id === batchTemplateId) || null
        : null;

    const batchCheckCounts = new Map<string, number>();
    const batchDvCounts = new Map<string, number>();

    const preRows = parsedColRows.map((cols, idx) => {
      const dateStr = normalizePasteDate(cols[0] || '', adaCheckDate);
      const checkStr = (
        cols[1] || incrementCodeString(String(parseInt(nextDefaults.checkNo, 10) + idx - 1))
      ).trim();
      const dvStr = (
        cols[2] || `${fiscalYear}-${monthIndex}-${String(nextDefaults.seq + idx).padStart(3, '0')}`
      ).trim();

      if (checkStr) batchCheckCounts.set(checkStr, (batchCheckCounts.get(checkStr) || 0) + 1);
      if (dvStr) batchDvCounts.set(dvStr, (batchDvCounts.get(dvStr) || 0) + 1);

      return { cols, idx, dateStr, checkStr, dvStr };
    });

    const rows = preRows.map(({ cols, idx, dateStr, checkStr, dvStr }) => {
      const payeeStr = (cols[3] || 'Unnamed Payee').trim();
      const hintCol = cols[6]?.trim();

      const overrideTplId = batchRowOverrides[idx];
      let suggestedTpl: EntryTemplate | null = null;
      let matchSource: 'manual' | 'column' | 'payee' | 'keyword' | 'none' = 'none';

      if (overrideTplId !== undefined) {
        matchSource = 'manual';
        suggestedTpl =
          overrideTplId && overrideTplId !== '__none__'
            ? templates.find((t) => t.id === overrideTplId) || null
            : null;
      } else if (batchTemplateId === '__draft__') {
        suggestedTpl = null;
        matchSource = 'none';
      } else if (batchTemplateId === '__auto__') {
        const detected = matchTemplateForBatchRow(
          payeeStr,
          cols[4] || '',
          hintCol,
          templates,
          payees,
        );
        if (detected.tpl) {
          suggestedTpl = detected.tpl;
          matchSource =
            detected.source === 'fallback' || detected.source === 'column-draft'
              ? 'none'
              : detected.source;
        }
      } else {
        suggestedTpl = explicitBatchTpl;
        matchSource = explicitBatchTpl ? 'manual' : 'none';
      }

      const natureStr = (cols[4] || suggestedTpl?.defaultNature || 'Disbursement voucher').trim();
      const input = buildBatchDraftTransactionInput({
        sequenceNo: nextDefaults.seq + idx,
        month: selectedMonth,
        adaCheckDate: dateStr,
        adaCheckNo: checkStr,
        dvNo: dvStr,
        payeeName: payeeStr,
        natureOfTransaction: natureStr,
        rawAmountString: cols[5] || '0',
        suggestedTemplateId: suggestedTpl?.id,
      });

      const isDupCheck =
        (checkStr ? (duplicateIndex.checks.get(checkStr)?.length || 0) > 0 : false) ||
        (checkStr ? (batchCheckCounts.get(checkStr) || 0) > 1 : false);
      const isDupDv =
        (dvStr ? (duplicateIndex.dvs.get(dvStr)?.length || 0) > 0 : false) ||
        (dvStr ? (batchDvCounts.get(dvStr) || 0) > 1 : false);

      return {
        rowIndex: idx,
        input,
        suggestedTpl,
        matchSource,
        isDupCheck,
        isDupDv,
      };
    });

    return { rows, skippedHeader };
  }, [
    batchText,
    batchTemplateId,
    batchRowOverrides,
    templates,
    payees,
    selectedMonth,
    adaCheckDate,
    fiscalYear,
    nextDefaults,
    duplicateIndex,
  ]);

  const parsedBatchPreview = batchParseResult.rows;

  const batchSummary = useMemo(() => {
    let duplicates = 0;
    let totalRci = 0;
    for (const r of parsedBatchPreview) {
      totalRci = round2(totalRci + r.input.rciAmount);
      if (r.isDupCheck || r.isDupDv) duplicates += 1;
    }
    return { total: parsedBatchPreview.length, duplicates, totalRci };
  }, [parsedBatchPreview]);

  const handleBatchImport = async () => {
    if (parsedBatchPreview.length === 0) return;
    setSubmitting(true);
    try {
      const count = await batchCreateTransactions(parsedBatchPreview.map((r) => r.input));
      if (batchLearnPayees) {
        void batchEnsurePayees(
          parsedBatchPreview.map((r) => ({
            name: r.input.payeeName,
            defaultTemplateId: r.suggestedTpl?.id,
            defaultNature: r.input.natureOfTransaction,
          })),
        );
      }
      setShowBatchModal(false);
      setBatchText('');
      setBatchRowOverrides({});
      setFeedbackMsg({
        tone: 'amber',
        text: `Imported ${count} Draft row(s) into ${selectedMonth} (RCI Net ₱${formatPeso(batchSummary.totalRci)} · Pending JEV encoding).`,
      });
    } catch (err) {
      setFeedbackMsg({
        tone: 'red',
        text: err instanceof Error ? err.message : 'Batch import failed.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const updateJournalLine = (idx: number, patch: Partial<JournalLine>) => {
    setJournalLines((prev) => prev.map((line, i) => (i === idx ? { ...line, ...patch } : line)));
  };

  const handleLineRoleOverride = (idx: number, nextRole: AccountRole) => {
    const line = journalLines[idx];
    if (!line) return;
    const defaultResolved = resolveJournalLineRole(
      { ...line, accountRole: undefined, roleSource: undefined },
      coaAccounts,
    );
    const prevRole = resolveJournalLineRole(line, coaAccounts).role;
    if (prevRole === nextRole) return;

    updateJournalLine(idx, {
      accountRole: nextRole,
      roleSource: nextRole === defaultResolved.role ? defaultResolved.source : 'line_override',
    });
    appendAuditEvent(
      'account_role_override',
      `Line #${idx + 1} (${line.accountTitle}) role reassigned in post-audit review`,
      {
        targetRef: `${line.accountCode} · ${line.accountTitle}`,
        previousValue: ACCOUNT_ROLE_LABELS[prevRole],
        newValue: ACCOUNT_ROLE_LABELS[nextRole],
      },
    );
  };

  const addJournalLine = () => {
    if (journalLines.length >= 20) return;
    setJournalLines((prev) => [
      ...prev,
      {
        accountCode: '20201010',
        accountTitle: 'Due to BIR - 5%',
        debit: 0,
        credit: 0,
        accountRole: 'withholding_tax',
        roleSource: 'coa_default',
      },
    ]);
  };

  const autoBalanceRemainder = () => {
    if (journalLines.length === 0 || Math.abs(balanceSummary.delta) < 0.005) return;
    setJournalLines((prev) => {
      const next = [...prev];
      const lastIdx = next.length - 1;
      const last = { ...next[lastIdx] };
      if (balanceSummary.delta > 0) {
        last.credit = round2(last.credit + balanceSummary.delta);
      } else {
        last.debit = round2(last.debit + Math.abs(balanceSummary.delta));
      }
      next[lastIdx] = last;
      return next;
    });
  };

  const handleApplyGrossBasisOverride = () => {
    if (!overrideBasisReason.trim()) {
      setFeedbackMsg({
        tone: 'amber',
        text: 'Enter a justification reason before overriding the JEV Gross basis.',
      });
      return;
    }
    const nextOverride: GrossBasisOverride = {
      selectedSource: overrideBasisSource,
      reason: overrideBasisReason.trim(),
      actorUid,
      actorName,
      timestamp: new Date().toISOString(),
    };
    setGrossBasisOverride(nextOverride);
    appendAuditEvent('gross_basis_override', nextOverride.reason, {
      targetRef: adaCheckNo,
      previousValue: `Declared ₱${formatPeso(parsedDeclaredJevGross)} vs Settlement ₱${formatPeso(reconciliationSummary.computedSettlementDebitTotal)}`,
      newValue:
        overrideBasisSource === 'declared_jev_gross'
          ? `Declared JEV Gross (₱${formatPeso(parsedDeclaredJevGross)})`
          : `Computed Settlement Debits (₱${formatPeso(reconciliationSummary.computedSettlementDebitTotal)})`,
    });
  };

  const handleAddTaxComponent = (birLineIdx?: number) => {
    const withholdingLines = reconciliationSummary.classifiedLines.filter(
      (l) => l.resolvedRole === 'withholding_tax' && l.credit > 0,
    );
    const targetLine =
      birLineIdx !== undefined
        ? withholdingLines.find((l) => l.lineIndex === birLineIdx)
        : withholdingLines.find(
            (l) => !taxComponents.some((c) => c.birLineIndex === l.lineIndex),
          ) || withholdingLines[0];

    const matchingPreset =
      taxPresets.find((p) =>
        targetLine?.accountTitle.includes('5%')
          ? p.id === 'trp-vat5-vatable-sales'
          : targetLine?.accountTitle.includes('2%')
            ? p.id === 'trp-ewt2-vat-excl'
            : targetLine?.accountTitle.includes('3%')
              ? p.id === 'trp-pt3-direct'
              : targetLine?.accountTitle.includes('1%')
                ? p.id === 'trp-ewt1-vat-excl'
                : false,
      ) || taxPresets[0];

    const newComp: TaxVerificationComponent = {
      id: `tvc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      birLineIndex: targetLine?.lineIndex,
      birAccountCode: targetLine?.accountCode || matchingPreset?.defaultBirAccountCode || '20201010',
      birAccountTitle: targetLine?.accountTitle || matchingPreset?.defaultBirAccountTitle || 'Due to BIR - 5%',
      taxClassification: matchingPreset?.applicableClassification || 'Creditable Withholding Tax',
      applicableRate: matchingPreset?.rate ?? 0.05,
      supportingDocRef: procurement.orInvoiceRef || orNoDate || '',
      hasCompleteEvidence: Boolean(procurement.orInvoiceRef || orNoDate),
      classificationUncertain: false,
      taxBaseType: matchingPreset?.defaultTaxBaseType || 'vatable_sales',
      taxBaseAmount: null,
      rulePresetId: matchingPreset?.id,
      ruleVersion: matchingPreset?.version || '2026.1',
      ruleEffectiveDate: matchingPreset?.effectiveFrom || '2026-01-01',
      birReference: matchingPreset?.birReference || '',
      roundingMethod: matchingPreset?.roundingMethod || 'half_up_2dp',
      computationRule: matchingPreset?.computationRule || 'Tax Base × Rate',
      expectedWithholding: 0,
      actualWithholding: targetLine ? round2(targetLine.credit) : 0,
      difference: targetLine ? round2(targetLine.credit) : 0,
    };
    setTaxComponents((prev) => [...prev, newComp]);
    setTaxExplicitNotApplicable(false);
  };

  const updateTaxComponent = (
    compId: string,
    patch: Partial<TaxVerificationComponent>,
    auditOverrideReason?: string,
  ) => {
    setTaxComponents((prev) =>
      prev.map((comp) => {
        if (comp.id !== compId) return comp;
        const merged: TaxVerificationComponent = { ...comp, ...patch };
        const baseAmt =
          merged.taxBaseAmount !== null && merged.taxBaseAmount !== undefined
            ? Number(merged.taxBaseAmount)
            : null;
        const expected =
          baseAmt !== null && baseAmt > 0
            ? applyTaxRounding(baseAmt * (Number(merged.applicableRate) || 0), merged.roundingMethod)
            : 0;
        merged.expectedWithholding = expected;
        merged.difference = round2((Number(merged.actualWithholding) || 0) - expected);
        return merged;
      }),
    );

    if (auditOverrideReason?.trim()) {
      appendAuditEvent('tax_rule_override', auditOverrideReason.trim(), {
        targetRef: compId,
        newValue: JSON.stringify(patch).slice(0, 180),
      });
    }
  };

  const setAttributeValue = (
    key: keyof AuditAttributesMap,
    nextVal: 'ok' | 'exclamation' | 'wrong' | 'na',
  ) => {
    setAttributes((prev) => ({ ...prev, [key]: nextVal }));
  };

  const attrCounts = useMemo(() => countAttributesByType(attributes), [attributes]);

  const filteredTableRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return monthTransactions;
    return monthTransactions.filter(
      (tx) =>
        tx.payeeName.toLowerCase().includes(q) ||
        tx.adaCheckNo.toLowerCase().includes(q) ||
        tx.dvNo.toLowerCase().includes(q) ||
        tx.natureOfTransaction.toLowerCase().includes(q),
    );
  }, [monthTransactions, searchQuery]);

  const activeFlagCount = countFlaggedAttributes(attributes);

  const withholdingLinesInJev = useMemo(
    () =>
      reconciliationSummary.classifiedLines.filter(
        (l) => l.resolvedRole === 'withholding_tax' && l.credit > 0,
      ),
    [reconciliationSummary.classifiedLines],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Batch Sticky Bar + Shortcut Strip */}
      <div className="bg-white border-b border-slate-200 px-5 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <label htmlFor="batch-month" className="text-xs font-medium text-slate-500">
              Month
            </label>
            <select
              id="batch-month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value as MonthName)}
              className="h-8 px-2.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded text-slate-900 focus:outline-none focus:border-blue-600"
            >
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor="sticky-date" className="text-xs font-medium text-slate-500">
              Batch Date
            </label>
            <input
              id="sticky-date"
              type="date"
              value={adaCheckDate}
              onChange={(e) => setAdaCheckDate(e.target.value)}
              className="h-8 px-2 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>

          <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoIncrement}
              onChange={(e) => setAutoIncrement(e.target.checked)}
              className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
            />
            <span>Auto-increment Check &amp; DV</span>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden xl:inline text-xs text-slate-500">
            Shortcuts: <span className="font-mono text-slate-700">Ctrl+Enter</span> Post ·{' '}
            <span className="font-mono text-slate-700">Ctrl+D</span> Clone Prev ·{' '}
            <span className="font-mono text-slate-700">Alt+1..6</span> Template
          </span>
          <button
            type="button"
            onClick={() => setShowBatchModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
            <span>Batch Paste (RCI Net)</span>
          </button>
        </div>
      </div>

      {/* Main Split Workspace: Rapid Grid + Live 5-Layer Accounting & Post-Audit Inspector */}
      <div className="flex-1 min-h-0 flex flex-col xl:flex-row">
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Smart Template Quick Buttons */}
          <div className="bg-slate-50 border-b border-slate-200 px-5 py-2 flex items-center gap-1.5 overflow-x-auto">
            <span className="text-xs font-medium text-slate-500 mr-1 shrink-0">Templates:</span>
            {templates.map((tpl) => {
              const selected = tpl.id === selectedTemplateId;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => applyTemplate(tpl)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    selected
                      ? 'bg-slate-900 text-white border-slate-900 font-medium'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  <span
                    className={`font-mono text-[11px] ${selected ? 'text-slate-300' : 'text-slate-400'}`}
                  >
                    {tpl.shortcutKey}
                  </span>
                  <span>{tpl.name}</span>
                </button>
              );
            })}
          </div>

          {/* Inline Rapid Entry Strip */}
          <div className="bg-white border-b border-slate-200 p-4">
            <div className="flex items-center justify-between gap-3 mb-2.5">
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <span className="font-semibold text-slate-900">
                  {editingTx ? `Editing Entry #${editingTx.sequenceNo}` : `New Entry #${sequenceNo}`}
                </span>
                <span aria-hidden="true">·</span>
                <span>{selectedMonth}</span>
                {activeTemplate && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-blue-700 font-medium">{activeTemplate.name}</span>
                  </>
                )}
                {isEditingLegacy && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-amber-700 font-medium">Legacy v1 Record</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-3">
                {selectedTemplateId && (
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rememberPayeeTemplate}
                      onChange={(e) => setRememberPayeeTemplate(e.target.checked)}
                    />
                    <span>Remember Payee → Template</span>
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => setShowAllVoucherFields((v) => !v)}
                  className="text-xs text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline cursor-pointer whitespace-nowrap"
                >
                  {showAllVoucherFields ? 'Hide OR / ASA / JEV' : 'Show OR / ASA / JEV'}
                </button>
                <button
                  type="button"
                  onClick={duplicatePreviousRow}
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer whitespace-nowrap"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Clone Prev</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-4 sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  ADA / Check No.
                </label>
                <input
                  ref={checkNoInputRef}
                  type="text"
                  value={adaCheckNo}
                  onChange={(e) => setAdaCheckNo(e.target.value)}
                  placeholder="3967125"
                  className={`w-full h-9 px-2.5 text-sm font-mono tabular-nums border rounded focus:outline-none ${
                    isDuplicateCheck
                      ? 'border-red-500 bg-red-50 text-red-700 font-semibold'
                      : 'border-slate-300 bg-white text-slate-900 focus:border-blue-600'
                  }`}
                />
                {isDuplicateCheck && (
                  <p className="text-[11px] text-red-600 mt-0.5 font-medium">Duplicate Check No.</p>
                )}
              </div>

              <div className="col-span-4 sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  DV / Payroll No.
                </label>
                <input
                  type="text"
                  value={dvNo}
                  onChange={(e) => setDvNo(e.target.value)}
                  placeholder={`${fiscalYear}-01-009`}
                  className={`w-full h-9 px-2.5 text-sm font-mono tabular-nums border rounded focus:outline-none ${
                    isDuplicateDv
                      ? 'border-red-500 bg-red-50 text-red-700 font-semibold'
                      : 'border-slate-300 bg-white text-slate-900 focus:border-blue-600'
                  }`}
                />
                {isDuplicateDv && (
                  <p className="text-[11px] text-red-600 mt-0.5 font-medium">Duplicate DV No.</p>
                )}
              </div>

              <div className="col-span-12 sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Payee (Typeahead)
                </label>
                <input
                  ref={payeeInputRef}
                  type="text"
                  list="rci-payee-suggestions"
                  value={payeeName}
                  onChange={(e) => handlePayeeChange(e.target.value)}
                  placeholder="ANECO / Homer Catering"
                  className="w-full h-9 px-2.5 text-sm border border-slate-300 rounded bg-white text-slate-900 focus:outline-none focus:border-blue-600"
                />
                <datalist id="rci-payee-suggestions">
                  {payees.map((p) => (
                    <option key={p.id} value={p.name} />
                  ))}
                </datalist>
              </div>

              <div className="col-span-12 sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Nature of Transaction
                </label>
                <input
                  type="text"
                  value={natureOfTransaction}
                  onChange={(e) => setNatureOfTransaction(e.target.value)}
                  placeholder="To payment of..."
                  className="w-full h-9 px-2.5 text-sm border border-slate-300 rounded bg-white text-slate-900 focus:outline-none focus:border-blue-600"
                />
              </div>

              <div className="col-span-6 sm:col-span-2">
                <label
                  className="block text-[11px] font-medium text-slate-600 mb-1"
                  title="Actual Check/ADA amount paid to payee as reported on the RCI (Net of Tax & Deductions)"
                >
                  RCI Net Paid (₱)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={rciAmountInput}
                  onChange={(e) => handleRciChange(e.target.value)}
                  placeholder="0.00"
                  className="w-full h-9 px-2.5 text-sm font-mono tabular-nums text-right font-semibold border border-slate-300 rounded bg-white text-emerald-800 focus:outline-none focus:border-blue-600"
                />
              </div>

              <div className="col-span-6 sm:col-span-2">
                <label
                  className="block text-[11px] font-medium text-slate-500 mb-1"
                  title="Declared Gross Transaction Amount from the agency JEV & supporting voucher"
                >
                  JEV Gross (₱)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={grossInput}
                  onChange={(e) => handleGrossChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      void handleCommit(false);
                    }
                  }}
                  placeholder="0.00"
                  className="w-full h-9 px-2.5 text-sm font-mono tabular-nums text-right font-semibold border border-slate-300 rounded bg-white text-slate-900 focus:outline-none focus:border-blue-600"
                />
              </div>
            </div>

            {showAllVoucherFields && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2.5 pt-2.5 border-t border-slate-100">
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">
                    Date Received
                  </label>
                  <input
                    type="date"
                    value={dateReceived}
                    onChange={(e) => setDateReceived(e.target.value)}
                    className="w-full h-8 px-2 text-xs font-mono border border-slate-200 rounded bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">
                    OR No. / Date
                  </label>
                  <input
                    type="text"
                    value={orNoDate}
                    onChange={(e) => setOrNoDate(e.target.value)}
                    placeholder="OR #8812 / 01-09-26"
                    className="w-full h-8 px-2 text-xs font-mono border border-slate-200 rounded bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">ASA No.</label>
                  <input
                    type="text"
                    value={asaNo}
                    onChange={(e) => setAsaNo(e.target.value)}
                    placeholder={`ASA-${fiscalYear}-01`}
                    className="w-full h-8 px-2 text-xs font-mono border border-slate-200 rounded bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">
                    JEV No. and Date
                  </label>
                  <input
                    type="text"
                    value={jevNoDate}
                    onChange={(e) => setJevNoDate(e.target.value)}
                    placeholder="Auto-assigned on post"
                    className="w-full h-8 px-2 text-xs font-mono border border-slate-200 rounded bg-slate-50"
                  />
                </div>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleCommit(false)}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{editingTx ? 'Update Entry (Ctrl+Enter)' : 'Post Entry (Ctrl+Enter)'}</span>
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleCommit(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-slate-700 border border-slate-200 text-xs font-medium rounded hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <span>Save Draft</span>
                </button>
                <button
                  type="button"
                  onClick={() => resetRowForNext(adaCheckNo, dvNo, sequenceNo - 1)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Clear</span>
                </button>
              </div>

              {feedbackMsg && (
                <p
                  className={`text-xs font-medium ${
                    feedbackMsg.tone === 'emerald'
                      ? 'text-emerald-700'
                      : feedbackMsg.tone === 'amber'
                        ? 'text-amber-700'
                        : 'text-red-600'
                  }`}
                >
                  {feedbackMsg.text}
                </p>
              )}
            </div>
          </div>

          {/* Table Filter Bar */}
          <div className="bg-slate-50 border-b border-slate-200 px-5 py-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-xs text-slate-600">
              <span className="font-semibold text-slate-900">
                {onlyDrafts ? `${selectedMonth} Drafts` : `${selectedMonth} Register`}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{filteredTableRows.length} entries</span>
            </div>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by Check #, DV #, Payee, or Nature..."
              className="w-64 h-7 px-2.5 text-xs bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-600"
            />
          </div>

          {/* High-Density RCI Table */}
          <div className="flex-1 overflow-auto bg-white">
            {filteredTableRows.length === 0 ? (
              <div className="h-full min-h-[240px] flex flex-col items-center justify-center p-8 text-center">
                <FileSpreadsheet className="w-8 h-8 text-slate-300 mb-2" />
                <p className="text-sm font-medium text-slate-900">
                  {onlyDrafts ? `No drafts in ${selectedMonth}` : `No transactions in ${selectedMonth}`}
                </p>
                <p className="text-xs text-slate-500 mt-1 max-w-sm">
                  Start typing in the rapid entry bar above or use{' '}
                  <span className="font-mono">Batch Paste</span> to import RCI Net rows from Excel.
                </p>
              </div>
            ) : (
              <table className="w-full border-collapse text-left">
                <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 z-10">
                  <tr className="text-[11px] font-semibold text-slate-600">
                    <th className="py-2 px-3 w-12">No.</th>
                    <th className="py-2 px-3 w-24">Date</th>
                    <th className="py-2 px-3 w-28">Serial/Check</th>
                    <th className="py-2 px-3 w-28">DV/Payroll</th>
                    <th className="py-2 px-3">Payee</th>
                    <th className="py-2 px-3">Nature of Transaction</th>
                    <th className="py-2 px-3 text-right w-28">RCI Net</th>
                    <th className="py-2 px-3 text-right w-28">JEV Gross</th>
                    <th className="py-2 px-3 w-28">State</th>
                    <th className="py-2 px-3 w-20 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredTableRows.map((tx) => {
                    const dupCheck = (duplicateIndex.checks.get(tx.adaCheckNo.trim()) || []).length > 1;
                    const isSelected = editingTx?.id === tx.id || lastCommittedId === tx.id;
                    const legacy = isLegacyTransaction(tx);
                    const isPendingJev = tx.journalLines.length === 0 && tx.grossAmount === 0;
                    const hasReconAlert =
                      !legacy &&
                      (tx.mathStatus === 'discrepancy' ||
                        tx.mathStatus === 'manual_review' ||
                        tx.taxStatus === 'variance' ||
                        tx.taxStatus === 'manual_review');

                    const statusColor =
                      tx.status === 'audited'
                        ? 'text-emerald-700'
                        : tx.status === 'posted'
                          ? 'text-slate-700'
                          : tx.status === 'lacking'
                            ? 'text-red-600 font-semibold'
                            : 'text-amber-700 font-medium';

                    return (
                      <tr
                        key={tx.id}
                        className={`h-9 transition-colors ${
                          isSelected ? 'bg-emerald-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="px-3 font-mono tabular-nums text-slate-500">{tx.sequenceNo}</td>
                        <td className="px-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {tx.adaCheckDate}
                        </td>
                        <td
                          className={`px-3 font-mono tabular-nums whitespace-nowrap ${
                            dupCheck ? 'text-red-600 font-bold' : 'text-slate-900'
                          }`}
                          title={dupCheck ? 'Duplicate Serial/Check Number detected' : undefined}
                        >
                          {tx.adaCheckNo}
                        </td>
                        <td className="px-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                          {tx.dvNo}
                        </td>
                        <td className="px-3 font-medium text-slate-900 max-w-[160px] truncate">
                          {tx.payeeName}
                        </td>
                        <td className="px-3 text-slate-600 max-w-[220px] truncate">
                          {tx.natureOfTransaction}
                        </td>
                        <td className="px-3 font-mono tabular-nums text-right font-medium text-slate-900 whitespace-nowrap">
                          {formatPeso(getDisplayRciNetAmount(tx))}
                        </td>
                        <td className="px-3 font-mono tabular-nums text-right text-slate-600 whitespace-nowrap">
                          {isPendingJev ? (
                            <span className="text-[11px] font-sans text-amber-700">Pending JEV</span>
                          ) : (
                            formatPeso(tx.grossAmount)
                          )}
                        </td>
                        <td className={`px-3 capitalize whitespace-nowrap ${statusColor}`}>
                          <span>{tx.status}</span>
                          {hasReconAlert && (
                            <span
                              title="RCI-vs-JEV math or tax verification discrepancy"
                              className="ml-1.5 text-[10px] font-mono text-red-600 font-semibold"
                            >
                              !
                            </span>
                          )}
                        </td>
                        <td className="px-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => onEditTx(tx)}
                              title="Edit transaction"
                              className="p-1 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100 cursor-pointer"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            {tx.status !== 'audited' && (
                              <button
                                type="button"
                                onClick={() => void deleteTransaction(tx.id)}
                                title="Delete entry"
                                className="p-1 text-slate-400 hover:text-red-600 rounded hover:bg-red-50 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Drag handle: resize the inspector panel (xl+ side-by-side layout only) */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize accounting split panel"
          title="Drag to resize · double-click to reset"
          onMouseDown={handleSplitMouseDown}
          onDoubleClick={resetSplitWidth}
          className={`hidden xl:block w-1.5 shrink-0 cursor-col-resize group transition-colors ${
            splitDragging ? 'bg-blue-100' : 'hover:bg-blue-50'
          }`}
        >
          <div
            className={`w-0.5 h-full mx-auto transition-colors ${
              splitDragging ? 'bg-blue-500' : 'bg-transparent group-hover:bg-blue-300'
            }`}
          />
        </div>

        {/* Docked Right Panel: 5-Layer Accounting Split, Reconciliation & Post-Audit Inspector */}
        <aside
          style={{ '--split-w': `${splitWidth}px` } as React.CSSProperties}
          className="w-full xl:w-[var(--split-w)] shrink-0 bg-white border-t xl:border-t-0 xl:border-l border-slate-200 flex flex-col overflow-y-auto"
        >
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <span className="text-xs font-semibold tracking-wide text-slate-700 font-display">
              ACCOUNTING SPLIT &amp; RECONCILIATION
            </span>
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-semibold font-mono tabular-nums ${
                journalLines.length === 0
                  ? 'text-amber-700'
                  : balanceSummary.isBalanced
                    ? 'text-emerald-700'
                    : 'text-red-600'
              }`}
            >
              {journalLines.length === 0 ? (
                <span>PENDING JEV</span>
              ) : balanceSummary.isBalanced ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>DR=CR BALANCED</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Δ ₱{formatPeso(Math.abs(balanceSummary.delta))}</span>
                </>
              )}
            </span>
          </div>

          {/* Legacy v1 Protection Banner */}
          {editingTx && isEditingLegacy && (
            <div className="p-3 bg-amber-50 border-b border-amber-200 text-xs space-y-2">
              <div className="flex items-start gap-2 text-amber-950">
                <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Legacy v1 Record Protected</p>
                  <p className="text-[11px] text-amber-800 mt-0.5">
                    Saved Gross (₱{formatPeso(editingTx.grossAmount)}), Net (₱
                    {formatPeso(editingTx.netAmount)}), and Tax (₱
                    {formatPeso(editingTx.taxWithheld)}) are preserved untouched unless explicitly upgraded.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={legacyUpgradeReason}
                  onChange={(e) => setLegacyUpgradeReason(e.target.value)}
                  placeholder="Reason for upgrading to v2..."
                  className="flex-1 h-7 px-2 text-[11px] bg-white border border-amber-300 rounded text-slate-900"
                />
                <button
                  type="button"
                  disabled={upgradingLegacy}
                  onClick={async () => {
                    setUpgradingLegacy(true);
                    try {
                      await upgradeLegacyTransactionToV2(editingTx, legacyUpgradeReason);
                      setFeedbackMsg({
                        tone: 'emerald',
                        text: `Upgraded #${editingTx.sequenceNo} to v2 with immutable Legacy Snapshot preserved.`,
                      });
                    } finally {
                      setUpgradingLegacy(false);
                    }
                  }}
                  className="h-7 px-2.5 bg-amber-800 text-white text-[11px] font-medium rounded hover:bg-amber-900 cursor-pointer whitespace-nowrap disabled:opacity-50"
                >
                  {upgradingLegacy ? 'Upgrading...' : 'Upgrade to v2'}
                </button>
              </div>
            </div>
          )}

          {/* Layer A & B: RCI vs JEV Summary Strip */}
          <div className="grid grid-cols-3 border-b border-slate-200 bg-slate-50/70 divide-x divide-slate-200">
            <div className="px-3 py-2">
              <p className="text-[11px] text-slate-500">JEV Gross Basis</p>
              <p className="text-xs font-mono tabular-nums font-semibold text-slate-900">
                {reconciliationSummary.reconciliationGrossAmount !== null
                  ? `₱${formatPeso(reconciliationSummary.reconciliationGrossAmount)}`
                  : reconciliationSummary.mathStatus === 'pending_jev'
                    ? 'Pending JEV'
                    : 'Manual Review'}
              </p>
            </div>
            <div className="px-3 py-2">
              <p className="text-[11px] text-slate-500">Tax &amp; Deductions</p>
              <p className="text-xs font-mono tabular-nums font-semibold text-amber-700">
                ₱{formatPeso(reconciliationSummary.totalApplicableDeductions)}
              </p>
            </div>
            <div className="px-3 py-2">
              <p className="text-[11px] text-slate-500">RCI Net Paid</p>
              <p className="text-xs font-mono tabular-nums font-semibold text-emerald-700">
                ₱{formatPeso(reconciliationSummary.rciAmount)}
              </p>
            </div>
          </div>

          {/* Expected Net vs Cash/Bank Cr & Non-Deduction Breakdown */}
          <div className="px-3 py-2 border-b border-slate-200 bg-white text-[11px] space-y-1">
            <div className="flex justify-between font-mono tabular-nums">
              <span className="text-slate-500">Expected Net (Gross − Deductions):</span>
              <span
                className={`font-semibold ${
                  reconciliationSummary.rciVsExpectedNetDelta !== null &&
                  Math.abs(reconciliationSummary.rciVsExpectedNetDelta) > 0.01
                    ? 'text-red-600'
                    : 'text-slate-900'
                }`}
              >
                {reconciliationSummary.expectedNetAmount !== null
                  ? `₱${formatPeso(reconciliationSummary.expectedNetAmount)}`
                  : '—'}
              </span>
            </div>
            <div className="flex justify-between font-mono tabular-nums">
              <span className="text-slate-500">JEV Cash/Bank Payment Credit:</span>
              <span
                className={`font-semibold ${
                  journalLines.length > 0 && Math.abs(reconciliationSummary.cashVsRciDelta) > 0.01
                    ? 'text-red-600'
                    : 'text-slate-900'
                }`}
              >
                ₱{formatPeso(reconciliationSummary.totalCashBankPayment)}
              </span>
            </div>
            {(reconciliationSummary.totalOtherLiabilities > 0 ||
              reconciliationSummary.totalOtherCredits > 0 ||
              reconciliationSummary.unrelatedDebitTotal > 0) && (
              <div className="pt-1 border-t border-slate-100 text-[10px] text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5 font-mono tabular-nums">
                {reconciliationSummary.totalOtherLiabilities > 0 && (
                  <span>Other Liability Cr: ₱{formatPeso(reconciliationSummary.totalOtherLiabilities)}</span>
                )}
                {reconciliationSummary.totalOtherCredits > 0 && (
                  <span>Other Credit: ₱{formatPeso(reconciliationSummary.totalOtherCredits)}</span>
                )}
                {reconciliationSummary.unrelatedDebitTotal > 0 && (
                  <span>Unrelated Dr: ₱{formatPeso(reconciliationSummary.unrelatedDebitTotal)}</span>
                )}
              </div>
            )}
          </div>

          {/* Three-Way Gross Basis Disagreement Alert & Audited Override */}
          {reconciliationSummary.grossBasisDisagreement && (
            <div className="p-3 bg-amber-50/90 border-b border-amber-200 text-xs space-y-2">
              <div className="flex items-start gap-1.5 text-amber-950">
                <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Gross Basis Disagreement Detected</p>
                  <p className="text-[11px] text-amber-900 font-mono tabular-nums">
                    Declared: ₱{formatPeso(reconciliationSummary.declaredJevGross)} vs Settlement Dr: ₱
                    {formatPeso(reconciliationSummary.computedSettlementDebitTotal)} (Δ ₱
                    {formatPeso(Math.abs(reconciliationSummary.grossBasisDelta))})
                  </p>
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <select
                    value={overrideBasisSource}
                    onChange={(e) =>
                      setOverrideBasisSource(
                        e.target.value as 'declared_jev_gross' | 'computed_settlement_debits',
                      )
                    }
                    className="flex-1 h-7 px-2 text-[11px] bg-white border border-amber-300 rounded"
                  >
                    <option value="computed_settlement_debits">
                      Use Computed Settlement Debits (₱
                      {formatPeso(reconciliationSummary.computedSettlementDebitTotal)})
                    </option>
                    <option value="declared_jev_gross">
                      Use Declared JEV Gross (₱{formatPeso(reconciliationSummary.declaredJevGross)})
                    </option>
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={overrideBasisReason}
                    onChange={(e) => setOverrideBasisReason(e.target.value)}
                    placeholder="Reason for basis override (audited)..."
                    className="flex-1 h-7 px-2 text-[11px] bg-white border border-amber-300 rounded"
                  />
                  <button
                    type="button"
                    onClick={handleApplyGrossBasisOverride}
                    className="h-7 px-2.5 bg-slate-900 text-white text-[11px] font-medium rounded hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                  >
                    Apply
                  </button>
                  {grossBasisOverride && (
                    <button
                      type="button"
                      onClick={() => setGrossBasisOverride(undefined)}
                      className="h-7 px-2 border border-amber-300 bg-white text-[11px] rounded hover:bg-amber-100 cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Layer D: 4 Decoupled Verification Statuses */}
          {!isEditingLegacy && (
            <div className="p-3 border-b border-slate-200 bg-slate-50/40 space-y-1.5">
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div
                  className={`px-2 py-1.5 rounded border ${MATH_STATUS_LABELS[reconciliationSummary.mathStatus].cls}`}
                  title={reconciliationSummary.reasons.join(' ')}
                >
                  <span className="block text-[10px] opacity-75">Math Reconciliation</span>
                  <span className="font-semibold">
                    {MATH_STATUS_LABELS[reconciliationSummary.mathStatus].label}
                  </span>
                </div>
                <div
                  className={`px-2 py-1.5 rounded border ${TAX_STATUS_LABELS[taxEvaluation.taxStatus].cls}`}
                  title={taxEvaluation.reasons.join(' ')}
                >
                  <span className="block text-[10px] opacity-75">Tax Verification</span>
                  <span className="font-semibold">
                    {TAX_STATUS_LABELS[taxEvaluation.taxStatus].label}
                  </span>
                </div>
                <div
                  className={`px-2 py-1.5 rounded border ${DOC_STATUS_LABELS[docStatus].cls}`}
                >
                  <span className="block text-[10px] opacity-75">Documentary</span>
                  <span className="font-semibold">{DOC_STATUS_LABELS[docStatus].label}</span>
                </div>
                <div className="px-2 py-1.5 rounded border border-slate-200 bg-white">
                  <span className="block text-[10px] text-slate-500">Clerk Review</span>
                  <select
                    value={clerkReviewStatus}
                    onChange={(e) => {
                      const next = e.target.value as ClerkReviewStatus;
                      if (next === 'audited' && !canAudit) return;
                      const prev = clerkReviewStatus;
                      setClerkReviewStatus(next);
                      appendAuditEvent(
                        'clerk_review_decision',
                        `Clerk review status changed to ${next}`,
                        { targetRef: adaCheckNo, previousValue: prev, newValue: next },
                      );
                    }}
                    className="w-full text-[11px] font-semibold text-slate-900 bg-transparent focus:outline-none cursor-pointer"
                  >
                    <option value="draft">Draft</option>
                    <option value="pending_review">Pending Review</option>
                    <option value="for_verification">For Verification</option>
                    <option value="lacking">Lacking</option>
                    {canAudit && <option value="audited">Audited (Sign-off)</option>}
                  </select>
                </div>
              </div>
              {reconciliationSummary.reasons.length > 0 &&
                reconciliationSummary.mathStatus !== 'reconciled' && (
                  <p className="text-[11px] text-red-700 leading-snug">
                    {reconciliationSummary.reasons[0]}
                  </p>
                )}
            </div>
          )}

          {/* Journal Lines with Account Role Override */}
          <div className="p-3 border-b border-slate-200">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-700">Entry Made (Dr / Cr &amp; Role)</span>
              <div className="flex items-center gap-2">
                {!balanceSummary.isBalanced && Math.abs(balanceSummary.delta) > 0 && (
                  <button
                    type="button"
                    onClick={autoBalanceRemainder}
                    className="text-[11px] font-medium text-blue-700 hover:underline cursor-pointer"
                  >
                    Auto-balance
                  </button>
                )}
                <button
                  type="button"
                  onClick={addJournalLine}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Line</span>
                </button>
              </div>
            </div>

            {journalLines.length === 0 ? (
              <div className="p-3 bg-amber-50/70 border border-amber-200 rounded text-xs text-amber-900 space-y-1.5">
                <p className="font-medium">No JEV lines recorded yet (Pending JEV encoding).</p>
                <p className="text-[11px] text-amber-800">
                  Enter JEV Gross above, pick a Smart Template, or click <strong>+ Line</strong> to encode the accounting lines.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {journalLines.map((line, idx) => {
                  const classified = reconciliationSummary.classifiedLines[idx];
                  const resolvedRole = classified?.resolvedRole || 'unclassified';
                  const isDebitLine = line.debit > 0 && line.credit === 0;
                  const roleOptions = isDebitLine ? DEBIT_ROLE_OPTIONS : CREDIT_ROLE_OPTIONS;

                  return (
                    <div
                      key={idx}
                      className={`border rounded p-1.5 space-y-1.5 ${
                        resolvedRole === 'unclassified'
                          ? 'bg-amber-50/60 border-amber-300'
                          : 'bg-slate-50/60 border-slate-200/80'
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        <div className="flex-1 min-w-0">
                          <CoaAccountPicker
                            compact
                            accountCode={line.accountCode}
                            accountTitle={line.accountTitle}
                            accounts={coaAccounts}
                            suggestedNormalSide={
                              line.credit > 0 && line.debit === 0 ? 'credit' : 'debit'
                            }
                            onChange={({ accountCode, accountTitle }) =>
                              updateJournalLine(idx, {
                                accountCode,
                                accountTitle,
                                accountRole: undefined,
                                roleSource: undefined,
                              })
                            }
                            onSaveToWorkspaceCoa={createCoaAccount}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setJournalLines((prev) => prev.filter((_, i) => i !== idx))
                          }
                          title="Remove line"
                          className="p-1 text-slate-400 hover:text-red-600 cursor-pointer shrink-0"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-12 gap-1.5 items-center">
                        <div className="col-span-4 flex items-center gap-1 bg-white border border-slate-200 rounded px-1.5 h-7">
                          <span className="text-[10px] font-medium text-slate-400 shrink-0">Dr</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            aria-label="Debit amount"
                            value={line.debit || ''}
                            onChange={(e) =>
                              updateJournalLine(idx, { debit: parseFloat(e.target.value) || 0 })
                            }
                            placeholder="0.00"
                            className="w-full text-[11px] font-mono tabular-nums text-right bg-transparent focus:outline-none"
                          />
                        </div>
                        <div className="col-span-4 flex items-center gap-1 bg-white border border-slate-200 rounded px-1.5 h-7">
                          <span className="text-[10px] font-medium text-slate-400 shrink-0">Cr</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            aria-label="Credit amount"
                            value={line.credit || ''}
                            onChange={(e) =>
                              updateJournalLine(idx, { credit: parseFloat(e.target.value) || 0 })
                            }
                            placeholder="0.00"
                            className="w-full text-[11px] font-mono tabular-nums text-right bg-transparent focus:outline-none"
                          />
                        </div>
                        <div className="col-span-4">
                          <select
                            aria-label="Account role"
                            value={resolvedRole}
                            onChange={(e) =>
                              handleLineRoleOverride(idx, e.target.value as AccountRole)
                            }
                            className={`w-full h-7 px-1 text-[10px] border rounded bg-white ${
                              resolvedRole === 'unclassified'
                                ? 'border-amber-400 text-amber-800 font-semibold'
                                : 'border-slate-200 text-slate-700'
                            }`}
                          >
                            {roleOptions.map((r) => (
                              <option key={r} value={r}>
                                {ACCOUNT_ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-2 pt-2 border-t border-slate-100 flex justify-between text-[11px] font-mono tabular-nums text-slate-600">
              <span>Dr: ₱{formatPeso(balanceSummary.totalDebit)}</span>
              <span>Cr: ₱{formatPeso(balanceSummary.totalCredit)}</span>
            </div>
          </div>

          {/* Layer C: Independent Multi-Component Tax Verification */}
          <div className="p-3 border-b border-slate-200">
            <div className="flex items-center justify-between mb-1.5">
              <button
                type="button"
                onClick={() => setShowTaxComponents((v) => !v)}
                className="text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
              >
                Tax Verification Components ({taxComponents.length})
              </button>
              <div className="flex items-center gap-2">
                {withholdingLinesInJev.length === 0 && taxComponents.length === 0 && (
                  <label className="inline-flex items-center gap-1 text-[11px] text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={taxExplicitNotApplicable}
                      onChange={(e) => setTaxExplicitNotApplicable(e.target.checked)}
                    />
                    <span>Exempt / N/A</span>
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => handleAddTaxComponent()}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:underline cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Component</span>
                </button>
              </div>
            </div>

            {showTaxComponents && (
              <div className="space-y-2">
                {taxEvaluation.doubleCountingConflict && (
                  <div className="p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">
                    Double-counting conflict detected across BIR withholding tax lines. Adjust allocated JEV line or amounts.
                  </div>
                )}

                {taxEvaluation.unallocatedBirCredit > 0.01 && (
                  <div className="p-2 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-800">
                    ₱{formatPeso(taxEvaluation.unallocatedBirCredit)} of Due to BIR credit is not covered by a component.
                  </div>
                )}

                {taxComponents.length === 0 ? (
                  <p className="text-[11px] text-slate-500">
                    {withholdingLinesInJev.length > 0
                      ? `JEV has ${withholdingLinesInJev.length} Due to BIR line(s). Add a component per BIR line to verify supporting invoice bases (e.g. VATable Sales).`
                      : 'No tax verification components configured.'}
                  </p>
                ) : (
                  taxEvaluation.components.map((comp) => (
                    <div
                      key={comp.id}
                      className="p-2 bg-slate-50 border border-slate-200 rounded space-y-1.5 text-[11px]"
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <select
                          value={comp.rulePresetId || ''}
                          onChange={(e) => {
                            const preset = taxPresets.find((p) => p.id === e.target.value);
                            if (!preset) return;
                            updateTaxComponent(comp.id, {
                              rulePresetId: preset.id,
                              ruleVersion: preset.version,
                              ruleEffectiveDate: preset.effectiveFrom,
                              birReference: preset.birReference,
                              taxClassification: preset.applicableClassification,
                              applicableRate: preset.rate,
                              taxBaseType: preset.defaultTaxBaseType,
                              roundingMethod: preset.roundingMethod,
                              computationRule: preset.computationRule,
                            });
                          }}
                          className="flex-1 h-7 px-1.5 text-[11px] bg-white border border-slate-200 rounded"
                        >
                          <option value="">Custom Rule...</option>
                          {taxPresets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} (v{p.version})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() =>
                            setTaxComponents((prev) => prev.filter((c) => c.id !== comp.id))
                          }
                          title="Remove tax component"
                          className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-12 gap-1.5">
                        <select
                          aria-label="Target BIR JEV Line"
                          value={comp.birLineIndex ?? ''}
                          onChange={(e) => {
                            const lineIdx =
                              e.target.value === '' ? undefined : parseInt(e.target.value, 10);
                            const target = withholdingLinesInJev.find(
                              (l) => l.lineIndex === lineIdx,
                            );
                            updateTaxComponent(comp.id, {
                              birLineIndex: lineIdx,
                              birAccountCode: target?.accountCode || comp.birAccountCode,
                              birAccountTitle: target?.accountTitle || comp.birAccountTitle,
                              actualWithholding: target ? round2(target.credit) : comp.actualWithholding,
                            });
                          }}
                          className="col-span-7 h-7 px-1.5 bg-white border border-slate-200 rounded text-[11px]"
                        >
                          <option value="">Auto-match BIR line...</option>
                          {withholdingLinesInJev.map((l) => (
                            <option key={l.lineIndex} value={l.lineIndex}>
                              Line #{l.lineIndex + 1}: {l.accountTitle} (₱{formatPeso(l.credit)})
                            </option>
                          ))}
                        </select>
                        <div className="col-span-5 flex items-center gap-1 bg-white border border-slate-200 rounded px-1.5 h-7">
                          <span className="text-[10px] text-slate-400">Rate%</span>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            value={round2(comp.applicableRate * 100)}
                            onChange={(e) =>
                              updateTaxComponent(
                                comp.id,
                                { applicableRate: Math.min(1, Math.max(0, (parseFloat(e.target.value) || 0) / 100)) },
                                `Rate override to ${e.target.value}%`,
                              )
                            }
                            className="w-full font-mono text-right bg-transparent focus:outline-none"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-12 gap-1.5">
                        <select
                          value={comp.taxBaseType}
                          onChange={(e) =>
                            updateTaxComponent(comp.id, {
                              taxBaseType: e.target.value as TaxBaseType,
                            })
                          }
                          className="col-span-7 h-7 px-1.5 bg-white border border-slate-200 rounded text-[11px]"
                        >
                          {Object.entries(TAX_BASE_TYPE_LABELS).map(([k, label]) => (
                            <option key={k} value={k}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <div className="col-span-5 flex items-center gap-1 bg-white border border-slate-200 rounded px-1.5 h-7">
                          <span className="text-[10px] text-slate-400">Base₱</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={comp.taxBaseAmount ?? ''}
                            onChange={(e) =>
                              updateTaxComponent(comp.id, {
                                taxBaseAmount:
                                  e.target.value === '' ? null : parseFloat(e.target.value) || 0,
                              })
                            }
                            placeholder="0.00"
                            className="w-full font-mono text-right bg-transparent focus:outline-none"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-12 gap-1.5 items-center">
                        <input
                          type="text"
                          value={comp.supportingDocRef}
                          onChange={(e) =>
                            updateTaxComponent(comp.id, { supportingDocRef: e.target.value })
                          }
                          placeholder="Invoice / BIR 2307 Ref..."
                          className="col-span-7 h-7 px-1.5 bg-white border border-slate-200 rounded text-[11px]"
                        />
                        <select
                          value={comp.roundingMethod}
                          onChange={(e) =>
                            updateTaxComponent(comp.id, {
                              roundingMethod: e.target.value as TaxRoundingMethod,
                            })
                          }
                          className="col-span-5 h-7 px-1 bg-white border border-slate-200 rounded text-[10px]"
                        >
                          <option value="half_up_2dp">Half-Up 2dp</option>
                          <option value="truncate_2dp">Truncate 2dp</option>
                        </select>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <div className="flex items-center gap-3">
                          <label className="inline-flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={comp.hasCompleteEvidence}
                              onChange={(e) =>
                                updateTaxComponent(comp.id, {
                                  hasCompleteEvidence: e.target.checked,
                                })
                              }
                            />
                            <span>Evidence OK</span>
                          </label>
                          <label className="inline-flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={Boolean(comp.classificationUncertain)}
                              onChange={(e) =>
                                updateTaxComponent(comp.id, {
                                  classificationUncertain: e.target.checked,
                                })
                              }
                            />
                            <span>Uncertain</span>
                          </label>
                        </div>
                        <div className="font-mono tabular-nums text-[10px]">
                          Exp ₱{formatPeso(comp.expectedWithholding)} · Act ₱
                          {formatPeso(comp.actualWithholding)} ·{' '}
                          <span
                            className={
                              Math.abs(comp.difference) > 0.01
                                ? 'text-red-600 font-semibold'
                                : 'text-emerald-700 font-semibold'
                            }
                          >
                            Δ ₱{formatPeso(comp.difference)}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 7-Point COA Audit Attributes (ELAS) */}
          <div className="p-3 border-b border-slate-200">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-700">Audit Attributes (1–7)</span>
              <span className="text-[11px] font-mono text-slate-500">
                {activeFlagCount === 0
                  ? 'All controls in place'
                  : [
                      attrCounts.exclamation > 0 ? `${attrCounts.exclamation} !` : '',
                      attrCounts.wrong > 0 ? `${attrCounts.wrong} ✕` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
              </span>
            </div>
            <div className="grid grid-cols-7 gap-1 mb-1.5">
              {AUDIT_ATTRIBUTE_LABELS.map((attr) => (
                <AuditAttributeCell
                  key={attr.key}
                  num={attr.num}
                  shortTag={attr.shortTag}
                  label={attr.label}
                  value={attributes[attr.key]}
                  onChange={(nextVal) => setAttributeValue(attr.key, nextVal)}
                />
              ))}
            </div>
            <p className="text-[10px] text-slate-400 mb-2">
              Click to cycle (✓ · ! · ✕ · –) · Right-click for direct menu
            </p>
            <textarea
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Reasons / Remarks or attached documents..."
              className="w-full p-2 text-xs border border-slate-200 rounded bg-slate-50 text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>

          {/* Complete 9-Field Procurement / COA Trail */}
          <div className="p-3 border-b border-slate-200">
            <button
              type="button"
              onClick={() => setShowProcurement((v) => !v)}
              className="w-full flex items-center justify-between text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
            >
              <span>Procurement / COA Trail (9 Fields)</span>
              <span className="text-slate-400">{showProcurement ? 'Hide' : 'Expand'}</span>
            </button>
            {showProcurement && (
              <div className="mt-2.5 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">
                      1. Date PO submitted to COA
                    </label>
                    <input
                      type="date"
                      value={procurement.poSubmittedToCoaDate || ''}
                      onChange={(e) =>
                        setProcurement((p) => ({ ...p, poSubmittedToCoaDate: e.target.value }))
                      }
                      className="w-full h-7 px-2 text-xs font-mono border border-slate-200 rounded bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">2. PO No. / Date</label>
                    <input
                      type="text"
                      value={procurement.poNoDate || ''}
                      onChange={(e) => setProcurement((p) => ({ ...p, poNoDate: e.target.value }))}
                      placeholder={`PO-${fiscalYear}-014 / 01-05-${shortYear}`}
                      className="w-full h-7 px-2 text-xs border border-slate-200 rounded bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">
                      3. Method of Procurement
                    </label>
                    <input
                      type="text"
                      list="rci-procurement-methods"
                      value={procurement.procurementMethod || ''}
                      onChange={(e) =>
                        setProcurement((p) => ({ ...p, procurementMethod: e.target.value }))
                      }
                      placeholder="SVP / Shopping / Bidding"
                      className="w-full h-7 px-2 text-xs border border-slate-200 rounded bg-slate-50"
                    />
                    <datalist id="rci-procurement-methods">
                      <option value="Small Value Procurement (SVP)" />
                      <option value="Shopping" />
                      <option value="Public Bidding" />
                      <option value="Direct Contracting" />
                      <option value="Repeat Order" />
                      <option value="Agency-to-Agency" />
                    </datalist>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">4. PhilGEPS / Date</label>
                    <input
                      type="text"
                      value={procurement.philgepsDate || ''}
                      onChange={(e) => setProcurement((p) => ({ ...p, philgepsDate: e.target.value }))}
                      placeholder="Ref # / 01-03-26"
                      className="w-full h-7 px-2 text-xs border border-slate-200 rounded bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">
                      5. Purchase Request No / Date
                    </label>
                    <input
                      type="text"
                      value={procurement.prNoDate || ''}
                      onChange={(e) => setProcurement((p) => ({ ...p, prNoDate: e.target.value }))}
                      placeholder={`PR-${fiscalYear}-009 / 01-02-${shortYear}`}
                      className="w-full h-7 px-2 text-xs border border-slate-200 rounded bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">
                      6. Abstract of Canvass / Date
                    </label>
                    <input
                      type="text"
                      value={procurement.abstractDate || ''}
                      onChange={(e) => setProcurement((p) => ({ ...p, abstractDate: e.target.value }))}
                      placeholder="Abstract # / 01-04-26"
                      className="w-full h-7 px-2 text-xs border border-slate-200 rounded bg-slate-50"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] text-slate-500 mb-1">
                    7. RFQ (3) — Minimum 3 Supplier Quotations
                  </label>
                  <div className="grid grid-cols-3 gap-1 p-0.5 bg-slate-100 rounded border border-slate-200">
                    {(
                      [
                        { val: '3plus', label: '✓ 3+ RFQs' },
                        { val: 'under3', label: '1–2 RFQs' },
                        { val: 'na', label: 'Blank / N/A' },
                      ] as Array<{ val: RfqStatus; label: string }>
                    ).map((opt) => {
                      const active = (procurement.rfqStatus || 'na') === opt.val;
                      return (
                        <button
                          key={opt.val}
                          type="button"
                          onClick={() =>
                            setProcurement((p) => ({
                              ...p,
                              rfqStatus: opt.val,
                              rfqCount: opt.val === '3plus' ? '3+' : '',
                            }))
                          }
                          className={`h-7 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                            active
                              ? opt.val === '3plus'
                                ? 'bg-emerald-700 text-white'
                                : opt.val === 'under3'
                                  ? 'bg-amber-600 text-white'
                                  : 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  {procurement.rfqStatus === 'under3' && (
                    <div className="mt-1.5 p-2 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-900 space-y-1">
                      <p>
                        Fewer than 3 RFQs attached — exports <strong>blank</strong> in COA sheet.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const note =
                              'Only 1–2 RFQ(s) attached; awaiting/justified per procurement file.';
                            setRemarks((r) => (r && r !== 'complete' ? `${r}\n${note}` : note));
                          }}
                          className="text-[11px] font-medium underline text-amber-800 hover:text-amber-950 cursor-pointer"
                        >
                          + Add RFQ note to Remarks
                        </button>
                        <button
                          type="button"
                          onClick={() => setAttributeValue('a5', 'exclamation')}
                          className="text-[11px] font-medium underline text-amber-800 hover:text-amber-950 cursor-pointer"
                        >
                          Flag Attr 5 (S) as !
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">
                      8. Inspection &amp; Acceptance Report Date
                    </label>
                    <input
                      type="date"
                      value={procurement.iarDate || ''}
                      onChange={(e) => setProcurement((p) => ({ ...p, iarDate: e.target.value }))}
                      className="w-full h-7 px-2 text-xs font-mono border border-slate-200 rounded bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">
                      9. Official Receipts / Invoice No.
                    </label>
                    <input
                      type="text"
                      value={procurement.orInvoiceRef || ''}
                      onChange={(e) =>
                        setProcurement((p) => ({ ...p, orInvoiceRef: e.target.value }))
                      }
                      placeholder="OR / SI #00451"
                      className="w-full h-7 px-2 text-xs border border-slate-200 rounded bg-slate-50"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Layer E: Expandable Verification Audit Trail */}
          <div className="p-3">
            <button
              type="button"
              onClick={() => setShowAuditTrail((v) => !v)}
              className="w-full flex items-center justify-between text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-slate-400" />
                <span>Verification Audit Trail ({verificationAuditTrail.length})</span>
              </span>
              <span className="text-slate-400">{showAuditTrail ? 'Hide' : 'Expand'}</span>
            </button>
            {showAuditTrail && (
              <div className="mt-2 space-y-1.5">
                {verificationAuditTrail.length === 0 ? (
                  <p className="text-[11px] text-slate-400">
                    No account-role, tax-rule, gross-basis, or review overrides logged yet.
                  </p>
                ) : (
                  verificationAuditTrail.map((evt) => (
                    <div
                      key={evt.id}
                      className="p-2 bg-slate-50 border border-slate-200 rounded text-[11px] space-y-0.5"
                    >
                      <div className="flex items-center justify-between text-slate-500 font-mono text-[10px]">
                        <span>{evt.category}</span>
                        <span>{evt.timestamp.slice(0, 16).replace('T', ' ')}</span>
                      </div>
                      <p className="text-slate-800 font-medium">{evt.reason}</p>
                      {(evt.previousValue || evt.newValue) && (
                        <p className="text-[10px] text-slate-500 font-mono truncate">
                          {evt.previousValue ? `${evt.previousValue} → ` : ''}
                          {evt.newValue}
                        </p>
                      )}
                      <p className="text-[10px] text-slate-400">By {evt.actorName}</p>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Batch Paste Modal — Zero-Line Draft RCI Net Importer */}
      {showBatchModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-5xl w-full p-5 flex flex-col max-h-[88vh]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-semibold text-slate-900 font-display">
                  Batch Paste RCI Records from Excel / TSV
                </h3>
                <p className="text-xs text-slate-500">
                  Columns: Date · Check/ADA No · DV No · Payee · Nature ·{' '}
                  <strong className="text-slate-800">Amount (Net of Tax)</strong> · [Optional Template Hint]
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBatchModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="my-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <label className="text-xs font-medium text-slate-600 whitespace-nowrap">
                  Suggested Template Hint:
                </label>
                <select
                  value={batchTemplateId}
                  onChange={(e) => {
                    setBatchTemplateId(e.target.value);
                    setBatchRowOverrides({});
                  }}
                  className="h-8 px-2.5 text-xs border border-slate-200 rounded bg-slate-50 font-medium text-slate-800"
                >
                  <option value="__auto__">Auto-Detect Hint per Row (Payee / Keywords)</option>
                  <option value="__draft__">No Template Hint (Plain Draft)</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      Hint All: {t.name}
                    </option>
                  ))}
                </select>
              </div>

              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={batchLearnPayees}
                  onChange={(e) => setBatchLearnPayees(e.target.checked)}
                />
                <span>Save new Payees to Directory</span>
              </label>
            </div>

            <div className="mb-2.5 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-900">
              All pasted RCI rows are imported as <strong>Draft (0 JEV lines)</strong> storing only the agency-submitted{' '}
              <strong>Check/ADA Amount (Net of Tax)</strong>. JEV Gross, Taxes Withheld, and accounting lines remain{' '}
              <strong>Pending JEV</strong> until encoded per voucher.
            </div>

            <textarea
              rows={5}
              value={batchText}
              onChange={(e) => {
                setBatchText(e.target.value);
                setBatchRowOverrides({});
              }}
              placeholder={`Date\tCheck/ADA No\tDV No\tPayee\tNature\tAmount (Net of Tax)\n01/12/${fiscalYear}\t3967130\t${fiscalYear}-01-015\tANECO\tPayment of Electricity Bill\t"14,779.01"`}
              className="w-full p-2.5 text-xs font-mono border border-slate-200 rounded bg-slate-50 focus:outline-none focus:border-blue-600 shrink-0"
            />

            {parsedBatchPreview.length > 0 && (
              <div className="mt-3 border border-slate-200 rounded overflow-auto flex-1 min-h-[160px]">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 z-10 text-[11px] font-semibold text-slate-600">
                    <tr>
                      <th className="py-2 px-2.5 w-12">Seq</th>
                      <th className="py-2 px-2.5 w-32">Date · Check / DV</th>
                      <th className="py-2 px-2.5">Payee &amp; Nature</th>
                      <th className="py-2 px-2.5 w-56">Suggested Template (Later JEV)</th>
                      <th className="py-2 px-2.5 text-right w-28">RCI Net (₱)</th>
                      <th className="py-2 px-2.5 text-right w-24">JEV Gross</th>
                      <th className="py-2 px-2.5 text-right w-20">Tax</th>
                      <th className="py-2 px-2.5 w-24 text-center">State</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {parsedBatchPreview.map(
                      ({ rowIndex, input, suggestedTpl, matchSource, isDupCheck, isDupDv }) => {
                        const selectVal = suggestedTpl?.id || '__none__';
                        const sourceLabel =
                          matchSource === 'manual'
                            ? 'Manual hint'
                            : matchSource === 'column'
                              ? 'From 7th column'
                              : matchSource === 'payee'
                                ? 'Matched Payee'
                                : matchSource === 'keyword'
                                  ? 'Matched Keyword'
                                  : 'No hint';

                        return (
                          <tr
                            key={input.sequenceNo}
                            className={
                              isDupCheck || isDupDv ? 'bg-red-50/40' : 'bg-amber-50/25 hover:bg-slate-50'
                            }
                          >
                            <td className="py-1.5 px-2.5 font-mono tabular-nums text-slate-500 align-top">
                              {input.sequenceNo}
                            </td>
                            <td className="py-1.5 px-2.5 font-mono tabular-nums align-top whitespace-nowrap">
                              <div className="text-[10px] text-slate-500">{input.adaCheckDate}</div>
                              <div
                                className={
                                  isDupCheck ? 'text-red-700 font-bold' : 'text-slate-900'
                                }
                              >
                                {input.adaCheckNo}
                                {isDupCheck && ' (DUP)'}
                              </div>
                              <div
                                className={`text-[10px] ${
                                  isDupDv ? 'text-red-600 font-semibold' : 'text-slate-400'
                                }`}
                              >
                                {input.dvNo}
                                {isDupDv && ' (DUP)'}
                              </div>
                            </td>
                            <td className="py-1.5 px-2.5 align-top max-w-[220px]">
                              <div className="font-medium text-slate-900 truncate">
                                {input.payeeName}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {input.natureOfTransaction}
                              </div>
                            </td>
                            <td className="py-1.5 px-2.5 align-top">
                              <select
                                value={selectVal}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setBatchRowOverrides((prev) => ({
                                    ...prev,
                                    [rowIndex]: val,
                                  }));
                                }}
                                className="w-full h-7 px-1.5 text-[11px] border border-slate-200 rounded bg-white text-slate-800"
                              >
                                <option value="__none__">No Template Hint</option>
                                {templates.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name}
                                  </option>
                                ))}
                              </select>
                              <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500">
                                <span>{sourceLabel}</span>
                                <span className="font-mono">0 JEV lines</span>
                              </div>
                            </td>
                            <td className="py-1.5 px-2.5 text-right font-mono tabular-nums font-semibold text-emerald-700 align-top whitespace-nowrap">
                              {formatPeso(input.rciAmount)}
                            </td>
                            <td className="py-1.5 px-2.5 text-right text-[11px] text-amber-700 align-top whitespace-nowrap">
                              Pending JEV
                            </td>
                            <td className="py-1.5 px-2.5 text-right text-[11px] text-slate-400 align-top whitespace-nowrap">
                              Pending
                            </td>
                            <td className="py-1.5 px-2.5 text-center align-top text-[11px] font-medium text-amber-700">
                              Draft
                            </td>
                          </tr>
                        );
                      },
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-slate-500 font-mono tabular-nums">
                {parsedBatchPreview.length > 0 ? (
                  <span>
                    {batchSummary.total} Draft(s) · Total RCI Net ₱{formatPeso(batchSummary.totalRci)}
                    {batchParseResult.skippedHeader ? ' · Header skipped' : ''}
                    {batchSummary.duplicates > 0 && (
                      <span className="text-red-600 font-semibold">
                        {' '}
                        · {batchSummary.duplicates} duplicate Check/DV
                      </span>
                    )}
                  </span>
                ) : (
                  'Paste tab- or comma-separated RCI rows above (headers auto-skipped)'
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowBatchModal(false)}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={parsedBatchPreview.length === 0 || submitting}
                  onClick={() => void handleBatchImport()}
                  className="px-4 py-1.5 text-xs font-medium text-white bg-slate-900 rounded hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  Import {parsedBatchPreview.length} Draft(s)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
