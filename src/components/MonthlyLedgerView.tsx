import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Download, Eye, EyeOff, Pencil, Pin, ShieldCheck } from 'lucide-react';
import { AuditAttributeCell } from './AuditAttributeCell';
import { useAuthWorkspace } from '../contexts/AuthWorkspaceContext';
import { exportWorkingPaperWorkbook } from '../lib/excelExport';
import { readPair, renderSlashPair } from '../lib/slashPair';
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

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatLedgerDate = (value: string): string => {
  const match = ISO_DATE_RE.exec(value.trim());
  return match ? `${match[2]}-${match[3]}-${match[1]}` : value;
};

/**
 * Fixed column widths are what make freeze panes reliable: the sticky offset of
 * a frozen column is the running sum of the widths before it, so a column that
 * grew to fit its content would silently desync the whole pinned block. The
 * table is therefore `table-fixed` + `<colgroup>` driven and long cell content
 * truncates instead of widening its column.
 */
type LedgerColumnKey =
  | 'seq'
  | 'adaDate'
  | 'checkNo'
  | 'payee'
  | 'rciNet'
  | 'jevGross'
  | 'evidence'
  | 'attributes'
  | 'dvSig'
  | 'poToCoa'
  | 'poNoDate'
  | 'method'
  | 'philgeps'
  | 'prNoDate'
  | 'abstractDate'
  | 'rfq'
  | 'iar'
  | 'orRef'
  | 'toc'
  | 'jevNoDate'
  | 'acctCode'
  | 'acctTitle'
  | 'debit'
  | 'credit'
  | 'remarks'
  | 'audit';

type FreezeBoundary = LedgerColumnKey | 'none';

interface LedgerColumn {
  key: LedgerColumnKey;
  label: string;
  width: number;
}

interface FreezePrefs {
  boundary: FreezeBoundary;
  pinAudit: boolean;
}

const LEDGER_COLUMNS: LedgerColumn[] = [
  { key: 'seq', label: 'No.', width: 52 },
  { key: 'adaDate', label: 'ADA/Check Date', width: 104 },
  { key: 'checkNo', label: 'Check/ADA No', width: 144 },
  { key: 'payee', label: 'Payee', width: 168 },
  { key: 'rciNet', label: 'RCI Net', width: 108 },
  { key: 'jevGross', label: 'JEV Gross', width: 120 },
  { key: 'evidence', label: 'Evidence', width: 104 },
  { key: 'attributes', label: 'Attributes (1–7)', width: 232 },
  { key: 'dvSig', label: 'DV Sig.', width: 104 },
  { key: 'toc', label: 'Test of Controls', width: 200 },
  { key: 'jevNoDate', label: 'JEV No. & Date', width: 176 },
  { key: 'acctCode', label: 'Acct Code', width: 128 },
  { key: 'acctTitle', label: 'Account Title', width: 216 },
  { key: 'debit', label: 'Dr', width: 108 },
  { key: 'credit', label: 'Cr', width: 108 },
  { key: 'remarks', label: 'Reasons / Remarks', width: 200 },
  { key: 'audit', label: 'Audit', width: 112 },
];

/** Injected between DV Sig. and Test of Controls while the purchases toggle is on. */
const PROCUREMENT_COLUMNS: LedgerColumn[] = [
  { key: 'poToCoa', label: 'PO to COA', width: 104 },
  { key: 'poNoDate', label: 'PO No./Date', width: 124 },
  { key: 'method', label: 'Method', width: 128 },
  { key: 'philgeps', label: 'PhilGEPS/Date', width: 124 },
  { key: 'prNoDate', label: 'PR No./Date', width: 124 },
  { key: 'abstractDate', label: 'Abstract/Date', width: 124 },
  { key: 'rfq', label: 'RFQ (3)', width: 72 },
  { key: 'iar', label: 'IAR / Date', width: 124 },
  { key: 'orRef', label: 'OR / Invoice No.', width: 136 },
];

/** Only a leading block can be pinned — the same rule Excel enforces. */
const FREEZE_BOUNDARIES: LedgerColumn[] = LEDGER_COLUMNS.filter((col) => col.key !== 'audit');

const DEFAULT_FREEZE_BOUNDARY: FreezeBoundary = 'payee';
const FREEZE_STORAGE_KEY = 'rci.monthlyLedger.freeze';

const readFreezePrefs = (): FreezePrefs => {
  try {
    const raw = window.localStorage.getItem(FREEZE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FreezePrefs>;
      const boundary = parsed.boundary;
      const known =
        boundary === 'none' || FREEZE_BOUNDARIES.some((col) => col.key === boundary);
      return {
        boundary: known ? (boundary as FreezeBoundary) : DEFAULT_FREEZE_BOUNDARY,
        pinAudit: parsed.pinAudit !== false,
      };
    }
  } catch {
    // Unreadable or blocked storage is not fatal — fall back to the defaults.
  }
  return { boundary: DEFAULT_FREEZE_BOUNDARY, pinAudit: true };
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
  const [freezePrefs, setFreezePrefs] = useState<FreezePrefs>(readFreezePrefs);
  const [freezePanelOpen, setFreezePanelOpen] = useState(false);
  const freezePanelRef = useRef<HTMLDivElement | null>(null);

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
        renderSlashPair(tx.jevNo, tx.jevDate, tx.jevNoDate).toLowerCase().includes(q) ||
        (tx.remarks || '').toLowerCase().includes(q) ||
        (tx.cancellationReason || '').toLowerCase().includes(q)
      );
    });
  }, [transactions, selectedMonth, statusFilter, searchQuery]);

  const monthTotals = useMemo(() => summarizeLedgerTotals(monthRows), [monthRows]);
  const hasActiveFilters = statusFilter !== 'all' || searchQuery.trim().length > 0;
  const jevCoverage = useMemo(() => {
    const liveRows = monthRows.filter((tx) => !isCancelledTransaction(tx));
    const encoded = liveRows.filter((tx) => tx.journalLines.length > 0).length;
    return { encoded, total: liveRows.length };
  }, [monthRows]);
  const statusCounts = useMemo(() => {
    const monthTx = transactions.filter((tx) => tx.month === selectedMonth);
    return {
      all: monthTx.length,
      posted: monthTx.filter((tx) => tx.status === 'posted').length,
      lacking: monthTx.filter((tx) => tx.status === 'lacking').length,
      audited: monthTx.filter((tx) => tx.status === 'audited').length,
      draft: monthTx.filter((tx) => tx.status === 'draft').length,
      cancelled: monthTx.filter((tx) => isCancelledTransaction(tx)).length,
    };
  }, [transactions, selectedMonth]);

  // Freeze panes are expressed as "pin everything up to column X". The offset of
  // each pinned column is a running sum of the fixed widths before it, so the
  // block stays aligned no matter which column the user picks.
  const visibleColumns = useMemo(() => {
    if (!showPurchases) return LEDGER_COLUMNS;
    const tocIndex = LEDGER_COLUMNS.findIndex((col) => col.key === 'toc');
    return [
      ...LEDGER_COLUMNS.slice(0, tocIndex),
      ...PROCUREMENT_COLUMNS,
      ...LEDGER_COLUMNS.slice(tocIndex),
    ];
  }, [showPurchases]);

  const tableWidth = useMemo(
    () => visibleColumns.reduce((total, col) => total + col.width, 0),
    [visibleColumns],
  );

  const frozenZones = useMemo(() => {
    const zones = new Map<LedgerColumnKey, { left: number; width: number }>();
    if (freezePrefs.boundary === 'none') return zones;
    let offset = 0;
    for (const col of visibleColumns) {
      if (col.key === 'audit') break;
      zones.set(col.key, { left: offset, width: col.width });
      offset += col.width;
      if (col.key === freezePrefs.boundary) break;
    }
    return zones;
  }, [visibleColumns, freezePrefs.boundary]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FREEZE_STORAGE_KEY, JSON.stringify(freezePrefs));
    } catch {
      // Storage is optional; the preference still applies for this session.
    }
  }, [freezePrefs]);

  useEffect(() => {
    if (!freezePanelOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!freezePanelRef.current?.contains(event.target as Node)) setFreezePanelOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFreezePanelOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [freezePanelOpen]);

  const isFrozen = (key: LedgerColumnKey) => frozenZones.has(key);

  const freezeStyle = (key: LedgerColumnKey): React.CSSProperties | undefined => {
    const zone = frozenZones.get(key);
    return zone
      ? { left: zone.left, width: zone.width, minWidth: zone.width, maxWidth: zone.width }
      : undefined;
  };

  // Pinned header cells must paint their own background, otherwise the columns
  // scrolling underneath would show through.
  const freezeHeadCls = (key: LedgerColumnKey, surface = 'bg-slate-100') =>
    isFrozen(key) ? `sticky z-10 ${surface}` : '';

  // The last pinned column carries the divider that marks the freeze boundary.
  const edgeCls = (key: LedgerColumnKey) =>
    key === freezePrefs.boundary
      ? 'border-r-2 border-slate-300 shadow-[6px_0_8px_-8px_rgba(15,23,42,0.3)]'
      : 'border-r border-slate-200';

  const freezeLabel =
    freezePrefs.boundary === 'none'
      ? 'Freeze panes'
      : `Frozen: ${
          FREEZE_BOUNDARIES.find((col) => col.key === freezePrefs.boundary)?.label ?? ''
        }`;

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
                  <span
                    className={`ml-1 font-mono text-[10px] tabular-nums ${
                      active ? 'text-white/70' : 'text-slate-400'
                    }`}
                    title={`${count} ${count === 1 ? 'entry' : 'entries'} in ${m}`}
                  >
                    ({count})
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
          title={
            hasActiveFilters
              ? 'Exports only the rows visible with the current status filter and search'
              : `Exports all ${selectedMonth} transactions`
          }
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          <span>
            Export {selectedMonth}
            {hasActiveFilters ? ' (filtered)' : ''} .xlsx
          </span>
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
                <span>{st}</span>
                <span
                  className={`ml-1 font-mono text-[10px] tabular-nums ${
                    statusFilter === st ? 'text-slate-300' : 'text-slate-400'
                  }`}
                >
                  {statusCounts[st]}
                </span>
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

          <div className="relative" ref={freezePanelRef}>
            <button
              type="button"
              onClick={() => setFreezePanelOpen((open) => !open)}
              aria-expanded={freezePanelOpen}
              aria-haspopup="dialog"
              title="Choose which columns stay visible while you scroll right"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors cursor-pointer whitespace-nowrap ${
                freezePrefs.boundary === 'none'
                  ? 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                  : 'bg-slate-900 border-slate-900 text-white'
              }`}
            >
              <Pin className="w-3.5 h-3.5" />
              <span>{freezeLabel}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${freezePanelOpen ? 'rotate-180' : ''}`} />
            </button>

            {freezePanelOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-3 text-left shadow-xl">
                <p className="text-xs font-semibold text-slate-900">Freeze panes</p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                  Pick the last column that should stay visible while the ledger scrolls.
                </p>

                <label className="mt-3 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={freezePrefs.boundary !== 'none'}
                    onChange={(event) =>
                      setFreezePrefs((prev) => ({
                        ...prev,
                        boundary: event.target.checked
                          ? prev.boundary === 'none'
                            ? DEFAULT_FREEZE_BOUNDARY
                            : prev.boundary
                          : 'none',
                      }))
                    }
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  Freeze columns
                </label>

                <label className="mt-2 block">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    Freeze up to
                  </span>
                  <select
                    value={
                      freezePrefs.boundary === 'none'
                        ? DEFAULT_FREEZE_BOUNDARY
                        : freezePrefs.boundary
                    }
                    disabled={freezePrefs.boundary === 'none'}
                    onChange={(event) =>
                      setFreezePrefs((prev) => ({
                        ...prev,
                        boundary: event.target.value as LedgerColumnKey,
                      }))
                    }
                    className="mt-1 w-full h-7 px-1.5 text-xs bg-white border border-slate-200 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {FREEZE_BOUNDARIES.map((col, index) => (
                      <option key={col.key} value={col.key}>
                        {col.label} ({index + 1} column{index === 0 ? '' : 's'})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={freezePrefs.pinAudit}
                    onChange={(event) =>
                      setFreezePrefs((prev) => ({ ...prev, pinAudit: event.target.checked }))
                    }
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  Pin audit actions to the right
                </label>

                <p className="mt-2 border-t border-slate-100 pt-2 text-[10px] leading-snug text-slate-400">
                  Only a leading block can be pinned — the same rule Excel uses, because isolated
                  frozen columns would leave gaps while scrolling.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden lg:flex items-center gap-2 text-xs font-mono tabular-nums text-slate-600">
            <span>
              JEV Gross: ₱{formatPeso(monthTotals.gross)}
              <span className="ml-1 text-[10px] text-slate-500">
                ({jevCoverage.encoded}/{jevCoverage.total} encoded)
              </span>
            </span>
            <span aria-hidden="true">·</span>
            <span>Tax: ₱{formatPeso(monthTotals.tax)}</span>
            <span aria-hidden="true">·</span>
            <span className="text-slate-900 font-semibold">RCI Net: ₱{formatPeso(monthTotals.net)}</span>
            {monthTotals.cancelledCount > 0 && (
              <span
                className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                title={`${monthTotals.cancelledCount} cancelled row(s) are excluded from totals`}
              >
                Cancelled: {monthTotals.cancelledCount}
                {monthTotals.cancelledNet > 0.01
                  ? ` · ₱${formatPeso(monthTotals.cancelledNet)} excluded`
                  : ''}
              </span>
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
          <table
            className="table-fixed border-collapse text-left text-xs"
            style={{ width: tableWidth }}
          >
            <colgroup>
              {visibleColumns.map((col) => (
                <col key={col.key} style={{ width: col.width }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 bg-slate-100 border-b border-slate-300 z-30 text-[11px] font-semibold text-slate-700">
              <tr>
                <th
                  style={freezeStyle('seq')}
                  className={`${freezeHeadCls('seq')} ${edgeCls('seq')} py-2 px-2.5`}
                >
                  No.
                </th>
                <th
                  style={freezeStyle('adaDate')}
                  className={`${freezeHeadCls('adaDate')} ${edgeCls('adaDate')} py-2 px-2.5`}
                >
                  ADA/Check Date
                </th>
                <th
                  style={freezeStyle('checkNo')}
                  className={`${freezeHeadCls('checkNo')} ${edgeCls('checkNo')} py-2 px-2.5 whitespace-nowrap`}
                >
                  Check/ADA No
                </th>
                <th
                  style={freezeStyle('payee')}
                  className={`${freezeHeadCls('payee')} ${edgeCls('payee')} py-2 px-2.5`}
                >
                  Payee
                </th>
                <th
                  style={freezeStyle('rciNet')}
                  className={`${freezeHeadCls('rciNet')} ${edgeCls('rciNet')} py-2 px-2.5 text-right`}
                >
                  RCI Net (₱)
                </th>
                <th
                  style={freezeStyle('jevGross')}
                  className={`${freezeHeadCls('jevGross')} ${edgeCls('jevGross')} py-2 px-2.5 text-right`}
                >
                  JEV Gross (₱)
                </th>
                <th
                  style={freezeStyle('evidence')}
                  className={`${freezeHeadCls('evidence')} ${edgeCls('evidence')} py-2 px-2.5 text-center`}
                >
                  Evidence
                </th>
                <th
                  style={freezeStyle('attributes')}
                  className={`${freezeHeadCls('attributes')} ${edgeCls('attributes')} py-2 px-2.5 text-center cursor-help`}
                  title={AUDIT_ATTRIBUTE_LABELS.map((attr) => `${attr.num}. ${attr.label}`).join('\n')}
                >
                  Attributes (1–7 · ELAS){' '}
                  <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-slate-300 align-middle text-[9px] font-normal leading-none text-slate-500">
                    ?
                  </span>
                </th>
                <th
                  style={freezeStyle('dvSig')}
                  className={`${freezeHeadCls('dvSig')} ${edgeCls('dvSig')} py-2 px-2.5 text-center`}
                >
                  DV Sig. ({DV_SIGNATORY_LABELS.map((sig) => sig.letter).join('·')})
                </th>
                {showPurchases && (
                  <>
                    <th
                      style={freezeStyle('poToCoa')}
                      className={`${freezeHeadCls('poToCoa', 'bg-amber-50')} ${edgeCls('poToCoa')} bg-amber-50 py-2 px-2 text-amber-900 whitespace-nowrap`}
                    >
                      PO to COA
                    </th>
                    <th
                      style={freezeStyle('poNoDate')}
                      className={`${freezeHeadCls('poNoDate', 'bg-amber-50')} ${edgeCls('poNoDate')} bg-amber-50 py-2 px-2 text-amber-900 whitespace-nowrap`}
                    >
                      PO No./Date
                    </th>
                    <th
                      style={freezeStyle('method')}
                      className={`${freezeHeadCls('method', 'bg-amber-50')} ${edgeCls('method')} bg-amber-50 py-2 px-2 text-amber-900 whitespace-nowrap`}
                    >
                      Method
                    </th>
                    <th
                      style={freezeStyle('philgeps')}
                      className={`${freezeHeadCls('philgeps', 'bg-amber-50')} ${edgeCls('philgeps')} bg-amber-50 py-2 px-2 text-amber-900 whitespace-nowrap`}
                    >
                      PhilGEPS/Date
                    </th>
                    <th
                      style={freezeStyle('prNoDate')}
                      className={`${freezeHeadCls('prNoDate', 'bg-amber-50')} ${edgeCls('prNoDate')} bg-amber-50 py-2 px-2 text-amber-900 whitespace-nowrap`}
                    >
                      PR No./Date
                    </th>
                    <th
                      style={freezeStyle('abstractDate')}
                      className={`${freezeHeadCls('abstractDate', 'bg-amber-50')} ${edgeCls('abstractDate')} bg-amber-50 py-2 px-2 text-amber-900 whitespace-nowrap`}
                    >
                      Abstract/Date
                    </th>
                    <th
                      style={freezeStyle('rfq')}
                      className={`${freezeHeadCls('rfq', 'bg-amber-50')} ${edgeCls('rfq')} bg-amber-50 py-2 px-2 text-center text-amber-900 whitespace-nowrap`}
                    >
                      RFQ (3)
                    </th>
                    <th
                      style={freezeStyle('iar')}
                      className={`${freezeHeadCls('iar', 'bg-amber-50')} ${edgeCls('iar')} bg-amber-50 py-2 px-2 text-amber-900 whitespace-nowrap`}
                    >
                      IAR / Date
                    </th>
                    <th
                      style={freezeStyle('orRef')}
                      className={`${freezeHeadCls('orRef', 'bg-amber-50')} ${edgeCls('orRef')} bg-amber-50 py-2 px-2 text-amber-900 whitespace-nowrap`}
                    >
                      OR / Invoice No.
                    </th>
                  </>
                )}
                <th
                  style={freezeStyle('toc')}
                  className={`${freezeHeadCls('toc')} ${edgeCls('toc')} py-2 px-2.5`}
                >
                  Test of Controls
                </th>
                <th
                  style={freezeStyle('jevNoDate')}
                  className={`${freezeHeadCls('jevNoDate')} ${edgeCls('jevNoDate')} py-2 px-2.5`}
                >
                  JEV No. &amp; Date
                </th>
                <th
                  style={freezeStyle('acctCode')}
                  className={`${freezeHeadCls('acctCode')} ${edgeCls('acctCode')} py-2 px-2.5 whitespace-nowrap`}
                >
                  Acct Code
                </th>
                <th
                  style={freezeStyle('acctTitle')}
                  className={`${freezeHeadCls('acctTitle')} ${edgeCls('acctTitle')} py-2 px-2.5`}
                >
                  Account Title
                </th>
                <th
                  style={freezeStyle('debit')}
                  className={`${freezeHeadCls('debit')} ${edgeCls('debit')} py-2 px-2.5 text-right`}
                >
                  Dr (₱)
                </th>
                <th
                  style={freezeStyle('credit')}
                  className={`${freezeHeadCls('credit')} ${edgeCls('credit')} py-2 px-2.5 text-right`}
                >
                  Cr (₱)
                </th>
                <th
                  style={freezeStyle('remarks')}
                  className={`${freezeHeadCls('remarks')} ${edgeCls('remarks')} py-2 px-2.5`}
                >
                  Reasons / Remarks
                </th>
                <th
                  style={freezePrefs.pinAudit ? { right: 0 } : undefined}
                  className={`${
                    freezePrefs.pinAudit
                      ? 'sticky z-10 bg-slate-100 border-l-2 border-slate-300 shadow-[-6px_0_8px_-8px_rgba(15,23,42,0.3)]'
                      : ''
                  } py-2 px-2.5 text-right`}
                >
                  Audit
                </th>
              </tr>
            </thead>
            <tbody>
              {monthRows.map((tx, txIdx) => {
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
                const jevPair = readPair(tx.jevNo, tx.jevDate, tx.jevNoDate);

                return lines.map((line, lineIdx) => {
                  const isFirst = lineIdx === 0;
                  const isLast = lineIdx === lines.length - 1;
                  const rowSpan = lines.length;
                  const borderBottom = isLast ? 'border-b-[3px] border-slate-300' : 'border-b border-slate-100';
                  // Opaque tints only — pinned cells paint over the scrolling ones.
                  const voucherTint = txIdx % 2 === 1 ? 'bg-slate-50' : 'bg-white';
                  const freezeBodyCls = (key: LedgerColumnKey, surface?: string) =>
                    isFrozen(key)
                      ? `sticky z-20 ${surface ?? `${voucherTint} group-hover/row:bg-slate-100`}`
                      : '';

                  return (
                    <tr
                      key={`${tx.id}-${lineIdx}`}
                      className={`group/row ${borderBottom} ${voucherTint} hover:bg-slate-100`}
                    >
                      {isFirst && (
                        <>
                          <td
                            rowSpan={rowSpan}
                            style={freezeStyle('seq')}
                            className={`${freezeBodyCls('seq')} ${edgeCls('seq')} py-2 px-2.5 align-top font-mono tabular-nums text-slate-500`}
                          >
                            {tx.sequenceNo}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            style={freezeStyle('adaDate')}
                            className={`${freezeBodyCls('adaDate')} ${edgeCls('adaDate')} py-2 px-2.5 align-top font-mono tabular-nums text-slate-700 whitespace-nowrap`}
                          >
                            {formatLedgerDate(tx.adaCheckDate)}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            style={freezeStyle('checkNo')}
                            className={`${freezeBodyCls('checkNo')} ${edgeCls('checkNo')} py-2 px-2.5 align-top font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap`}
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
                            style={freezeStyle('payee')}
                            className={`${freezeBodyCls('payee')} ${edgeCls('payee')} py-2 px-2.5 align-top text-slate-900 font-medium`}
                          >
                            <div className="truncate" title={tx.payeeName || 'No payee recorded'}>
                              {tx.payeeName || <span className="text-slate-400">—</span>}
                            </div>
                            <div className="truncate text-[11px] font-normal text-slate-500 mt-0.5">
                              {tx.dvNo}
                            </div>
                          </td>
                          <td
                            rowSpan={rowSpan}
                            style={freezeStyle('rciNet')}
                            className={`${freezeBodyCls('rciNet')} ${edgeCls('rciNet')} py-2 px-2.5 align-top text-right font-mono tabular-nums font-semibold text-emerald-800 whitespace-nowrap`}
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
                            style={freezeStyle('jevGross')}
                            className={`${freezeBodyCls('jevGross')} ${edgeCls('jevGross')} py-2 px-2.5 align-top text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap`}
                          >
                            {jevExempt && !hasJevLines ? (
                              <span
                                className="text-[11px] font-sans font-normal text-slate-400"
                                title="Cancelled check — no JEV entry will be encoded"
                              >
                                —
                              </span>
                            ) : isPendingJev ? (
                              <span
                                className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1 py-0.5 text-[10px] font-sans font-medium text-amber-800"
                                title="JEV not yet encoded for this voucher"
                              >
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
                            style={freezeStyle('evidence')}
                            className={`${freezeBodyCls('evidence')} ${edgeCls('evidence')} py-2 px-2 align-top text-center`}
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
                                  className="w-full max-w-[88px] h-7 px-1 text-[10px] border border-rose-200 rounded bg-white text-slate-700"
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
                            style={freezeStyle('attributes')}
                            className={`${freezeBodyCls('attributes')} ${edgeCls('attributes')} py-2 px-2 align-top`}
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
                            style={freezeStyle('dvSig')}
                            className={`${freezeBodyCls('dvSig')} ${edgeCls('dvSig')} py-2 px-2 align-top`}
                          >
                            <div className="grid grid-cols-3 gap-0.5 w-full">
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
                                style={freezeStyle('poToCoa')}
                                className={`${freezeBodyCls('poToCoa', 'bg-amber-50 group-hover/row:bg-amber-100')} ${edgeCls('poToCoa')} bg-amber-50 py-2 px-2 align-top font-mono text-[11px] text-slate-700 whitespace-nowrap`}
                              >
                                {tx.procurement?.poSubmittedToCoaDate || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                style={freezeStyle('poNoDate')}
                                className={`${freezeBodyCls('poNoDate', 'bg-amber-50 group-hover/row:bg-amber-100')} ${edgeCls('poNoDate')} bg-amber-50 py-2 px-2 align-top text-slate-700 whitespace-nowrap`}
                              >
                                {renderSlashPair(
                                  tx.procurement?.poNo,
                                  tx.procurement?.poDate,
                                  tx.procurement?.poNoDate,
                                ) || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                style={freezeStyle('method')}
                                className={`${freezeBodyCls('method', 'bg-amber-50 group-hover/row:bg-amber-100')} ${edgeCls('method')} bg-amber-50 py-2 px-2 align-top text-slate-700`}
                              >
                                {tx.procurement?.procurementMethod || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                style={freezeStyle('philgeps')}
                                className={`${freezeBodyCls('philgeps', 'bg-amber-50 group-hover/row:bg-amber-100')} ${edgeCls('philgeps')} bg-amber-50 py-2 px-2 align-top font-mono text-[11px] text-slate-700 whitespace-nowrap`}
                              >
                                {tx.procurement?.philgepsDate || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                style={freezeStyle('prNoDate')}
                                className={`${freezeBodyCls('prNoDate', 'bg-amber-50 group-hover/row:bg-amber-100')} ${edgeCls('prNoDate')} bg-amber-50 py-2 px-2 align-top font-mono text-[11px] text-slate-700 whitespace-nowrap`}
                              >
                                {renderSlashPair(
                                  tx.procurement?.prNo,
                                  tx.procurement?.prDate,
                                  tx.procurement?.prNoDate,
                                ) || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                style={freezeStyle('abstractDate')}
                                className={`${freezeBodyCls('abstractDate', 'bg-amber-50 group-hover/row:bg-amber-100')} ${edgeCls('abstractDate')} bg-amber-50 py-2 px-2 align-top font-mono text-[11px] text-slate-700 whitespace-nowrap`}
                              >
                                {tx.procurement?.abstractDate || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                style={freezeStyle('rfq')}
                                className={`${freezeBodyCls('rfq', 'bg-amber-50 group-hover/row:bg-amber-100')} ${edgeCls('rfq')} bg-amber-50 py-2 px-2 align-top text-center font-mono text-[11px] whitespace-nowrap`}
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
                                style={freezeStyle('iar')}
                                className={`${freezeBodyCls('iar', 'bg-amber-50 group-hover/row:bg-amber-100')} ${edgeCls('iar')} bg-amber-50 py-2 px-2 align-top font-mono text-[11px] text-slate-700 whitespace-nowrap`}
                              >
                                {renderSlashPair(
                                  tx.procurement?.iarNo,
                                  tx.procurement?.iarDate,
                                  undefined,
                                ) || '—'}
                              </td>
                              <td
                                rowSpan={rowSpan}
                                style={freezeStyle('orRef')}
                                className={`${freezeBodyCls('orRef', 'bg-amber-50 group-hover/row:bg-amber-100')} ${edgeCls('orRef')} bg-amber-50 py-2 px-2 align-top font-mono text-[11px] text-slate-700 whitespace-nowrap`}
                              >
                                {tx.procurement?.orInvoiceRef || renderSlashPair(tx.orNo, tx.orDate, tx.orNoDate) || '—'}
                              </td>
                            </>
                          )}
                          <td
                            rowSpan={rowSpan}
                            style={freezeStyle('toc')}
                            className={`${freezeBodyCls('toc')} ${edgeCls('toc')} py-2 px-2 align-top`}
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
                            style={freezeStyle('jevNoDate')}
                            className={`${freezeBodyCls('jevNoDate')} ${edgeCls('jevNoDate')} py-2 px-2.5 align-top font-mono tabular-nums text-[11px] text-slate-700`}
                            title={renderSlashPair(tx.jevNo, tx.jevDate, tx.jevNoDate) || undefined}
                          >
                            {jevPair.left || jevPair.right ? (
                              <>
                                <span className="block whitespace-nowrap">{jevPair.left || '—'}</span>
                                {jevPair.right && (
                                  <span className="block whitespace-nowrap text-[10px] text-slate-500">
                                    {formatLedgerDate(jevPair.right)}
                                  </span>
                                )}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                        </>
                      )}

                      <td
                        style={freezeStyle('acctCode')}
                        className={`${freezeBodyCls('acctCode')} ${edgeCls('acctCode')} py-1.5 px-2.5 font-mono tabular-nums text-[11px] text-slate-600 whitespace-nowrap`}
                      >
                        {line.accountCode}
                      </td>
                      <td
                        style={freezeStyle('acctTitle')}
                        className={`${freezeBodyCls('acctTitle')} ${edgeCls('acctTitle')} py-1.5 px-2.5 text-slate-900`}
                      >
                        <div className="truncate" title={line.accountTitle}>
                          {line.accountTitle}
                        </div>
                      </td>
                      <td
                        style={freezeStyle('debit')}
                        className={`${freezeBodyCls('debit')} ${edgeCls('debit')} py-1.5 px-2.5 text-right font-mono tabular-nums text-slate-900`}
                      >
                        {line.debit > 0 ? formatPeso(line.debit) : ''}
                      </td>
                      <td
                        style={freezeStyle('credit')}
                        className={`${freezeBodyCls('credit')} ${edgeCls('credit')} py-1.5 px-2.5 text-right font-mono tabular-nums text-slate-900`}
                      >
                        {line.credit > 0 ? formatPeso(line.credit) : ''}
                      </td>

                      {isFirst && (
                        <>
                          <td
                            rowSpan={rowSpan}
                            style={freezeStyle('remarks')}
                            className={`${freezeBodyCls('remarks')} ${edgeCls('remarks')} py-2 px-2.5 align-top`}
                          >
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
                              <button
                                type="button"
                                onClick={() => {
                                  if (tx.status === 'audited' && !canAudit) return;
                                  setEditingRemarksId(tx.id);
                                  setRemarksDraft(tx.remarks || '');
                                }}
                                title={tx.remarks || 'Click to add remarks'}
                                className="group w-full max-w-[180px] rounded text-left text-slate-700 whitespace-pre-line line-clamp-2 cursor-pointer hover:bg-slate-50 hover:text-slate-950 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                              >
                                {tx.remarks || (
                                  <span className="inline-flex items-center gap-1 text-slate-400 group-hover:text-slate-600">
                                    <Pencil className="h-3 w-3" />
                                    Add remark...
                                  </span>
                                )}
                              </button>
                            )}
                          </td>
                          <td
                            rowSpan={rowSpan}
                            style={freezePrefs.pinAudit ? { right: 0 } : undefined}
                            className={`${
                              freezePrefs.pinAudit
                                ? `sticky z-20 border-l-2 border-slate-300 shadow-[-6px_0_8px_-8px_rgba(15,23,42,0.3)] ${voucherTint} group-hover/row:bg-slate-100`
                                : ''
                            } py-2 px-2.5 align-top text-right whitespace-nowrap`}
                          >
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
                                        ? 'Math ✓'
                                        : tx.mathStatus === 'discrepancy'
                                          ? 'Math ✕'
                                          : tx.mathStatus === 'manual_review'
                                            ? 'Math !'
                                            : 'Math –'}
                                      {tx.taxStatus === 'verified'
                                        ? ' · Tax ✓'
                                        : tx.taxStatus === 'variance'
                                          ? ' · Tax ✕'
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
                                  aria-label="Open in Rapid Entry"
                                  className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                {canAudit && (
                                  <button
                                    type="button"
                                    onClick={() => void handleMarkAudited(tx)}
                                    title={tx.status === 'audited' ? 'Unlock Audited Entry' : 'Sign off as Audited'}
                                    aria-label={tx.status === 'audited' ? 'Unlock audited entry' : 'Sign off as audited'}
                                    className={`p-1.5 rounded cursor-pointer ${
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
