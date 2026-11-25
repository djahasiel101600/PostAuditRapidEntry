import React, { useState } from 'react';
import { BookOpenCheck, LogOut } from 'lucide-react';
import { useAuthWorkspace } from '../contexts/AuthWorkspaceContext';

/**
 * First-run screen shown when the signed-in user has no workspace yet.
 * Replaces the old auto-provisioned seed workspace: the user names their
 * own fiscal-year workspace, then the Get Started guide takes over.
 */
export const WelcomeSetup: React.FC = () => {
  const { user, createWorkspace, logout } = useAuthWorkspace();
  const currentYear = new Date().getFullYear();
  const [name, setName] = useState('');
  const [agencyCode, setAgencyCode] = useState('');
  const [fiscalYear, setFiscalYear] = useState(
    Math.min(2099, Math.max(2020, currentYear)),
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && agencyCode.trim().length > 0 && !creating;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    setError(null);
    try {
      await createWorkspace(name.trim(), agencyCode.trim(), fiscalYear);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the workspace.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-lg p-8 space-y-6">
        <div>
          <p className="text-xs font-medium text-slate-500 mb-2">
            Welcome{user?.displayName ? `, ${user.displayName}` : ''}
          </p>
          <h1 className="text-xl font-semibold text-slate-900 font-display">
            Set up your RCI workspace
          </h1>
          <p className="text-sm text-slate-600 mt-2 leading-relaxed">
            A workspace holds one fiscal year of disbursement records for your
            office. Create yours to begin — it starts empty, and the Get Started
            guide will walk you through the setup.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="ws-name" className="block text-xs font-medium text-slate-700 mb-1">
              Workspace name
            </label>
            <input
              id="ws-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g., Regional Office Ledger 2026"
              className="w-full h-9 px-3 text-sm border border-slate-200 rounded bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-400"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ws-agency" className="block text-xs font-medium text-slate-700 mb-1">
                Agency code
              </label>
              <input
                id="ws-agency"
                type="text"
                value={agencyCode}
                onChange={(e) => setAgencyCode(e.target.value)}
                maxLength={60}
                placeholder="e.g., NIA-SDNSO"
                className="w-full h-9 px-3 text-sm border border-slate-200 rounded bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-400"
              />
            </div>
            <div>
              <label htmlFor="ws-year" className="block text-xs font-medium text-slate-700 mb-1">
                Fiscal year
              </label>
              <input
                id="ws-year"
                type="number"
                min={2020}
                max={2099}
                value={fiscalYear}
                onChange={(e) => setFiscalYear(parseInt(e.target.value, 10) || currentYear)}
                className="w-full h-9 px-3 text-sm font-mono tabular-nums border border-slate-200 rounded bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-400"
              />
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full h-10 bg-slate-900 text-white text-sm font-medium rounded hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {creating ? 'Creating workspace...' : 'Create workspace'}
          </button>
        </form>

        <div className="border-t border-slate-100 pt-4">
          <p className="flex items-center gap-1.5 text-xs font-medium text-slate-700 mb-2">
            <BookOpenCheck className="w-3.5 h-3.5" />
            What happens next
          </p>
          <ul className="space-y-1.5 text-xs text-slate-500 list-disc pl-5">
            <li>Add your Chart of Accounts (or import it from a file).</li>
            <li>Create Smart Templates for the payments you encode most.</li>
            <li>Record your first entry in Rapid Entry and review the ledger.</li>
          </ul>
        </div>

        <button
          type="button"
          onClick={() => void logout()}
          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign out
        </button>
      </div>
    </div>
  );
};