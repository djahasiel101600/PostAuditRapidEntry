import React, { useRef, useState } from 'react';
import { normalizePairDate, splitSlashPair } from '../lib/slashPair';

interface SlashPairInputProps {
  leftValue: string;
  rightValue: string;
  onChange: (left: string, right: string) => void;
  leftPlaceholder?: string;
  rightPlaceholder?: string;
  rightMode?: 'text' | 'date';
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * One visually unified field holding two independently stored values separated
 * by a drawn `/` (e.g. "PO-2026-014 / 01-05-2026"). Both halves are separately
 * editable; the right part is normalized to MM-DD-YYYY in date mode.
 * Unrecognized dates keep their raw text and tint the field amber (non-blocking).
 */
export const SlashPairInput: React.FC<SlashPairInputProps> = ({
  leftValue,
  rightValue,
  onChange,
  leftPlaceholder,
  rightPlaceholder,
  rightMode = 'date',
  disabled = false,
  ariaLabel,
}) => {
  const [leftDraft, setLeftDraft] = useState('');
  const [rightDraft, setRightDraft] = useState('');
  const [editingPart, setEditingPart] = useState<'left' | 'right' | null>(null);
  const skipBlurRef = useRef(false);

  const rightText = editingPart === 'right' ? rightDraft : rightValue || '';
  const dateInvalid =
    rightMode === 'date' && Boolean(rightText.trim()) && !normalizePairDate(rightText).ok;

  const commitLeft = () => {
    let left = leftDraft.trim();
    let right = rightValue || '';
    // Pasting a combined "No / Date" string into the number half splits it,
    // but only when the tail parses as a date (keeps slashed numbers intact).
    if (!right && rightMode === 'date' && left.includes('/')) {
      const pair = splitSlashPair(left);
      if (pair.right && normalizePairDate(pair.right).ok) {
        left = pair.left;
        right = normalizePairDate(pair.right).value;
      }
    }
    setEditingPart(null);
    if (left !== (leftValue || '') || right !== (rightValue || '')) {
      onChange(left, right);
    }
  };

  const commitRight = () => {
    let right = rightDraft.trim();
    if (rightMode === 'date' && right) {
      right = normalizePairDate(right).value;
    }
    setEditingPart(null);
    if (right !== (rightValue || '')) {
      onChange(leftValue || '', right);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      skipBlurRef.current = true;
      setEditingPart(null);
      (e.target as HTMLInputElement).blur();
    }
  };

  const handleBlur = (part: 'left' | 'right') => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    if (part === 'left') commitLeft();
    else commitRight();
  };

  const fieldClasses =
    'h-full border-none bg-transparent p-0 text-xs outline-none placeholder:text-slate-400 disabled:cursor-not-allowed';

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      title={dateInvalid ? 'Date part not recognized (MM-DD-YYYY)' : undefined}
      className={`w-full h-7 flex items-center rounded border bg-slate-50 px-2 text-xs focus-within:border-blue-600 ${
        dateInvalid ? 'border-amber-400' : 'border-slate-200'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <input
        type="text"
        value={editingPart === 'left' ? leftDraft : leftValue || ''}
        placeholder={leftPlaceholder}
        disabled={disabled}
        aria-label={ariaLabel ? `${ariaLabel} — reference number` : 'Reference number'}
        onFocus={() => {
          setLeftDraft(leftValue || '');
          setEditingPart('left');
        }}
        onChange={(e) => setLeftDraft(e.target.value)}
        onBlur={() => handleBlur('left')}
        onKeyDown={handleKeyDown}
        className={`${fieldClasses} min-w-0 flex-1`}
      />
      <span aria-hidden="true" className="select-none px-1 text-slate-400">
        /
      </span>
      <input
        type="text"
        value={editingPart === 'right' ? rightDraft : rightValue || ''}
        placeholder={rightPlaceholder}
        disabled={disabled}
        aria-label={ariaLabel ? `${ariaLabel} — ${rightMode === 'date' ? 'date' : 'value'}` : undefined}
        onFocus={() => {
          setRightDraft(rightValue || '');
          setEditingPart('right');
        }}
        onChange={(e) => setRightDraft(e.target.value)}
        onBlur={() => handleBlur('right')}
        onKeyDown={handleKeyDown}
        className={`${fieldClasses} ${dateInvalid ? 'text-amber-800' : ''} ${
          rightMode === 'date' ? 'w-[84px] shrink-0' : 'min-w-0 flex-1'
        }`}
      />
    </div>
  );
};
