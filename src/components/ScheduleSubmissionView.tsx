import React, { useMemo, useState } from 'react';
import { CalendarCheck2, Check, Download } from 'lucide-react';
import { useAuthWorkspace } from '../contexts/AuthWorkspaceContext';
import { exportWorkingPaperWorkbook } from '../lib/excelExport';
import {
  formatPeso,
  getDisplayRciNetAmount,
  isJevExempt,
  isJevPending,
  NO_JEV_CANCELLED_LABEL,
} from '../lib/taxAndLedger';
import { MONTHS } from '../types/rci';

export const ScheduleSubmissionView: React.FC = () => {
  const { activeWorkspace, transactions, selectedMonth, setSelectedMonth, updateTransaction } =
    useAuthWorkspace();

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submissionDate, setSubmissionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  const monthRows = useMemo(
    () => transactions.filter((t) => t.month === selectedMonth && t.status !== 'draft'),
    [transactions, selectedMonth],
  );

  const submittedCount = useMemo(
    () => monthRows.filter((t) => Boolean(t.submittedToCoaDate)).length,
    [monthRows],
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAll = () => {
    if (selectedIds.length === monthRows.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(monthRows.map((t) => t.id));
    }
  };

  const handleBatchAssignSubmission = async () => {
    if (selectedIds.length === 0 || !submissionDate) return;
    setSaving(true);
    try {
      for (const id of selectedIds) {
        await updateTransaction(id, { submittedToCoaDate: submissionDate });
      }
      setSelectedIds([]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900 font-display">
            Schedule of COA Submission
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Track voucher transmittal dates to COA, JEV continuity, and generate formatted Excel packages.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedMonth}
            onChange={(e) => {
              setSelectedMonth(e.target.value as (typeof MONTHS)[number]);
              setSelectedIds([]);
            }}
            className="h-8 px-2.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded"
          >
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() =>
              exportWorkingPaperWorkbook(activeWorkspace?.name || 'RCI_Ledger', selectedMonth, monthRows)
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 text-slate-700 rounded hover:bg-slate-50 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Transmittal .xlsx</span>
          </button>
        </div>
      </div>

      {/* Batch Action Strip */}
      <div className="bg-slate-50 border-b border-slate-200 px-6 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-slate-600 font-mono tabular-nums">
          <span>
            Submitted: <strong className="text-emerald-700">{submittedCount}</strong> / {monthRows.length}
          </span>
          <span className="mx-2 text-slate-300">|</span>
          <span>Selected: {selectedIds.length}</span>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-600">COA Submission Date:</label>
          <input
            type="date"
            value={submissionDate}
            onChange={(e) => setSubmissionDate(e.target.value)}
            className="h-8 px-2 text-xs font-mono bg-white border border-slate-200 rounded"
          />
          <button
            type="button"
            disabled={selectedIds.length === 0 || saving}
            onClick={() => void handleBatchAssignSubmission()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-40 cursor-pointer whitespace-nowrap"
          >
            <CalendarCheck2 className="w-3.5 h-3.5" />
            <span>{saving ? 'Updating...' : 'Record Submission'}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-100 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
              <tr>
                <th className="py-2.5 px-3 w-10">
                  <input
                    type="checkbox"
                    checked={monthRows.length > 0 && selectedIds.length === monthRows.length}
                    onChange={toggleAll}
                  />
                </th>
                <th className="py-2.5 px-3">Seq</th>
                <th className="py-2.5 px-3">JEV No. &amp; Date</th>
                <th className="py-2.5 px-3">ADA/Check No</th>
                <th className="py-2.5 px-3">Payee</th>
                <th className="py-2.5 px-3 text-right">RCI Net Paid</th>
                <th className="py-2.5 px-3 text-right">JEV Gross</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">COA Submitted Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {monthRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-500">
                    No posted entries in {selectedMonth} yet.
                  </td>
                </tr>
              ) : (
                monthRows.map((tx) => {
                  const checked = selectedIds.includes(tx.id);
                  const jevExempt = isJevExempt(tx);
                  const isPendingJev = isJevPending(tx);
                  return (
                    <tr key={tx.id} className={checked ? 'bg-blue-50/50' : 'hover:bg-slate-50'}>
                      <td className="py-2.5 px-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelect(tx.id)}
                        />
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-500">{tx.sequenceNo}</td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-800">
                        {tx.jevNoDate || (jevExempt ? NO_JEV_CANCELLED_LABEL : 'Pending JEV')}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-900">
                        {tx.adaCheckNo}
                      </td>
                      <td className="py-2.5 px-3 font-medium text-slate-900">{tx.payeeName}</td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium text-emerald-800">
                        ₱{formatPeso(getDisplayRciNetAmount(tx))}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900">
                        {jevExempt && tx.journalLines.length === 0 ? (
                          <span
                            className="text-[11px] font-sans text-slate-400"
                            title="Cancelled check — no JEV entry will be encoded"
                          >
                            —
                          </span>
                        ) : isPendingJev ? (
                          <span className="text-[11px] font-sans text-amber-700">Pending JEV</span>
                        ) : (
                          `₱${formatPeso(tx.grossAmount)}`
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700">
                        <span className="capitalize">{tx.status}</span>
                        {tx.isCancelled && (
                          <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded border border-rose-300 bg-rose-50 text-[10px] font-semibold text-rose-700">
                            CANCELLED
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums">
                        {tx.submittedToCoaDate ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                            <Check className="w-3.5 h-3.5" />
                            <span>{tx.submittedToCoaDate}</span>
                          </span>
                        ) : (
                          <span className="text-amber-700">Pending transmittal</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
