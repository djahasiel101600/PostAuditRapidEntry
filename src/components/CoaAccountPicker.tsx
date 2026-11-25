import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, ChevronDown } from 'lucide-react';
import type { CoaAccount } from '../types/rci';

interface CoaAccountPickerProps {
  accountCode: string;
  accountTitle: string;
  accounts: CoaAccount[];
  onChange: (next: { accountCode: string; accountTitle: string }) => void;
  onSaveToWorkspaceCoa?: (acct: {
    code: string;
    title: string;
    normalSide: 'debit' | 'credit';
  }) => Promise<void> | void;
  suggestedNormalSide?: 'debit' | 'credit';
  compact?: boolean;
}

export const CoaAccountPicker: React.FC<CoaAccountPickerProps> = ({
  accountCode,
  accountTitle,
  accounts,
  onChange,
  onSaveToWorkspaceCoa,
  suggestedNormalSide = 'debit',
  compact = false,
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [dropdownOpen]);

  const filteredAccounts = useMemo(() => {
    const q = accountTitle.trim().toLowerCase();
    const codeQ = accountCode.trim().toLowerCase();
    if (!q && !codeQ) return accounts.slice(0, 40);
    // Match against title or code
    const matched = accounts.filter((a) => {
      const tMatch = q ? a.title.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) : true;
      return tMatch;
    });
    if (matched.length > 0) return matched.slice(0, 40);
    return accounts.slice(0, 40);
  }, [accounts, accountTitle, accountCode]);

  const isExactPreset = useMemo(() => {
    const c = accountCode.trim().toLowerCase();
    const t = accountTitle.trim().toLowerCase();
    if (!c || !t) return true;
    return accounts.some(
      (a) => a.code.trim().toLowerCase() === c && a.title.trim().toLowerCase() === t,
    );
  }, [accounts, accountCode, accountTitle]);

  const selectAccount = (acct: CoaAccount) => {
    onChange({ accountCode: acct.code, accountTitle: acct.title });
    setDropdownOpen(false);
  };

  const handleCodeChange = (nextCode: string) => {
    const exactCodeMatches = accounts.filter(
      (a) => a.code.trim().toLowerCase() === nextCode.trim().toLowerCase(),
    );
    if (exactCodeMatches.length === 1 && !accountTitle.trim()) {
      onChange({ accountCode: nextCode, accountTitle: exactCodeMatches[0].title });
    } else {
      onChange({ accountCode: nextCode, accountTitle });
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!dropdownOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setDropdownOpen(true);
      setHighlightIndex(0);
      return;
    }
    if (!dropdownOpen) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(filteredAccounts.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && filteredAccounts[highlightIndex]) {
      e.preventDefault();
      selectAccount(filteredAccounts[highlightIndex]);
    } else if (e.key === 'Escape') {
      setDropdownOpen(false);
    }
  };

  const handleSaveCustom = async () => {
    if (!onSaveToWorkspaceCoa) return;
    const code = accountCode.trim();
    const title = accountTitle.trim();
    if (!code || !title) return;
    setSaving(true);
    try {
      await onSaveToWorkspaceCoa({
        code,
        title,
        normalSide: suggestedNormalSide,
      });
    } finally {
      setSaving(false);
    }
  };

  const inputHeight = compact ? 'h-7' : 'h-8';

  return (
    <div ref={containerRef} className="relative flex items-center gap-1 min-w-0">
      <input
        type="text"
        value={accountCode}
        onChange={(e) => handleCodeChange(e.target.value)}
        placeholder="Code"
        aria-label="Account Code"
        maxLength={30}
        className={`w-[82px] shrink-0 ${inputHeight} px-1.5 text-[11px] font-mono tabular-nums bg-slate-50 border border-slate-200 rounded text-slate-800 focus:bg-white focus:border-slate-400 focus:outline-none`}
      />

      <div className="relative flex-1 min-w-0">
        <input
          type="text"
          value={accountTitle}
          onFocus={() => {
            setDropdownOpen(true);
            setHighlightIndex(0);
          }}
          onChange={(e) => {
            onChange({ accountCode, accountTitle: e.target.value });
            setDropdownOpen(true);
            setHighlightIndex(0);
          }}
          onKeyDown={handleTitleKeyDown}
          placeholder="Search or type Account Title..."
          aria-label="Account Title"
          maxLength={140}
          className={`w-full ${inputHeight} pl-2 pr-6 text-[11px] bg-slate-50 border border-slate-200 rounded text-slate-900 focus:bg-white focus:border-slate-400 focus:outline-none truncate`}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setDropdownOpen((o) => !o)}
          aria-label="Toggle Chart of Accounts list"
          className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-700 cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>

        {dropdownOpen && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-white border border-slate-200 rounded-md shadow-lg max-h-56 overflow-y-auto min-w-[260px]">
            {filteredAccounts.length === 0 ? (
              <div className="px-2.5 py-2 text-[11px] text-slate-500">
                No matching COA account — custom title will be used directly.
              </div>
            ) : (
              filteredAccounts.map((acct, idx) => {
                const highlighted = idx === highlightIndex;
                return (
                  <button
                    key={`${acct.id || 'def'}-${acct.code}-${acct.title}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectAccount(acct);
                    }}
                    onMouseEnter={() => setHighlightIndex(idx)}
                    className={`w-full text-left px-2.5 py-1.5 text-[11px] flex items-center gap-2 cursor-pointer border-b border-slate-50 last:border-b-0 ${
                      highlighted ? 'bg-slate-100 text-slate-950' : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span className="font-mono tabular-nums text-[10px] text-slate-500 shrink-0">
                      {acct.code}
                    </span>
                    <span className="truncate flex-1">{acct.title}</span>
                    <span className="text-[10px] uppercase font-mono text-slate-400 shrink-0">
                      {acct.normalSide === 'credit' ? 'Cr' : 'Dr'}
                    </span>
                  </button>
                );
              })
            )}

            {onSaveToWorkspaceCoa && !isExactPreset && accountCode.trim() && accountTitle.trim() && (
              <div className="sticky bottom-0 bg-slate-50 border-t border-slate-200 px-2.5 py-1.5 flex items-center justify-between gap-2">
                <span className="text-[10px] text-slate-600 truncate">
                  Custom: <span className="font-mono">{accountCode.trim()}</span> · {accountTitle.trim()}
                </span>
                <button
                  type="button"
                  disabled={saving}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void handleSaveCustom();
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-slate-900 text-white rounded hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <BookmarkPlus className="w-3 h-3" />
                  <span>{saving ? 'Saving...' : 'Save to COA'}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {onSaveToWorkspaceCoa && !isExactPreset && accountCode.trim() && accountTitle.trim() && (
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleSaveCustom()}
          title="Save custom Account Code & Title to workspace Chart of Accounts"
          className="h-7 px-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <BookmarkPlus className="w-3 h-3" />
          <span>Save</span>
        </button>
      )}
    </div>
  );
};
