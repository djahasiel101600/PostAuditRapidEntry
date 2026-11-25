import React, { useState } from 'react';
import { ArrowRight, CheckSquare, FileSpreadsheet, Keyboard, ShieldCheck } from 'lucide-react';
import { useAuthWorkspace } from '../contexts/AuthWorkspaceContext';

export const AuthGate: React.FC = () => {
  const { signInWithGoogle } = useAuthWorkspace();
  const [signingIn, setSigningIn] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleLogin = async () => {
    setSigningIn(true);
    setErrorMsg(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to sign in with Google.');
      setSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-6 py-12">
      <div className="max-w-4xl w-full bg-white border border-slate-200 rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-12">
        <div className="md:col-span-7 p-8 md:p-10 border-b md:border-b-0 md:border-r border-slate-200 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 mb-4">
              <span>NIA-SDNSO Fiscal Operations</span>
              <span aria-hidden="true">·</span>
              <span>RCI &amp; COA Working Paper</span>
            </div>

            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 font-display mb-3 text-balance">
              RCI Rapid Ledger &amp; Post-Audit Workspace
            </h1>
            <p className="text-sm text-slate-600 leading-relaxed mb-8">
              Built for accounting units encoding 500+ disbursements daily. Replace locked macro workbooks with keyboard-first grid entry, automatic tax splits, and live double-entry audit verification.
            </p>

            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Keyboard className="w-4 h-4 text-blue-700 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-slate-900">Keyboard-First Grid &amp; Smart Templates</p>
                  <p className="text-xs text-slate-500">
                    Tab/Enter row flow, sequential Check/DV auto-increment, and Alt+1..6 tax presets.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckSquare className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-slate-900">Live Debit / Credit &amp; Duplicate Guard</p>
                  <p className="text-xs text-slate-500">
                    Instant check-serial conflict detection and real-time 7-point COA attribute tracking.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <FileSpreadsheet className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-slate-900">Multi-User Cloud Sync &amp; .xlsx Export</p>
                  <p className="text-xs text-slate-500">
                    Concurrent encoder and auditor access with one-click Working Paper &amp; RCI export.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 pt-5 border-t border-slate-100 flex items-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-slate-400 shrink-0" />
            <span>Authenticated via Google Workspace · Role-enforced Firestore ledger</span>
          </div>
        </div>

        <div className="md:col-span-5 p-8 md:p-10 bg-slate-50/70 flex flex-col justify-center">
          <h2 className="text-lg font-semibold text-slate-900 font-display mb-2">
            Sign in to Workspace
          </h2>
          <p className="text-xs text-slate-600 mb-6 leading-relaxed">
            Access your agency&apos;s fiscal-year RCI ledger, smart templates, and pending audit queues.
          </p>

          {errorMsg && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">
              {errorMsg}
            </div>
          )}

          <button
            type="button"
            disabled={signingIn}
            onClick={handleLogin}
            className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-md hover:bg-slate-800 disabled:opacity-60 transition-colors cursor-pointer whitespace-nowrap"
          >
            <span>{signingIn ? 'Connecting...' : 'Continue with Google'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <p className="mt-4 text-xs text-slate-500 leading-relaxed">
            Create your fiscal-year workspace after sign-in and follow the built-in{' '}
            <span className="font-medium text-slate-700">Get Started</span> guide.
          </p>
        </div>
      </div>
    </div>
  );
};
