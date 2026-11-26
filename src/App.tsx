/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import { AuthGate } from './components/AuthGate';
import { DashboardView } from './components/DashboardView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GetStartedGuide } from './components/GetStartedGuide';
import { LackingQueueView } from './components/LackingQueueView';
import { MonthlyLedgerView } from './components/MonthlyLedgerView';
import { RapidEntryView } from './components/RapidEntryView';
import { ScheduleSubmissionView } from './components/ScheduleSubmissionView';
import { SidebarNav } from './components/SidebarNav';
import { TemplatesAndTeamView } from './components/TemplatesAndTeamView';
import { WelcomeSetup } from './components/WelcomeSetup';
import { AuthWorkspaceProvider, useAuthWorkspace } from './contexts/AuthWorkspaceContext';
import { exportWorkingPaperWorkbook } from './lib/excelExport';
import { hasFlaggedAttribute, isLegacyTransaction } from './lib/taxAndLedger';
import type { TransactionRecord, ViewModule } from './types/rci';

const VIEW_LABELS: Record<ViewModule, string> = {
  entry: 'Rapid Entry',
  ledger: 'Monthly Ledger',
  drafts: 'Drafts',
  lacking: 'Lacking Queue',
  schedule: 'COA Schedule',
  dashboard: 'Dashboard',
  settings: 'Templates & Team',
};

const WorkspaceShell: React.FC = () => {
  const {
    user,
    authLoading,
    workspaceLoading,
    logout,
    activeWorkspace,
    activeRole,
    workspaces,
    transactions,
    pendingInvitesForUser,
    acceptInvite,
  } = useAuthWorkspace();

  const [activeView, setActiveView] = useState<ViewModule>('entry');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editingTx, setEditingTx] = useState<TransactionRecord | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    setEditingTx(null);
  }, [activeWorkspace?.id]);

  const counts = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    let drafts = 0;
    let lacking = 0;
    let today = 0;

    for (const tx of transactions) {
      if (tx.status === 'draft') drafts += 1;
      const v2Alert =
        !isLegacyTransaction(tx) &&
        (tx.mathStatus === 'discrepancy' ||
          tx.mathStatus === 'manual_review' ||
          tx.taxStatus === 'variance' ||
          tx.taxStatus === 'manual_review' ||
          tx.taxStatus === 'incomplete_evidence');
      if (tx.status === 'lacking' || hasFlaggedAttribute(tx.attributes) || v2Alert) {
        lacking += 1;
      }
      const ts = tx.createdAt as { toDate?: () => Date } | undefined;
      if (ts?.toDate) {
        if (ts.toDate().toISOString().slice(0, 10) === todayStr) today += 1;
      } else if (tx.adaCheckDate === todayStr) {
        today += 1;
      }
    }
    return { drafts, lacking, today };
  }, [transactions]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-sm text-slate-500 font-medium">Loading RCI Rapid Ledger...</div>
      </div>
    );
  }

  if (!user) {
    return <AuthGate />;
  }

  if (!workspaceLoading && workspaces.length === 0) {
    return <WelcomeSetup />;
  }

  if (workspaceLoading || !activeWorkspace) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="bg-white border border-slate-200 rounded-lg px-6 py-4 text-sm text-slate-600">
          Preparing your fiscal-year RCI workspace...
        </div>
      </div>
    );
  }

  const handleOpenInRapidEntry = (tx: TransactionRecord) => {
    setEditingTx(tx);
    setActiveView('entry');
  };

  return (
    <div className="h-screen w-screen overflow-hidden bg-slate-50 flex">
      <SidebarNav
        activeView={activeView}
        onSelectView={(v) => {
          if (v !== 'entry' && v !== 'drafts') setEditingTx(null);
          setActiveView(v);
        }}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        draftCount={counts.drafts}
        lackingCount={counts.lacking}
        todayCount={counts.today}
        userEmail={user.email || 'Authenticated User'}
        userRole={activeRole}
        onLogout={() => void logout()}
      />

      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
        {/* Top Header Contract: Breadcrumb on left · Actions on right */}
        <header className="h-14 bg-white border-b border-slate-200 px-5 flex items-center justify-between gap-6 shrink-0">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="font-semibold text-slate-900 font-display whitespace-nowrap truncate">
              {activeWorkspace.name}
            </span>
            <span className="text-slate-300" aria-hidden="true">
              /
            </span>
            <span className="text-slate-600 whitespace-nowrap">{VIEW_LABELS[activeView]}</span>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {pendingInvitesForUser.length > 0 && (
              <button
                type="button"
                onClick={() => void acceptInvite(pendingInvitesForUser[0]).catch(() => {})}
                className="px-3 py-1.5 text-xs font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 transition-colors cursor-pointer whitespace-nowrap"
              >
                Accept Invite: {pendingInvitesForUser[0].workspaceName}
              </button>
            )}

            <button
              type="button"
              onClick={() =>
                exportWorkingPaperWorkbook(activeWorkspace.name, 'All', transactions)
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export all (.xlsx)</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setEditingTx(null);
                setActiveView('entry');
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Entry</span>
            </button>
          </div>
        </header>

        {/* Active Module Viewport */}
        <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {activeView === 'entry' && (
            <RapidEntryView
              editingTx={editingTx}
              onEditTx={(tx) => setEditingTx(tx)}
              onClearEditing={() => setEditingTx(null)}
            />
          )}
          {activeView === 'drafts' && (
            <RapidEntryView
              editingTx={editingTx}
              onEditTx={(tx) => setEditingTx(tx)}
              onClearEditing={() => setEditingTx(null)}
              onlyDrafts
            />
          )}
          {activeView === 'ledger' && (
            <MonthlyLedgerView onEditInRapidEntry={handleOpenInRapidEntry} />
          )}
          {activeView === 'lacking' && (
            <LackingQueueView onEditInRapidEntry={handleOpenInRapidEntry} />
          )}
          {activeView === 'schedule' && <ScheduleSubmissionView />}
          {activeView === 'dashboard' && (
            <DashboardView onNavigate={setActiveView} onOpenGuide={() => setGuideOpen(true)} />
          )}
          {activeView === 'settings' && <TemplatesAndTeamView />}
        </main>
      </div>

      <GetStartedGuide
        open={guideOpen}
        onOpenChange={setGuideOpen}
        onNavigate={(v) => {
          if (v !== 'entry' && v !== 'drafts') setEditingTx(null);
          setActiveView(v);
        }}
      />
    </div>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthWorkspaceProvider>
        <WorkspaceShell />
      </AuthWorkspaceProvider>
    </ErrorBoundary>
  );
}
