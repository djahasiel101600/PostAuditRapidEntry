import React, { useMemo, useState } from 'react';
import { CheckCircle2, Download, Eye, EyeOff, Pencil, ShieldCheck } from 'lucide-react';
import { AuditAttributeCell } from './AuditAttributeCell';
import { useAuthWorkspace } from '../contexts/AuthWorkspaceContext';
import { exportWorkingPaperWorkbook } from '../lib/excelExport';
import { renderSlashPair } from '../lib/slashPair';
import {
  createVerificationAuditEvent,
  deriveClerkReviewStatus,
  formatPeso,
  getDisplayRciNetAmount,
  hasFlaggedAttribute,
  isCancelledTransaction,
  isJevExempt,
  isJevPending,
  isLegacyTransaction,
  normalizePaymentMode,
  NO_JEV_CANCELLED_LABEL,
  paymentModeLabel,
  sanitizeVerificationAuditTrail,
  summarizeLedgerTotals,
} from '../lib/taxAndLedger';
import {
  AUDIT_ATTRIBUTE_LABELS,
  CANCELLED_CHECK_ATTACHMENT_LABELS,
  DV_SIGNATORY_LABELS,
  MONTHS,
  type AuditAttributesMap,
  type AuditAttributeState,
  type CancelledCheckAttachment,
  type DvSignatoriesMap,
  type MonthName,
  type TestOfControlsStatus,
  type TransactionRecord,
  type TransactionStatus,
} from '../types/rci';

const TOC_STATUS_LABELS: Record<TestOfControlsStatus, string> = {
  allowed: 'Allowed',
  suspended: 'Suspended',
  disallowed: 'Disallowed',
};

const TOC_CHIP_CLS: Record<TestOfControlsStatus, string> = {
  allowed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  suspended: 'border-amber-300 bg-amber-50 text-amber-800',
  disallowed: 'border-red-300 bg-red-50 text-red-700',
};

const TOC_BTN_ACTIVE: Record<TestOfControlsStatus, string> = {
  allowed: 'border-emerald-600 bg-emerald-600 text-white',
  suspended: 'border-amber-500 bg-amber-500 text-white',
  disallowed: 'border-red-600 bg-red-600 text-white',
};

interface MonthlyLedgerViewProps {
  onEditInRapidEntry: (tx: TransactionRecord) => void;
}

export const MonthlyLedgerView: React.FC<MonthlyLedgerViewProps> = ({ onEditInRapidEntry }) => {
  const {
    user,
    activeWorkspace,
    activeRole,
    transactions,
    selectedMonth,
    setSelectedMonth,
    updateTransaction,
  } = useAuthWorkspace();

  const [showPurchases, setShowPurchases] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | TransactionStatus | 'cancelled'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingRemarksId, setEditingRemarksId] = useState<string | null>(null);
  const [remarksDraft, setRemarksDraft] = useState('');
  const [editingTocId, setEditingTocId] = useState<string | null>(null);
  const [tocStatusDraft, setTocStatusDraft] = useState<TestOfControlsStatus | ''>('');
  const [tocParticularsDraft, setTocParticularsDraft] = useState('');

  const monthRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (tx.month !== selectedMonth) return false;
      if (statusFilter === 'cancelled') {
        if (!isCancelledTransaction(tx)) return false;
      } else if (statusFilter !== 'all' && tx.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        tx.payeeName.toLowerCase().includes(q) ||
        tx.adaCheckNo.toLowerCase().includes(q) ||
        tx.dvNo.toLowerCase().includes(q) ||
        (tx.jevNoDate || '').toLowerCase().includes(q) ||
        (tx.remarks || '').toLowerCase().includes(q) ||
        (tx.cancellationReason || '').toLowerCase().includes(q)
      );
    });
  }, [transactions, selectedMonth, statusFilter, searchQuery]);

  const monthTotals = useMemo(() => summarizeLedgerTotals(monthRows), [monthRows]);

  const handleChangeAttr = async (
    tx: TransactionRecord,
    key: keyof AuditAttributesMap,
    nextVal: AuditAttributeState,
  ) => {
    if (tx.status === 'audited' && activeRole === 'encoder') return;
    const nextAttrs: AuditAttributesMap = {
      ...tx.attributes,
      [key]: nextVal,
    };
    const flagged = hasFlaggedAttribute(nextAttrs);
    const nextStatus: TransactionStatus =
      tx.status === 'audited'
        ? flagged
          ? 'lacking'
          : 'audited'
        : tx.status === 'draft'
          ? 'draft'
          : flagged
            ? 'lacking'
            : 'posted';

    // Preserve legacy records untouched (never mutate amountModelVersion or amounts on attribute edits)
    if (isLegacyTransaction(tx)) {
      await updateTransaction(tx.id, { attributes: nextAttrs, status: nextStatus });
    } else {
      await updateTransaction(tx.id, {
        attributes: nextAttrs,
        status: nextStatus,
        clerkReviewStatus: deriveClerkReviewStatus(nextStatus, nextAttrs),
      });
    }
  };

  const handleChangeDvSignatory = async (
    tx: TransactionRecord,
    key: keyof DvSignatoriesMap,
    nextVal: AuditAttributeState,
  ) => {
    if (tx.status === 'audited' && activeRole === 'encoder') return;
    await updateTransaction(tx.id, {
      dvSignatories: { ...(tx.dvSignatories || {}), [key]: nextVal },
    });
  };

  const handleChangeCancelledEvidence = async (
    tx: TransactionRecord,
    next: CancelledCheckAttachment | '',
  ) => {
    const previousLabel = tx.cancelledCheckAttachment
      ? CANCELLED_CHECK_ATTACHMENT_LABELS[tx.cancelledCheckAttachment]
      : 'Pending verification';
    const evt = createVerificationAuditEvent({
      actorUid: user?.uid || 'system',
      actorName: user?.displayName || user?.email || 'Auditor',
      category: 'cancelled_check_evidence',
      targetRef: tx.adaCheckNo || `#${tx.sequenceNo}`,
      previousValue: previousLabel,
      newValue: next ? CANCELLED_CHECK_ATTACHMENT_LABELS[next] : 'Pending verification',
      reason: `Post-audit cancelled-check evidence set to ${next || 'pending verification'}`,
    });
    const trail = sanitizeVerificationAuditTrail([...(tx.verificationAuditTrail || []), evt]);
    await updateTransaction(tx.id, {
      cancelledCheckAttachment: next,
      verificationAuditTrail: trail,
    });
  };

  // Admins and auditors both exercise audit controls (sign-off, ToC, audited-row edits).
  const canAudit = activeRole === 'admin' || activeRole === 'auditor';

  const buildTocRowReference = (tx: TransactionRecord) =>
    `#${tx.sequenceNo} · DV ${tx.dvNo || '—'} · Check/ADA ${tx.adaCheckNo || '—'} · ₱${formatPeso(getDisplayRciNetAmount(tx))}`;

  const openTocEditor = (tx: TransactionRecord) => {
    if (!canAudit) return;
    setEditingTocId(tx.id);
    setTocStatusDraft(tx.testOfControls?.status || '');
    setTocParticularsDraft(tx.testOfControls?.particulars || '');
  };

  const handleSaveTestOfControls = async (tx: TransactionRecord) => {
    const particulars = tocParticularsDraft.trim();
    const evt = createVerificationAuditEvent({
      actorUid: user?.uid || 'system',
      actorName: user?.displayName || user?.email || 'Auditor',
      category: 'clerk_review_decision',
      targetRef: tx.adaCheckNo,
      previousValue: tx.testOfControls?.status || 'none',
      newValue: tocStatusDraft || 'none',
      reason: `Test of Controls: ${tocStatusDraft ? TOC_STATUS_LABELS[tocStatusDraft] : 'Cleared'}${
        particulars ? ` — ${particulars.slice(0, 120)}` : ''
      }`,
    });
    const trail = sanitizeVerificationAuditTrail([...(tx.verificationAuditTrail || []), evt]);
    await updateTransaction(tx.id, {
      testOfControls: {
        status: tocStatusDraft || undefined,
        particulars: particulars || undefined,
      },
      verificationAuditTrail: trail,
    });
    setEditingTocId(null);
    setTocStatusDraft('');
    setTocParticularsDraft('');
  };

  const handleMarkAudited = async (tx: TransactionRecord) => {
    const nextStatus: TransactionStatus = tx.status === 'audited' ? 'posted' : 'audited';
    const nextClerk =
      nextStatus === 'audited'
        ? 'audited'
        : deriveClerkReviewStatus(nextStatus, tx.attributes);
    const evt = createVerificationAuditEvent({
      actorUid: user?.uid || 'system',
      actorName: user?.displayName || user?.email || 'Auditor',
      category: 'clerk_review_decision',
      targetRef: tx.adaCheckNo,
      previousValue: tx.status,
      newValue: nextStatus,
      reason:
        nextStatus === 'audited'
          ? 'Auditor signed off transaction in Monthly Working Paper'
          : 'Auditor unlocked audited entry back to posted',
    });
    const trail = sanitizeVerificationAuditTrail([...(tx.verificationAuditTrail || []), evt]);

    await updateTransaction(tx.id, {
      status: nextStatus,
      clerkReviewStatus: nextClerk,
      verificationAuditTrail: trail,
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Month Bar */}
      <div className="bg-white border-b border-slate-200 px-5 py-2 flex items-center justify-between gap-4 overflow-x-auto">
        <div className="flex items-center gap-1">
          {MONTHS.map((m: MonthName) => {
            const count = transactions.filter((t) => t.month === m).length;
            const active = m === selectedMonth;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setSelectedMonth(m)}
                className={`px-2.5 py-1 text-xs rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-slate-900 text-white font-medium'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span>{m.slice(0, 3)}</span>
                {count > 0 && (
                  <span className={`ml-1 font-mono text-[10px] ${active ? 'text-slate-300' : 'text-slate-400'}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() =>
            exportWorkingPaperWorkbook(activeWorkspace?.name || 'RCI_Ledger', selectedMonth, monthRows)
          }
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export {selectedMonth} .xlsx</span>
        </button>
      </div>

      {/* Filter & Procurement Toggle Bar */}
      <div className="bg-slate-50 border-b border-slate-200 px-5 py-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-0.5 bg-white border border-slate-200 rounded">
            {(['all', 'posted', 'lacking', 'audited', 'draft', 'cancelled'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-2.5 py-1 text-xs rounded capitalize transition-colors cursor-pointer whitespace-nowrap ${
                  statusFilter === st
                    ? 'bg-slate-900 text-white font-medium'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowPurchases((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors cursor-pointer whitespace-nowrap ${
              showPurchases
                ? 'bg-amber-50 border-amber-300 text-amber-800'
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            {showPurchases ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            <span>{showPurchases ? 'Hide Purchases (PO/PhilGEPS)' : 'Show Purchases (PO/PhilGEPS)'}</span>
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden lg:flex items-center gap-2 text-xs font-mono tabular-nums text-slate-600">
            <span>JEV Gross: ₱{formatPeso(monthTotals.gross)}</span>
            <span aria-hidden="true">·</span>
            <span>Tax: ₱{formatPeso(monthTotals.tax)}</span>
            <span aria-hidden="true">·</span>
            <span className="text-slate-900 font-semibold">RCI Net: ₱{formatPeso(monthTotals.net)}</span>
            {monthTotals.cancelledCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-rose-700 font-semibold">
                  Cancelled: {monthTotals.cancelledCount} (₱{formatPeso(monthTotals.cancelledNet)}{' '}
                  excluded)
                </span>
              </>
            )}
          </div>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search Payee, Check #, JEV..."
            className="w-56 h-7 px-2.5 text-xs bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-600"
          />
        </div>
      </div>

      {/* Multi-Row Double-Entry Working Paper Table */}
      <div className="flex-1 overflow-auto bg-white">
        {monthRows.length === 0 ? (
          <div className="h-full min-h-[260px] flex flex-col items-center justify-center p-8 text-center">
            <p className="text-sm font-medium text-slate-900">
              No working-paper entries match the current filter in {selectedMonth}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Switch months above or add disbursements from Rapid Entry.
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-slate-100 border-b border-slate-300 z-10 text-[11px] font-semibold text-slate-700">
              <tr>
                <th className="py-2 px-2.5 border-r border-slate-200 w-10">No.</th>
                <th className="py-2 px-2.5 border-r border-slate-200 w-24">ADA/Check Date</th>
                <th className="py-2 px-2.5 border-r border-slate-200 w-28">Check/ADA No</th>
                <th className="py-2 px-2.5 border-r border-slate-200 w-40">Payee</th>
                <th className="py-2 px-2.5 border-r border-slate-200 text-right w-28">RCI Net Paid</th>
                <th className="py-2 px-2.5 border-r border-slate-200 text-right w-28">JEV Gross</th>
                <th className="py-2 px-2.5 border-r border-slate-200 text-center w-24">
                  Evidence
                </th>
                <th className="py-2 px-2.5 border-r border-slate-200 text-center w-48">
                  Attributes (1–7 · ELAS)
                </th>
                <th className="py-2 px-2.5 border-r border-slate-200 text-center w-24">
                  DV Sig. (A·B·C)
                </th>
                {showPurchases && (
                  <>
                    <th className="py-2 px-2 border-r border-slate-200 bg-amber-50/80 text-amber-900 whitespace-nowrap">
                      PO to COA
                    </th>
                    <th className="py-2 px-2 border-r border-slate-200 bg-amber-50/80 text-amber-900 whitespace-nowrap">
                      PO No./Date
                    </th>
                    <th className="py-2 px-2 border-r border-slate-200 bg-amber-50/80 text-amber-900 whitespace-nowrap">
                      Method
                    </th>
                    <th className="py-2 px-2 border-r border-slate-200 bg-amber-50/80 text-amber-900 whitespace-nowrap">
                      PhilGEPS/Date
                    </th>
                    <th className="py-2 px-2 border-r border-slate-200 bg-amber-50/80 text-amber-900 whitespace-nowrap">
                      PR No./Date
                    </th>
                    <th className="py-2 px-2 border-r border-slate-200 bg-amber-50/80 text-amber-900 whitespace-nowrap">
                      Abstract/Date
                    </th>
                    <th className="py-2 px-2 border-r border-slate-200 bg-amber-50/80 text-amber-900 text-center whitespace-nowrap">
                      RFQ (3)
                    </th>
                    <th className="py-2 px-2 border-r border-slate-200 bg-amber-50/80 text-amber-900 whitespace-nowrap">
                      IAR / Date
                    </th>
                    <th className="py-2 px-2 border-r border-slate-200 bg-amber-50/80 text-amber-900 whitespace-nowrap">
                      OR / Invoice No.
                    </th>
                  </>
                )}
                <th className="py-2 px-2.5 border-r border-slate-200 min-w-[200px]">
                  Test of Controls
                </th>
                <th className="py-2 px-2.5 border-r border-slate-200 w-36">JEV No. &amp; Date</th>
                <th className="py-2 px-2.5 border-r border-slate-200 w-24">Acct Code</th>
                <th className="py-2 px-2.5 border-r border-slate-200">Account Title</th>
                <th className="py-2 px-2.5 border-r border-slate-200 text-right w-24">Dr Amount</th>
                <th className="py-2 px-2.5 border-r border-slate-200 text-right w-24">Cr Amount</th>
                <th className="py-2 px-2.5 border-r border-slate-200 min-w-[200px]">Reasons / Remarks</th>
                <th className="py-2 px-2.5 w-24 text-right">Audit</th>
              </tr>
            </thead>
            <tbody>
              {monthRows.map((tx) => {
                const hasJevLines = tx.journalLines.length > 0;
                const jevExempt = isJevExempt(tx);
                const lines = hasJevLines
                  ? tx.journalLines
                  : [
                      {
                        accountCode: '—',
                        accountTitle: jevExempt ? NO_JEV_CANCELLED_LABEL : 'Pending JEV encoding',
                        debit: 0,
                        credit: 0,
                      },
                    ];
                const isPendingJev = isJevPending(tx);
                const legacy = isLegacyTransaction(tx);

                return lines.map((line, lineIdx) => {
                  const isFirst = lineIdx === 0;
                  const isLast = lineIdx === lines.length - 1;
                  const rowSpan = lines.length;
                  const borderBottom = isLast ? 'border-b-2 border-slate-300' : 'border-b border-slate-100';

                  return (
                    <tr
                      key={`${tx.id}-${lineIdx}`}
                      className={`${borderBottom} ${lineIdx % 2 === 1 ? 'bg-slate-50/60' : 'bg-white'}`}
                    >
                      {isFirst && (
                        <>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2.5 border-r border-slate-200 align-top font-mono tabular-nums text-slate-500"
                          >
                            {tx.sequenceNo}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2.5 border-r border-slate-200 align-top font-mono tabular-nums text-slate-700 whitespace-nowrap"
                          >
                            {tx.adaCheckDate}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2.5 border-r border-slate-200 align-top font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap"
                          >
                            <span
                              className={`inline-block text-[10px] leading-none px-1 py-0.5 rounded border mr-1 align-middle font-sans font-semibold ${
                                normalizePaymentMode(tx.paymentMode) === 'ada'
                                  ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                                  : 'bg-slate-100 text-slate-600 border-slate-200'
                              }`}
                            >
                              {paymentModeLabel(tx.paymentMode)}
                            </span>
                            {tx.adaCheckNo}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2.5 border-r border-slate-200 align-top text-slate-900 font-medium"
                          >
                            <div className="truncate max-w-[160px]" title={tx.payeeName}>
                              {tx.payeeName}
                            </div>
                            <div className="text-[11px] font-normal text-slate-500 mt-0.5 truncate max-w-[160px]">
                              {tx.dvNo}
                            </div>
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2.5 border-r border-slate-200 align-top text-right font-mono tabular-nums font-semibold text-emerald-800 whitespace-nowrap"
                          >
                            {tx.isCancelled && (
                              <span className="mb-0.5 block text-[10px] font-sans font-semibold text-rose-700">
                                CANCELLED
                              </span>
                            )}
                            <span
                              className={tx.isCancelled ? 'line-through text-slate-400' : ''}
                              title={
                                tx.isCancelled ? 'Cancelled check — excluded from totals' : undefined
                              }
                            >
                              {formatPeso(getDisplayRciNetAmount(tx))}
                            </span>
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2.5 border-r border-slate-200 align-top text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap"
                          >
                            {jevExempt && !hasJevLines ? (
                              <span
                                className="text-[11px] font-sans font-normal text-slate-400"
                                title="Cancelled check — no JEV entry will be encoded"
                              >
                                —
                              </span>
                            ) : isPendingJev ? (
                              <span className="text-[11px] font-sans font-normal text-amber-700">
                                Pending JEV
                              </span>
                            ) : (
                              <span className={tx.isCancelled ? 'line-through text-slate-400' : ''}>
                                {formatPeso(tx.grossAmount)}
                              </span>
                            )}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2 border-r border-slate-200 align-top text-center"
                          >
                            {tx.isCancelled ? (
                              canAudit ? (
                                <select
                                  value={tx.cancelledCheckAttachment || ''}
                                  onChange={(e) =>
                                    void handleChangeCancelledEvidence(
                                      tx,
                                      e.target.value as CancelledCheckAttachment | '',
                                    )
                                  }
                                  title={tx.cancellationReason || 'Original cancelled check on file?'}
                                  className="w-full max-w-[104px] h-7 px-1 text-[10px] border border-rose-200 rounded bg-white text-slate-700"
                                >
                                  <option value="">Pending</option>
                                  <option value="attached">Attached</option>
                                  <option value="missing">Missing</option>
                                  <option value="na">N/A</option>
                                </select>
                              ) : (
                                <span
                                  className={`text-[10px] font-medium ${
                                    tx.cancelledCheckAttachment === 'missing'
                                      ? 'text-red-600'
                                      : tx.cancelledCheckAttachment === 'attached'
                                        ? 'text-emerald-700'
                                        : tx.cancelledCheckAttachment === 'na'
                                          ? 'text-slate-500'
                                          : 'text-amber-700'
                                  }`}
                                >
                                  {tx.cancelledCheckAttachment
                                    ? tx.cancelledCheckAttachment === 'attached'
                                      ? 'Attached'
                                      : tx.cancelledCheckAttachment === 'missing'
                                        ? 'Missing'
                                        : 'N/A'
                                    : 'Pending'}
                                </span>
                              )
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2 border-r border-slate-200 align-top"
                          >
                            <div className="grid grid-cols-7 gap-0.5">
                              {AUDIT_ATTRIBUTE_LABELS.map((attr) => (
                                <AuditAttributeCell
                                  key={attr.key}
                                  compact
                                  num={attr.num}
                                  shortTag={attr.shortTag}
                                  label={attr.label}
                                  value={tx.attributes[attr.key]}
                                  disabled={tx.status === 'audited' && activeRole === 'encoder'}
                                  onChange={(nextVal) => void handleChangeAttr(tx, attr.key, nextVal)}
                                />
                              ))}
                            </div>
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2 border-r border-slate-200 align-top"
                          >
                            <div className="grid grid-cols-3 gap-0.5 w-24">
                              {DV_SIGNATORY_LABELS.map((sig) => (
                                <AuditAttributeCell
                                  key={sig.key}
                                  compact
                                  num={0}
                                  prefix={sig.letter}
                                  label={sig.label}
                                  value={tx.dvSignatories?.[sig.key] || 'ok'}
                                  disabled={tx.status === 'audited' && activeRole === 'encoder'}
                                  onChange={(nextVal) =>
                                    void handleChangeDvSignatory(tx, sig.key, nextVal)
                                  }
                                />
                              ))}
                            </div>
                          </td>
                          {showPurchases && (
                            <>
                              <td
                                rowSpan={rowSpan}
                                className="py-2 px-2 border-r border-slate-200 align-top bg-amber-50/30 font-mono text-[11px] text-slate-700 whitespace-nowrap"
                              >
                                {tx.procurement?.poSubmittedToCoaDate || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                className="py-2 px-2 border-r border-slate-200 align-top bg-amber-50/30 text-slate-700 whitespace-nowrap"
                              >
                                {renderSlashPair(
                                  tx.procurement?.poNo,
                                  tx.procurement?.poDate,
                                  tx.procurement?.poNoDate,
                                ) || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                className="py-2 px-2 border-r border-slate-200 align-top bg-amber-50/30 text-slate-700"
                              >
                                {tx.procurement?.procurementMethod || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                className="py-2 px-2 border-r border-slate-200 align-top bg-amber-50/30 font-mono text-[11px] text-slate-700 whitespace-nowrap"
                              >
                                {tx.procurement?.philgepsDate || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                className="py-2 px-2 border-r border-slate-200 align-top bg-amber-50/30 font-mono text-[11px] text-slate-700 whitespace-nowrap"
                              >
                                {renderSlashPair(
                                  tx.procurement?.prNo,
                                  tx.procurement?.prDate,
                                  tx.procurement?.prNoDate,
                                ) || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                className="py-2 px-2 border-r border-slate-200 align-top bg-amber-50/30 font-mono text-[11px] text-slate-700 whitespace-nowrap"
                              >
                                {tx.procurement?.abstractDate || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                className="py-2 px-2 border-r border-slate-200 align-top bg-amber-50/30 text-center font-mono text-[11px] whitespace-nowrap"
                              >
                                {tx.procurement?.rfqStatus === '3plus' ? (
                                  <span className="text-emerald-700 font-bold" title="3+ RFQs attached">
                                    ✓
                                  </span>
                                ) : tx.procurement?.rfqStatus === 'under3' ? (
                                  <span
                                    className="text-amber-700 font-semibold"
                                    title="1–2 RFQs attached — exports blank in COA sheet; see Remarks"
                                  >
                                    1–2!
                                  </span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                className="py-2 px-2 border-r border-slate-200 align-top bg-amber-50/30 font-mono text-[11px] text-slate-700 whitespace-nowrap"
                              >
                                {renderSlashPair(
                                  tx.procurement?.iarNo,
                                  tx.procurement?.iarDate,
                                  undefined,
                                ) || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                className="py-2 px-2 border-r border-slate-200 align-top bg-amber-50/30 font-mono text-[11px] text-slate-700 whitespace-nowrap"
                              >
                                {tx.procurement?.orInvoiceRef || tx.orNoDate || '—'}
                              </td>
                            </>
                          )}
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2 border-r border-slate-200 align-top min-w-[200px]"
                          >
                            {editingTocId === tx.id ? (
                              <div className="space-y-1">
                                <div className="flex flex-wrap gap-1">
                                  {(['allowed', 'suspended', 'disallowed'] as const).map((st) => (
                                    <button
                                      key={st}
                                      type="button"
                                      onClick={() => setTocStatusDraft(st)}
                                      className={`px-1.5 py-0.5 text-[10px] rounded border capitalize cursor-pointer transition-colors ${
                                        tocStatusDraft === st
                                          ? TOC_BTN_ACTIVE[st]
                                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                                      }`}
                                    >
                                      {st}
                                    </button>
                                  ))}
                                </div>
                                <textarea
                                  rows={3}
                                  maxLength={2000}
                                  value={tocParticularsDraft}
                                  onChange={(e) => setTocParticularsDraft(e.target.value)}
                                  placeholder="Item/ref no. · Nature of expenditure · DV no. · Check/ADA no. · Amount examined"
                                  className="w-full p-1.5 text-xs border border-blue-400 rounded bg-white"
                                />
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setTocParticularsDraft((prev) => {
                                        const ref = buildTocRowReference(tx);
                                        return prev.trim()
                                          ? `${prev.replace(/\s+$/, '')}\n${ref}`
                                          : ref;
                                      })
                                    }
                                    className="px-1.5 py-0.5 text-[10px] rounded border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer"
                                  >
                                    Insert row reference
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleSaveTestOfControls(tx)}
                                    className="px-2 py-0.5 bg-slate-900 text-white text-[11px] rounded cursor-pointer"
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingTocId(null)}
                                    className="px-2 py-0.5 text-slate-600 text-[11px] cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div
                                onClick={() => openTocEditor(tx)}
                                title={
                                  tx.testOfControls?.particulars ||
                                  (canAudit ? 'Click to edit Test of Controls' : undefined)
                                }
                                className={`space-y-0.5 ${
                                  canAudit ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
                                }`}
                              >
                                <span
                                  className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                                    tx.testOfControls?.status
                                      ? TOC_CHIP_CLS[tx.testOfControls.status]
                                      : 'border-slate-200 bg-slate-50 text-slate-400'
                                  }`}
                                >
                                  {tx.testOfControls?.status
                                    ? TOC_STATUS_LABELS[tx.testOfControls.status]
                                    : '—'}
                                </span>
                                {tx.testOfControls?.particulars && (
                                  <p className="text-[11px] text-slate-600 truncate max-w-[220px]">
                                    {tx.testOfControls.particulars}
                                  </p>
                                )}
                              </div>
                            )}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            className="py-2 px-2.5 border-r border-slate-200 align-top font-mono tabular-nums text-[11px] text-slate-700"
                          >
                            {tx.jevNoDate || '—'}
                          </td>
                        </>
                      )}

                      <td className="py-1.5 px-2.5 border-r border-slate-200 font-mono tabular-nums text-[11px] text-slate-600">
                        {line.accountCode}
                      </td>
                      <td className="py-1.5 px-2.5 border-r border-slate-200 text-slate-900">
                        {line.accountTitle}
                      </td>
                      <td className="py-1.5 px-2.5 border-r border-slate-200 text-right font-mono tabular-nums text-slate-900">
                        {line.debit > 0 ? formatPeso(line.debit) : ''}
                      </td>
                      <td className="py-1.5 px-2.5 border-r border-slate-200 text-right font-mono tabular-nums text-slate-900">
                        {line.credit > 0 ? formatPeso(line.credit) : ''}
                      </td>

                      {isFirst && (
                        <>
                          <td rowSpan={rowSpan} className="py-2 px-2.5 border-r border-slate-200 align-top">
                            {editingRemarksId === tx.id ? (
                              <div className="space-y-1">
                                <textarea
                                  rows={2}
                                  value={remarksDraft}
                                  onChange={(e) => setRemarksDraft(e.target.value)}
                                  className="w-full p-1.5 text-xs border border-blue-400 rounded bg-white"
                                />
                                <div className="flex gap-1.5">
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      await updateTransaction(tx.id, { remarks: remarksDraft });
                                      setEditingRemarksId(null);
                                    }}
                                    className="px-2 py-0.5 bg-slate-900 text-white text-[11px] rounded cursor-pointer"
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingRemarksId(null)}
                                    className="px-2 py-0.5 text-slate-600 text-[11px] cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div
                                onClick={() => {
                                  if (tx.status === 'audited' && !canAudit) return;
                                  setEditingRemarksId(tx.id);
                                  setRemarksDraft(tx.remarks || '');
                                }}
                                title="Click to edit remarks"
                                className="text-slate-700 whitespace-pre-line cursor-pointer hover:text-slate-950"
                              >
                                {tx.remarks || <span className="text-slate-400">Add remark...</span>}
                              </div>
                            )}
                          </td>
                          <td rowSpan={rowSpan} className="py-2 px-2.5 align-top text-right whitespace-nowrap">
                            <div className="flex flex-col items-end gap-1">
                              <span
                                className={`text-[11px] font-medium capitalize ${
                                  tx.status === 'audited'
                                    ? 'text-emerald-700'
                                    : tx.status === 'lacking'
                                      ? 'text-red-600'
                                      : tx.status === 'draft'
                                        ? 'text-amber-700'
                                        : 'text-slate-600'
                                }`}
                              >
                                {tx.status}
                              </span>
                              {!legacy && (
                                <span
                                  className={`text-[10px] font-mono ${
                                    jevExempt
                                      ? 'text-slate-400'
                                      : tx.mathStatus === 'discrepancy' || tx.taxStatus === 'variance'
                                        ? 'text-red-600 font-semibold'
                                        : tx.mathStatus === 'manual_review' ||
                                            tx.taxStatus === 'manual_review'
                                          ? 'text-amber-700'
                                          : tx.mathStatus === 'reconciled'
                                            ? 'text-emerald-700'
                                            : 'text-slate-400'
                                  }`}
                                  title={
                                    jevExempt
                                      ? 'Cancelled check — no JEV entry will be encoded'
                                      : `Math: ${tx.mathStatus || 'pending_jev'} · Tax: ${tx.taxStatus || 'pending_base'} · Doc: ${tx.documentaryStatus || 'incomplete'}`
                                  }
                                >
                                  {jevExempt ? (
                                    'JEV-exempt'
                                  ) : (
                                    <>
                                      {tx.mathStatus === 'reconciled'
                                        ? 'M:OK'
                                        : tx.mathStatus === 'discrepancy'
                                          ? 'M:Δ'
                                          : tx.mathStatus === 'manual_review'
                                            ? 'M:REV'
                                            : 'M:PND'}
                                      {tx.taxStatus === 'verified'
                                        ? '·T:OK'
                                        : tx.taxStatus === 'variance'
                                          ? '·T:Δ'
                                          : ''}
                                    </>
                                  )}
                                </span>
                              )}
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => onEditInRapidEntry(tx)}
                                  title="Open in Rapid Entry"
                                  className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                {canAudit && (
                                  <button
                                    type="button"
                                    onClick={() => void handleMarkAudited(tx)}
                                    title={tx.status === 'audited' ? 'Unlock Audited Entry' : 'Sign off as Audited'}
                                    className={`p-1 rounded cursor-pointer ${
                                      tx.status === 'audited'
                                        ? 'text-emerald-700 bg-emerald-50'
                                        : 'text-slate-500 hover:text-emerald-700 hover:bg-emerald-50'
                                    }`}
                                  >
                                    {tx.status === 'audited' ? (
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                    ) : (
                                      <ShieldCheck className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                )}
                              </div>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
