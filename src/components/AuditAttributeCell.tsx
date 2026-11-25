import React, { useEffect, useRef, useState } from 'react';
import { cycleAttributeState, normalizeAttributeState } from '../lib/taxAndLedger';
import type { AuditAttributeState } from '../types/rci';

interface AuditAttributeCellProps {
  num: number;
  shortTag?: string;
  label: string;
  value: AuditAttributeState;
  onChange: (next: 'ok' | 'exclamation' | 'wrong' | 'na') => void;
  disabled?: boolean;
  compact?: boolean;
}

const STATE_OPTIONS: Array<{
  value: 'ok' | 'exclamation' | 'wrong' | 'na';
  glyph: string;
  title: string;
  desc: string;
  cls: string;
}> = [
  {
    value: 'ok',
    glyph: '✓',
    title: 'Control operating / in place',
    desc: 'Verified and compliant',
    cls: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  },
  {
    value: 'exclamation',
    glyph: '!',
    title: 'Control breakdown',
    desc: 'Missing or deficient document',
    cls: 'text-amber-800 bg-amber-50 border-amber-300',
  },
  {
    value: 'wrong',
    glyph: '✕',
    title: 'For further verification / review',
    desc: 'Requires auditor/management review',
    cls: 'text-red-700 bg-red-50 border-red-300',
  },
  {
    value: 'na',
    glyph: 'N/A',
    title: 'Not Applicable',
    desc: 'Control does not apply to voucher',
    cls: 'text-slate-600 bg-slate-100 border-slate-300',
  },
];

export const AuditAttributeCell: React.FC<AuditAttributeCellProps> = ({
  num,
  shortTag,
  label,
  value,
  onChange,
  disabled = false,
  compact = false,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const norm = normalizeAttributeState(value);

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    window.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [menuOpen]);

  const currentMeta = STATE_OPTIONS.find((o) => o.value === norm) || STATE_OPTIONS[0];

  const buttonClasses =
    norm === 'ok'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100'
      : norm === 'exclamation'
        ? 'bg-amber-50 border-amber-400 text-amber-800 hover:bg-amber-100'
        : norm === 'wrong'
          ? 'bg-red-50 border-red-400 text-red-700 hover:bg-red-100'
          : 'bg-slate-100 border-slate-300 text-slate-600 hover:bg-slate-200';

  const prefixLabel = compact ? '' : shortTag ? `${num}${shortTag}` : `${num}`;
  const displayGlyph = norm === 'na' ? (compact ? 'N/A' : '–') : currentMeta.glyph;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        title={`(${num}) ${label} · Status: ${currentMeta.title}\nClick to cycle · Right-click for menu`}
        onClick={() => {
          if (disabled) return;
          onChange(cycleAttributeState(norm));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (disabled) return;
          setMenuOpen((o) => !o);
        }}
        className={`w-full ${
          compact ? 'h-6 text-[10px]' : 'h-8 text-[11px]'
        } rounded border font-mono font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-0.5 px-0.5 ${buttonClasses}`}
      >
        {prefixLabel && <span className="opacity-70">{prefixLabel}</span>}
        <span>{displayGlyph}</span>
      </button>

      {menuOpen && (
        <div className="fixed sm:absolute right-0 top-full mt-1 w-64 bg-white border border-slate-200 rounded-md shadow-lg z-50 p-2 text-left">
          <div className="pb-1.5 mb-1.5 border-b border-slate-100">
            <p className="text-[11px] font-semibold text-slate-900 leading-snug">
              ({num}) {label}
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">Select control state</p>
          </div>
          <div className="space-y-1">
            {STATE_OPTIONS.map((opt) => {
              const active = norm === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setMenuOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors cursor-pointer ${
                    active ? 'bg-slate-900 text-white' : 'hover:bg-slate-100 text-slate-800'
                  }`}
                >
                  <span
                    className={`w-7 h-5 inline-flex items-center justify-center rounded border text-[10px] font-mono font-bold shrink-0 ${
                      active ? 'bg-white/15 border-white/25 text-white' : opt.cls
                    }`}
                  >
                    {opt.glyph}
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium truncate leading-tight">{opt.title}</div>
                    <div
                      className={`text-[10px] truncate ${
                        active ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {opt.desc}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
