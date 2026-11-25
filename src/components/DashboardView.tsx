import React, { useMemo } from 'react';
import { ArrowUpRight, BookOpenCheck } from 'lucide-react';
import { useAuthWorkspace } from '../contexts/AuthWorkspaceContext';
import { countCompleted, GET_STARTED_STEPS, loadGuideState } from '../lib/getStarted';
import {
  formatPeso,
  getDisplayRciNetAmount,
  hasFlaggedAttribute,
  isLegacyTransaction,
} from '../lib/taxAndLedger';
import { MONTHS, type MonthName, type ViewModule } from '../types/rci';

interface DashboardViewProps {
  onNavigate: (view: ViewModule) => void;
  onOpenGuide?: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ onNavigate, onOpenGuide }) => {
  const {
    user,
    workspaces,
    customCoaAccounts,
    templates,
    transactions,
    sentInvites,
    members,
    setSelectedMonth,
  } = useAuthWorkspace();

  const guide = useMemo(() => {
    if (!user) return null;
    const persisted = loadGuideState(user.uid);
    const done = countCompleted(
      {
        workspaceCount: workspaces.length,
        coaCount: customCoaAccounts.length,
        templateCount: templates.length,
        transactionCount: transactions.length,
        inviteCount: sentInvites.length,
        memberCount: members.length,
      },
      persisted.manualDone,
    );
    return { done, total: GET_STARTED_STEPS.length, hidden: persisted.hidden };
  }, [
    user,
    workspaces.length,
    customCoaAccounts.length,
    templates.length,
    transactions.length,
    sentInvites.length,
    members.length,
  ]);

  const metrics = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    let todayCount = 0;
    let totalGross = 0;
    let totalNet = 0;
    let totalTax = 0;
    let lackingCount = 0;
    let draftCount = 0;
    let auditedCount = 0;

    for (const tx of transactions) {
      totalGross += tx.grossAmount;
      totalNet += getDisplayRciNetAmount(tx);
      totalTax += tx.taxWithheld;
      const v2Alert =
        !isLegacyTransaction(tx) &&
        (tx.mathStatus === 'discrepancy' ||
          tx.mathStatus === 'manual_review' ||
          tx.taxStatus === 'variance' ||
          tx.taxStatus === 'manual_review' ||
          tx.taxStatus === 'incomplete_evidence');
      if (tx.status === 'lacking' || hasFlaggedAttribute(tx.attributes) || v2Alert) {
        lackingCount += 1;
      }
      if (tx.status === 'draft') draftCount += 1;
      if (tx.status === 'audited') auditedCount += 1;

      const ts = tx.createdAt as { toDate?: () => Date } | undefined;
      if (ts?.toDate) {
        if (ts.toDate().toISOString().slice(0, 10) === todayStr) todayCount += 1;
      } else if (tx.adaCheckDate === todayStr) {
        todayCount += 1;
      }
    }

    return {
      todayCount,
      totalCount: transactions.length,
      totalGross,
      totalNet,
      totalTax,
      lackingCount,
      draftCount,
      auditedCount,
    };
  }, [transactions]);

  const monthlyBreakdown = useMemo(() => {
    return MONTHS.map((m: MonthName) => {
      const rows = transactions.filter((t) => t.month === m);
      return {
        month: m,
        count: rows.length,
        gross: rows.reduce((s, r) => s + r.grossAmount, 0),
        net: rows.reduce((s, r) => s + getDisplayRciNetAmount(r), 0),
        tax: rows.reduce((s, r) => s + r.taxWithheld, 0),
        lacking: rows.filter((r) => {
          const v2Alert =
            !isLegacyTransaction(r) &&
            (r.mathStatus === 'discrepancy' ||
              r.mathStatus === 'manual_review' ||
              r.taxStatus === 'variance' ||
              r.taxStatus === 'manual_review');
          return r.status === 'lacking' || hasFlaggedAttribute(r.attributes) || v2Alert;
        }).length,
        audited: rows.filter((r) => r.status === 'audited').length,
      };
    });
  }, [transactions]);

  const topPayees = useMemo(() => {
    const map = new Map<string, { name: string; count: number; rciNet: number }>();
    for (const tx of transactions) {
      const key = tx.payeeName.trim();
      const prev = map.get(key) || { name: key, count: 0, rciNet: 0 };
      prev.count += 1;
      prev.rciNet += getDisplayRciNetAmount(tx);
      map.set(key, prev);
    }
    return Array.from(map.values())
      .sort((a, b) => b.rciNet - a.rciNet)
      .slice(0, 8);
  }, [transactions]);

  const dailyPct = Math.min(100, Math.round((metrics.todayCount / 500) * 100));

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {/* Get Started progress card (until all steps are done or the guide is hidden) */}
      {guide && !guide.hidden && guide.done < guide.total && onOpenGuide && (
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-3 flex items-center gap-3">
          <BookOpenCheck className="w-4 h-4 text-slate-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-slate-800">
              Get Started — {guide.done} of {guide.total} steps done
            </p>
            <div className="mt-1.5 h-1.5 w-full max-w-xs bg-slate-100 rounded overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-[width] duration-200"
                style={{ width: `${Math.round((guide.done / guide.total) * 100)}%` }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenGuide}
            className="px-3 py-1.5 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 cursor-pointer whitespace-nowrap"
          >
            Open guide
          </button>
        </div>
      )}

      {/* 4-Column Flat KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs font-medium text-slate-500">Daily Encoding Progress</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
            {metrics.todayCount} <span className="text-sm font-normal text-slate-400">/ 500</span>
          </p>
          <div className="mt-2.5 h-1.5 w-full bg-slate-100 rounded overflow-hidden">
            <div
              className="h-full bg-blue-700 transition-[width] duration-200"
              style={{ width: `${dailyPct}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-500 mt-1.5 font-mono tabular-nums">
            {metrics.totalCount} total fiscal records
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs font-medium text-slate-500">Total RCI Net Cash Paid</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-1">
            ₱{formatPeso(metrics.totalNet)}
          </p>
          <p className="text-[11px] text-slate-500 mt-2 font-mono tabular-nums">
            JEV Gross Encoded: ₱{formatPeso(metrics.totalGross)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs font-medium text-slate-500">BIR Taxes Withheld</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-emerald-700 mt-1">
            ₱{formatPeso(metrics.totalTax)}
          </p>
          <p className="text-[11px] text-slate-500 mt-2 font-mono tabular-nums">
            Audited Vouchers: {metrics.auditedCount} · Drafts: {metrics.draftCount}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500">Lacking &amp; Exceptions</p>
            <p
              className={`text-2xl font-bold font-mono tabular-nums mt-1 ${
                metrics.lackingCount > 0 ? 'text-red-600' : 'text-emerald-700'
              }`}
            >
              {metrics.lackingCount}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('lacking')}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-slate-700 hover:text-slate-950 cursor-pointer"
          >
            <span>Open Lacking Queue</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Two-Column Breakdown: Monthly Ledger Totals + Top Payees */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 font-display">
              Fiscal Year Monthly Ledger Summary
            </h3>
            <span className="text-xs text-slate-500">Click any month to open working paper</span>
          </div>
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
              <tr>
                <th className="py-2 px-4">Month</th>
                <th className="py-2 px-3 text-right">Entries</th>
                <th className="py-2 px-3 text-right">RCI Net Cash</th>
                <th className="py-2 px-3 text-right">JEV Gross</th>
                <th className="py-2 px-3 text-right">Tax Withheld</th>
                <th className="py-2 px-3 text-right">Exceptions</th>
                <th className="py-2 px-4 text-right">Audited</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {monthlyBreakdown.map((row) => (
                <tr
                  key={row.month}
                  onClick={() => {
                    setSelectedMonth(row.month);
                    onNavigate('ledger');
                  }}
                  className="hover:bg-slate-50 cursor-pointer"
                >
                  <td className="py-2 px-4 font-medium text-slate-900">{row.month}</td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700">
                    {row.count}
                  </td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums font-medium text-slate-900">
                    {row.net > 0 ? `₱${formatPeso(row.net)}` : '—'}
                  </td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600">
                    {row.gross > 0 ? `₱${formatPeso(row.gross)}` : '—'}
                  </td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600">
                    {row.tax > 0 ? `₱${formatPeso(row.tax)}` : '—'}
                  </td>
                  <td
                    className={`py-2 px-3 text-right font-mono tabular-nums ${
                      row.lacking > 0 ? 'text-red-600 font-semibold' : 'text-slate-400'
                    }`}
                  >
                    {row.lacking}
                  </td>
                  <td className="py-2 px-4 text-right font-mono tabular-nums text-emerald-700">
                    {row.audited}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900 font-display">Top Payees (RCI Net)</h3>
          </div>
          {topPayees.length === 0 ? (
            <div className="p-6 text-xs text-slate-500 text-center">No payees recorded yet.</div>
          ) : (
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                <tr>
                  <th className="py-2 px-4">Payee</th>
                  <th className="py-2 px-3 text-right">Tx</th>
                  <th className="py-2 px-4 text-right">RCI Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {topPayees.map((p) => (
                  <tr key={p.name}>
                    <td className="py-2 px-4 font-medium text-slate-900 truncate max-w-[160px]">
                      {p.name}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600">
                      {p.count}
                    </td>
                    <td className="py-2 px-4 text-right font-mono tabular-nums text-slate-900">
                      ₱{formatPeso(p.rciNet)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
