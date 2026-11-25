import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  FileWarning,
  Pencil,
  XCircle,
} from 'lucide-react';
import { useAuthWorkspace } from '../contexts/AuthWorkspaceContext';
import {
  deriveClerkReviewStatus,
  formatPeso,
  getDisplayRciNetAmount,
  isLegacyTransaction,
  normalizeAttributeState,
} from '../lib/taxAndLedger';
import {
  AUDIT_ATTRIBUTE_LABELS,
  type AuditAttributesMap,
  type TransactionRecord,
} from '../types/rci';

interface LackingQueueViewProps {
  onEditInRapidEntry: (tx: TransactionRecord) => void;
}

type QueueTab = 'all' | 'exclamation' | 'wrong' | 'reconciliation' | 'integrity';

interface CategorizedException {
  tx: TransactionRecord;
  exclamationAttrs: typeof AUDIT_ATTRIBUTE_LABELS;
  wrongAttrs: typeof AUDIT_ATTRIBUTE_LABELS;
  isDup: boolean;
  isUnbalanced: boolean;
  hasUnder3Rfq: boolean;
  hasMathDiscrepancy: boolean;
  hasTaxVariance: boolean;
}

export const LackingQueueView: React.FC<LackingQueueViewProps> = ({ onEditInRapidEntry }) => {
  const { transactions, updateTransaction } = useAuthWorkspace();
  const [activeTab, setActiveTab] = useState<QueueTab>('all');
  const [resolvingTx, setResolvingTx] = useState<TransactionRecord | null>(null);
  const [remarkText, setRemarkText] = useState('');

  // Find duplicate check numbers across workspace
  const duplicateChecks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tx of transactions) {
      const k = tx.adaCheckNo.trim();
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    return counts;
  }, [transactions]);

  const categorizedItems = useMemo<CategorizedException[]>(() => {
    const items: CategorizedException[] = [];
    for (const tx of transactions) {
      const legacy = isLegacyTransaction(tx);
      const exclamationAttrs = AUDIT_ATTRIBUTE_LABELS.filter(
        (a) => normalizeAttributeState(tx.attributes[a.key]) === 'exclamation',
      );
      const wrongAttrs = AUDIT_ATTRIBUTE_LABELS.filter(
        (a) => normalizeAttributeState(tx.attributes[a.key]) === 'wrong',
      );
      const isDup = (duplicateChecks.get(tx.adaCheckNo.trim()) || 0) > 1;
      const isUnbalanced = tx.journalLines.length > 0 && !tx.isBalanced;
      const hasUnder3Rfq = tx.procurement?.rfqStatus === 'under3';
      const hasMathDiscrepancy =
        !legacy && (tx.mathStatus === 'discrepancy' || tx.mathStatus === 'manual_review');
      const hasTaxVariance =
        !legacy &&
        (tx.taxStatus === 'variance' ||
          tx.taxStatus === 'manual_review' ||
          tx.taxStatus === 'incomplete_evidence');

      if (
        tx.status === 'lacking' ||
        exclamationAttrs.length > 0 ||
        wrongAttrs.length > 0 ||
        isDup ||
        isUnbalanced ||
        hasMathDiscrepancy ||
        hasTaxVariance
      ) {
        items.push({
          tx,
          exclamationAttrs,
          wrongAttrs,
          isDup,
          isUnbalanced,
          hasUnder3Rfq,
          hasMathDiscrepancy,
          hasTaxVariance,
        });
      }
    }
    return items;
  }, [transactions, duplicateChecks]);

  const tabCounts = useMemo(() => {
    let exclamation = 0;
    let wrong = 0;
    let reconciliation = 0;
    let integrity = 0;
    for (const item of categorizedItems) {
      if (item.exclamationAttrs.length > 0) exclamation += 1;
      if (item.wrongAttrs.length > 0) wrong += 1;
      if (item.hasMathDiscrepancy || item.hasTaxVariance) reconciliation += 1;
      if (item.isDup || item.isUnbalanced) integrity += 1;
    }
    return {
      all: categorizedItems.length,
      exclamation,
      wrong,
      reconciliation,
      integrity,
    };
  }, [categorizedItems]);

  const filteredItems = useMemo(() => {
    if (activeTab === 'all') return categorizedItems;
    if (activeTab === 'exclamation') {
      return categorizedItems.filter((item) => item.exclamationAttrs.length > 0);
    }
    if (activeTab === 'wrong') {
      return categorizedItems.filter((item) => item.wrongAttrs.length > 0);
    }
    if (activeTab === 'reconciliation') {
      return categorizedItems.filter(
        (item) => item.hasMathDiscrepancy || item.hasTaxVariance,
      );
    }
    return categorizedItems.filter((item) => item.isDup || item.isUnbalanced);
  }, [categorizedItems, activeTab]);

  const handleResolveComplete = async (tx: TransactionRecord, nextRemark?: string) => {
    const nextAttributes: AuditAttributesMap = { ...tx.attributes };
    for (const { key } of AUDIT_ATTRIBUTE_LABELS) {
      const norm = normalizeAttributeState(nextAttributes[key]);
      nextAttributes[key] = norm === 'na' ? 'na' : 'ok';
    }
    const nextStatus = tx.isBalanced ? 'posted' : 'draft';

    if (isLegacyTransaction(tx)) {
      await updateTransaction(tx.id, {
        attributes: nextAttributes,
        remarks: nextRemark !== undefined ? nextRemark : tx.remarks || 'complete',
        status: nextStatus,
      });
    } else {
      await updateTransaction(tx.id, {
        attributes: nextAttributes,
        remarks: nextRemark !== undefined ? nextRemark : tx.remarks || 'complete',
        status: nextStatus,
        clerkReviewStatus: deriveClerkReviewStatus(nextStatus, nextAttributes),
      });
    }
    setResolvingTx(null);
  };

  const tabs: Array<{ id: QueueTab; label: string; count: number; accentClass: string }> = [
    {
      id: 'all',
      label: 'All Exceptions',
      count: tabCounts.all,
      accentClass: 'text-slate-900',
    },
    {
      id: 'reconciliation',
      label: 'RCI / Tax Discrepancies',
      count: tabCounts.reconciliation,
      accentClass: 'text-red-700',
    },
    {
      id: 'exclamation',
      label: 'Control Breakdown (!)',
      count: tabCounts.exclamation,
      accentClass: 'text-amber-700',
    },
    {
      id: 'wrong',
      label: 'For Verification (✕)',
      count: tabCounts.wrong,
      accentClass: 'text-red-700',
    },
    {
      id: 'integrity',
      label: 'Check / Balance Issues',
      count: tabCounts.integrity,
      accentClass: 'text-red-700',
    },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="bg-white border-b border-slate-200 px-6 pt-4 pb-0 shrink-0">
        <div className="flex items-center justify-between gap-4 pb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 font-display">
              Lacking &amp; Audit Exceptions Queue
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Vouchers with RCI-vs-JEV discrepancies (v2), tax verification exceptions, Control Breakdown (!), For Verification (✕), or duplicate Check/ADA serials.
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums text-red-600 font-semibold whitespace-nowrap shrink-0">
            {categorizedItems.length} requiring attention
          </div>
        </div>

        {/* Segmented Filter Tabs */}
        <div className="flex items-center gap-1 overflow-x-auto -mb-px">
          {tabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'border-slate-900 text-slate-900 bg-slate-50/70'
                    : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-50/50'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`font-mono tabular-nums text-[11px] font-semibold ${
                    tab.count > 0 ? tab.accentClass : 'text-slate-400'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {filteredItems.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-lg p-10 text-center max-w-md mx-auto mt-10">
            <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-900">
              {categorizedItems.length === 0
                ? 'Zero Lacking Vouchers'
                : 'No Exceptions in This Filter'}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {categorizedItems.length === 0
                ? 'All posted entries have clear audit attributes, unique check numbers, and reconciled amounts.'
                : 'Switch filter tabs above to inspect other exception categories.'}
            </p>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-100 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                <tr>
                  <th className="py-2.5 px-3">Month / Seq</th>
                  <th className="py-2.5 px-3">Check / DV</th>
                  <th className="py-2.5 px-3">Payee</th>
                  <th className="py-2.5 px-3 text-right">RCI Net / JEV Gross</th>
                  <th className="py-2.5 px-3">Detected Exceptions</th>
                  <th className="py-2.5 px-3">Remarks</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredItems.map(
                  ({
                    tx,
                    exclamationAttrs,
                    wrongAttrs,
                    isDup,
                    isUnbalanced,
                    hasUnder3Rfq,
                    hasMathDiscrepancy,
                    hasTaxVariance,
                  }) => (
                    <tr key={tx.id} className="hover:bg-slate-50">
                      <td className="py-3 px-3 align-top whitespace-nowrap">
                        <span className="font-medium text-slate-900">{tx.month}</span>
                        <span className="text-slate-400 mx-1">·</span>
                        <span className="font-mono text-slate-600">#{tx.sequenceNo}</span>
                      </td>
                      <td className="py-3 px-3 align-top font-mono tabular-nums whitespace-nowrap">
                        <div className={isDup ? 'text-red-600 font-bold' : 'text-slate-900'}>
                          {tx.adaCheckNo}
                        </div>
                        <div className="text-[11px] text-slate-500">{tx.dvNo}</div>
                      </td>
                      <td className="py-3 px-3 align-top font-medium text-slate-900 max-w-[180px]">
                        {tx.payeeName}
                      </td>
                      <td className="py-3 px-3 align-top text-right font-mono tabular-nums whitespace-nowrap">
                        <div className="font-semibold text-emerald-800">
                          RCI ₱{formatPeso(getDisplayRciNetAmount(tx))}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {tx.journalLines.length === 0 && tx.grossAmount === 0
                            ? 'Pending JEV'
                            : `JEV ₱${formatPeso(tx.grossAmount)}`}
                        </div>
                      </td>
                      <td className="py-3 px-3 align-top space-y-1.5 min-w-[260px]">
                        {hasMathDiscrepancy && (
                          <div className="flex items-center gap-1.5 text-red-700 font-medium">
                            <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
                            <span>
                              RCI-vs-JEV Math:{' '}
                              {tx.mathStatus === 'manual_review'
                                ? 'Manual Review Required'
                                : 'Discrepancy Detected'}
                            </span>
                          </div>
                        )}
                        {hasTaxVariance && (
                          <div className="flex items-center gap-1.5 text-amber-800 font-medium">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                            <span>
                              Tax Verification:{' '}
                              {tx.taxStatus === 'variance'
                                ? 'Withholding Variance'
                                : tx.taxStatus === 'incomplete_evidence'
                                  ? 'Incomplete Evidence'
                                  : 'Manual Review Required'}
                            </span>
                          </div>
                        )}
                        {exclamationAttrs.map((attr) => (
                          <div key={attr.key} className="flex items-start gap-1.5 text-amber-800">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                            <span>
                              <strong className="font-semibold">! Control Breakdown</strong>
                              <span className="text-slate-400 mx-1">·</span>
                              <span>
                                ({attr.num}) {attr.label}
                              </span>
                            </span>
                          </div>
                        ))}
                        {wrongAttrs.map((attr) => (
                          <div key={attr.key} className="flex items-start gap-1.5 text-red-700">
                            <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0 mt-0.5" />
                            <span>
                              <strong className="font-semibold">✕ For Verification</strong>
                              <span className="text-slate-400 mx-1">·</span>
                              <span>
                                ({attr.num}) {attr.label}
                              </span>
                            </span>
                          </div>
                        ))}
                        {isDup && (
                          <div className="flex items-center gap-1.5 text-red-700 font-medium">
                            <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
                            <span>Duplicate Serial/Check No.</span>
                          </div>
                        )}
                        {isUnbalanced && (
                          <div className="flex items-center gap-1.5 text-red-700 font-medium">
                            <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
                            <span>Unbalanced Journal Entry</span>
                          </div>
                        )}
                        {hasUnder3Rfq && (
                          <div className="flex items-center gap-1.5 text-slate-600">
                            <FileWarning className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                            <span>RFQ (3): Only 1–2 quotations attached (exports blank)</span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 align-top text-slate-600 max-w-[240px] whitespace-pre-line">
                        {tx.remarks || '—'}
                      </td>
                      <td className="py-3 px-3 align-top text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setResolvingTx(tx);
                              setRemarkText(tx.remarks || 'complete');
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-emerald-600 text-white rounded hover:bg-emerald-700 cursor-pointer whitespace-nowrap shrink-0"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Resolve</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onEditInRapidEntry(tx)}
                            title="Edit in Rapid Entry"
                            className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {resolvingTx && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full p-5">
            <h3 className="text-sm font-semibold text-slate-900 font-display">
              Mark Check #{resolvingTx.adaCheckNo} Complete
            </h3>
            <p className="text-xs text-slate-500 mt-1 mb-3">
              Confirm supporting documents or verification items are resolved. All{' '}
              <strong className="text-amber-700">!</strong> and{' '}
              <strong className="text-red-700">✕</strong> flags will be set to{' '}
              <strong className="text-emerald-700">✓</strong> (any <strong>N/A</strong> states are preserved).
            </p>
            <textarea
              rows={3}
              value={remarkText}
              onChange={(e) => setRemarkText(e.target.value)}
              className="w-full p-2 text-xs border border-slate-200 rounded bg-slate-50 mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResolvingTx(null)}
                className="px-3 py-1.5 text-xs text-slate-700 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleResolveComplete(resolvingTx, remarkText)}
                className="px-4 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded hover:bg-emerald-700 cursor-pointer"
              >
                Clear Flags &amp; Post
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
