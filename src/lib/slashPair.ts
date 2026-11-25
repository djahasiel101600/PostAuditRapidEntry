/**
 * Helpers for slash-delimited "No / Date" pair fields (PO, PR, IAR).
 * A single text input holds two distinct values; they are parsed and stored
 * independently (left = reference number, right = date or free text).
 */

export interface SlashPair {
  left: string;
  right: string;
}

const MONTH_DAY_YEAR = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const TAIL_MDY = /^(.*?\S)\s*\/?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/;
const TAIL_ISO = /^(.*?\S)\s*\/?\s*(\d{4}-\d{1,2}-\d{1,2})$/;

/** Normalize a date segment to canonical `MM-DD-YYYY`; `ok=false` keeps the raw text. */
export function normalizePairDate(raw: string | undefined | null): { value: string; ok: boolean } {
  const text = String(raw ?? '').trim();
  if (!text) return { value: '', ok: true };

  let year = 0;
  let month = 0;
  let day = 0;
  const iso = text.match(ISO_DATE);
  if (iso) {
    year = parseInt(iso[1], 10);
    month = parseInt(iso[2], 10);
    day = parseInt(iso[3], 10);
  } else {
    const mdy = text.match(MONTH_DAY_YEAR);
    if (!mdy) return { value: text, ok: false };
    month = parseInt(mdy[1], 10);
    day = parseInt(mdy[2], 10);
    year = parseInt(mdy[3], 10);
    if (mdy[3].length === 2) year += 2000;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) {
    return { value: text, ok: false };
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return { value: text, ok: false };
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return { value: `${pad(month)}-${pad(day)}-${String(year)}`, ok: true };
}

/**
 * Split a `No / Date` draft into its two parts.
 * Prefers an explicit ` / ` separator, then a date-like tail (validated), then the last `/`.
 * No separator means the whole text is the left (number) part.
 */
export function splitSlashPair(text: string | undefined | null): SlashPair {
  const raw = String(text ?? '').trim();
  if (!raw) return { left: '', right: '' };

  const spacedIdx = raw.lastIndexOf(' / ');
  if (spacedIdx >= 0) {
    return { left: raw.slice(0, spacedIdx).trim(), right: raw.slice(spacedIdx + 3).trim() };
  }

  const mdyTail = TAIL_MDY.exec(raw);
  if (mdyTail && normalizePairDate(mdyTail[2]).ok) {
    return { left: mdyTail[1].replace(/\/+$/, '').trim(), right: mdyTail[2] };
  }
  const isoTail = TAIL_ISO.exec(raw);
  if (isoTail && normalizePairDate(isoTail[2]).ok) {
    return { left: isoTail[1].replace(/\/+$/, '').trim(), right: isoTail[2] };
  }

  const slashIdx = raw.lastIndexOf('/');
  if (slashIdx < 0) return { left: raw, right: '' };
  return { left: raw.slice(0, slashIdx).trim(), right: raw.slice(slashIdx + 1).trim() };
}

/** Compose the two stored values back into the single slash-delimited display string. */
export function composeSlashPair(
  left: string | undefined | null,
  right: string | undefined | null,
): string {
  const l = String(left ?? '').trim();
  const r = String(right ?? '').trim();
  if (l && r) return `${l} / ${r}`;
  return l || r;
}

/** Read a stored pair, falling back to splitting a legacy combined string when split parts are empty. */
export function readPair(
  no: string | undefined | null,
  date: string | undefined | null,
  legacy?: string | undefined | null,
): SlashPair {
  const left = String(no ?? '').trim();
  const right = String(date ?? '').trim();
  if (left || right) return { left, right };
  return splitSlashPair(legacy);
}

/** Convenience: read a stored pair (with legacy fallback) and compose its display text. */
export function renderSlashPair(
  no: string | undefined | null,
  date: string | undefined | null,
  legacy?: string | undefined | null,
): string {
  const pair = readPair(no, date, legacy);
  return composeSlashPair(pair.left, pair.right);
}
