import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, Circle, X } from 'lucide-react';
import { useAuthWorkspace } from '../contexts/AuthWorkspaceContext';
import {
  countCompleted,
  GET_STARTED_STEPS,
  isStepComplete,
  loadGuideState,
  saveGuideState,
  type GetStartedProgressInput,
  type GuidePersistedState,
} from '../lib/getStarted';
import type { ViewModule } from '../types/rci';

interface GetStartedGuideProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: ViewModule) => void;
}

/**
 * Non-blocking "Get Started" checklist: floating launcher + expandable card.
 * Auto steps check off from live workspace data; manual steps and the hidden
 * flag persist per user in localStorage.
 */
export const GetStartedGuide: React.FC<GetStartedGuideProps> = ({
  open,
  onOpenChange,
  onNavigate,
}) => {
  const {
    user,
    workspaces,
    customCoaAccounts,
    templates,
    transactions,
    sentInvites,
    members,
  } = useAuthWorkspace();

  const uid = user?.uid ?? null;
  const [persisted, setPersisted] = useState<GuidePersistedState>(() =>
    uid ? loadGuideState(uid) : { hidden: false, manualDone: [] },
  );

  useEffect(() => {
    setPersisted(uid ? loadGuideState(uid) : { hidden: false, manualDone: [] });
  }, [uid]);

  const input = useMemo<GetStartedProgressInput>(
    () => ({
      workspaceCount: workspaces.length,
      coaCount: customCoaAccounts.length,
      templateCount: templates.length,
      transactionCount: transactions.length,
      inviteCount: sentInvites.length,
      memberCount: members.length,
    }),
    [workspaces, customCoaAccounts, templates, transactions, sentInvites, members],
  );

  if (!uid || persisted.hidden) return null;

  const total = GET_STARTED_STEPS.length;
  const done = countCompleted(input, persisted.manualDone);
  const allDone = done === total;
  const pct = Math.round((done / total) * 100);

  const updatePersisted = (next: GuidePersistedState) => {
    setPersisted(next);
    saveGuideState(uid, next);
  };

  const markDone = (stepId: string) => {
    if (persisted.manualDone.includes(stepId)) return;
    updatePersisted({ ...persisted, manualDone: [...persisted.manualDone, stepId] });
  };

  const hide = () => {
    updatePersisted({ ...persisted, hidden: true });
    onOpenChange(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2.5 bg-slate-900 text-white text-xs font-medium pl-3.5 pr-4 py-2.5 rounded-full shadow-lg hover:bg-slate-800 transition-colors cursor-pointer"
      >
        <span>{allDone ? 'Get Started · complete' : `Get Started · ${done}/${total}`}</span>
        <span className="w-14 h-1.5 bg-slate-700 rounded overflow-hidden" aria-hidden="true">
          <span className="block h-full bg-emerald-400" style={{ width: `${pct}%` }} />
        </span>
        <ChevronDown className="w-3.5 h-3.5 rotate-180" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-auto bg-white border border-slate-200 rounded-lg shadow-xl">
      <div className="sticky top-0 bg-white border-b border-slate-100 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900 font-display">Get Started</p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={hide}
              className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-700 cursor-pointer"
            >
              Hide
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Collapse guide"
              className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-slate-100 rounded overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[11px] font-mono tabular-nums text-slate-500">
            {done}/{total}
          </span>
        </div>
      </div>

      {allDone ? (
        <div className="px-4 py-6 text-center space-y-3">
          <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
          <p className="text-sm font-medium text-slate-900">You&apos;re all set!</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            You&apos;ve completed every setup step. Keep encoding in Rapid Entry —
            the ledger, lacking queue and dashboard stay in sync automatically.
          </p>
          <button
            type="button"
            onClick={hide}
            className="px-4 py-1.5 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 cursor-pointer"
          >
            Close
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {GET_STARTED_STEPS.map((step) => {
            const complete = isStepComplete(step, input, persisted.manualDone);
            return (
              <li key={step.id} className="px-4 py-3 flex gap-2.5">
                {complete ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                ) : (
                  <Circle className="w-4 h-4 text-slate-300 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-xs font-medium ${
                      complete ? 'text-slate-400 line-through' : 'text-slate-800'
                    }`}
                  >
                    {step.title}
                    {step.optional && (
                      <span className="ml-1.5 text-[10px] font-normal text-slate-400 no-underline">
                        optional
                      </span>
                    )}
                  </p>
                  {!complete && (
                    <>
                      <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                        {step.description}
                      </p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            onNavigate(step.target);
                            onOpenChange(false);
                          }}
                          className="px-2.5 py-1 bg-slate-900 text-white text-[11px] font-medium rounded hover:bg-slate-800 cursor-pointer"
                        >
                          Go
                        </button>
                        {step.kind === 'manual' && (
                          <button
                            type="button"
                            onClick={() => markDone(step.id)}
                            className="px-2.5 py-1 border border-slate-200 text-slate-600 text-[11px] rounded hover:bg-slate-50 cursor-pointer"
                          >
                            Mark done
                          </button>
                        )}
                        {step.optional && step.kind === 'auto' && (
                          <button
                            type="button"
                            onClick={() => markDone(step.id)}
                            className="px-2.5 py-1 text-slate-400 text-[11px] hover:text-slate-600 cursor-pointer"
                          >
                            Skip
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};