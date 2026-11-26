import {
  defaultAttributes,
  round2,
} from './taxAndLedger';
import type {
  AuditAttributesMap,
  ClerkReviewStatus,
  DocumentaryVerificationStatus,
  EntryTemplate,
  JournalLine,
  MathReconciliationStatus,
  MonthName,
  PayeeRecord,
  PaymentMode,
  TaxVerificationStatus,
} from '../types/rci';

const LEGACY_SEEDED_KEYWORDS: Record<string, string> = {
  'tpl-meals-snacks': 'meal, snack, cater, food, refreshment, lunch, dinner, breakfast',
  'tpl-utilities': 'electric, water, utility, utilities, internet, pldt, globe, siarelco, power',
  'tpl-leave-monetization': 'leave, monetization, terminal pay, commutation',
  'tpl-procurement-goods':
    'suppl, goods, hardware, fuel, gasoline, diesel, equipment, materials, purchase order',
  'tpl-services-ewt2': 'repair, service, consult, labor, maintenance, contract',
  'tpl-remittance': 'gsis, pag-ibig, pagibig, philhealth, remittance, withholding, bir',
};

export function getEffectiveTemplateKeywordsString(tpl: EntryTemplate): string {
  if (tpl.autoMatchKeywords !== undefined) return tpl.autoMatchKeywords;
  return LEGACY_SEEDED_KEYWORDS[tpl.id] || '';
}

export function getEffectiveTemplateKeywords(tpl: EntryTemplate): string[] {
  return getEffectiveTemplateKeywordsString(tpl)
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Parses a single pasted line from Excel (TSV) or CSV (including quoted commas like "13,500.00").
 */
export function parseDelimitedRow(line: string): string[] {
  if (line.includes('\t')) {
    return line.split('\t').map((cell) => {
      const t = cell.trim();
      if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        return t.slice(1, -1).replace(/""/g, '"').trim();
      }
      return t;
    });
  }

  const cols: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}

export function isBatchHeaderRow(cols: string[]): boolean {
  if (cols.length < 4) return false;
  const c0 = (cols[0] || '').toLowerCase();
  const c1 = (cols[1] || '').toLowerCase();
  const c3 = (cols[3] || '').toLowerCase();
  const c5 = (cols[5] || '').toLowerCase();
  const looksLikeHeaderText =
    (c0.includes('date') || c1.includes('check') || c1.includes('ada') || c1.includes('serial') || c3.includes('payee')) &&
    (c5 === '' || /amount|net|check|ada|gross/.test(c5) || Number.isNaN(Number(c5.replace(/[^0-9.-]/g, ''))));
  return looksLikeHeaderText;
}

export function normalizePasteDate(raw: string, fallbackIso: string): string {
  const s = raw.trim();
  if (!s) return fallbackIso;

  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY or MM-DD-YYYY or M/D/YY
  const mdy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (mdy) {
    const first = parseInt(mdy[1], 10);
    const second = parseInt(mdy[2], 10);
    let year = parseInt(mdy[3], 10);
    if (year < 100) year += 2000;
    const month = first > 12 ? second : first;
    const day = first > 12 ? first : second;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Fallback for textual dates like "Jan 8, 2026"
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    const yyyy = parsed.getFullYear();
    const mm = String(parsed.getMonth() + 1).padStart(2, '0');
    const dd = String(parsed.getDate()).padStart(2, '0');
    if (yyyy >= 2000 && yyyy <= 2099) {
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  return fallbackIso;
}

export type BatchMatchSource =
  | 'column'
  | 'column-draft'
  | 'payee'
  | 'keyword'
  | 'fallback';

export function matchTemplateForBatchRow(
  payeeStr: string,
  natureStr: string,
  hintCol: string | undefined,
  templates: EntryTemplate[],
  payees: PayeeRecord[],
): { tpl: EntryTemplate | null; source: BatchMatchSource } {
  if (hintCol?.trim()) {
    const hint = hintCol.trim().toLowerCase();
    if (hint === 'draft' || hint === 'review') {
      return { tpl: null, source: 'column-draft' };
    }
    const byHint = templates.find(
      (t) =>
        t.shortcutKey.toLowerCase() === hint ||
        t.id.toLowerCase() === hint ||
        t.name.toLowerCase().includes(hint),
    );
    if (byHint) return { tpl: byHint, source: 'column' };
  }

  const payeeLower = payeeStr.trim().toLowerCase();
  if (payeeLower) {
    const matchedPayee = payees.find(
      (p) =>
        p.name.trim().toLowerCase() === payeeLower ||
        (payeeLower.length >= 5 && p.name.trim().toLowerCase().includes(payeeLower)),
    );
    if (matchedPayee?.defaultTemplateId) {
      const byPayee = templates.find((t) => t.id === matchedPayee.defaultTemplateId);
      if (byPayee) return { tpl: byPayee, source: 'payee' };
    }
  }

  const combined = `${payeeStr} ${natureStr}`.toLowerCase();
  for (const tpl of templates) {
    const keywords = getEffectiveTemplateKeywords(tpl);
    if (keywords.some((kw) => combined.includes(kw))) {
      return { tpl, source: 'keyword' };
    }
  }

  return { tpl: null, source: 'fallback' };
}

export interface BatchDraftTransactionInput {
  sequenceNo: number;
  month: MonthName;
  adaCheckDate: string;
  adaCheckNo: string;
  paymentMode: PaymentMode;
  dvNo: string;
  payeeName: string;
  natureOfTransaction: string;
  rciAmount: number;
  declaredJevGross: number;
  grossAmount: number;
  netAmount: number;
  taxWithheld: number;
  isCancelled: boolean;
  cancellationReason: string;
  templateId?: string;
  journalLines: JournalLine[];
  attributes: AuditAttributesMap;
  remarks: string;
  forceDraft: true;
  mathStatus: MathReconciliationStatus;
  taxStatus: TaxVerificationStatus;
  documentaryStatus: DocumentaryVerificationStatus;
  clerkReviewStatus: ClerkReviewStatus;
  amountModelVersion: 2;
}

/**
 * Detects a cancelled-check marker in the optional Status column of a pasted row.
 * Anchored to the start of the cell so free text like "replacement for cancelled check"
 * never excludes a valid payment from totals by accident.
 */
export function parseBatchCancelledMarker(cell?: string): {
  isCancelled: boolean;
  reason: string;
} {
  const raw = (cell || '').trim();
  if (!raw) return { isCancelled: false, reason: '' };
  const match = raw.match(/^(cancelled|canceled|void|voided|spoiled)\b/i);
  if (!match) return { isCancelled: false, reason: '' };
  return { isCancelled: true, reason: raw.slice(0, 200) };
}

/**
 * Locates the cancelled-check marker in a pasted row. The marker may sit in:
 * - the Serial cell of a two-cell row (date · Cancelled),
 * - the DV cell of a three-cell row (date · Serial · Cancelled),
 * - the optional trailing Status column (index 7) of a full row.
 * Returns the marker cell index so it is never reused as a real DV/serial value.
 */
export function detectBatchCancelledCell(cols: string[]): {
  isCancelled: boolean;
  reason: string;
  cellIndex: number;
} {
  const candidates: number[] = [];
  if (cols.length === 2) candidates.push(1);
  if (cols.length === 3) candidates.push(2);
  if (cols.length > 7) candidates.push(7);
  for (const cellIndex of candidates) {
    const marker = parseBatchCancelledMarker(cols[cellIndex]);
    if (marker.isCancelled) return { ...marker, cellIndex };
  }
  return { isCancelled: false, reason: '', cellIndex: -1 };
}

/**
 * Builds a Batch Paste Draft payload storing ONLY the agency-submitted RCI Amount (Net of Tax).
 * Strictly creates ZERO JEV journal lines: live rows keep JEV Gross, Taxes Withheld, and
 * accounting lines pending until encoded, while cancelled checks are JEV-exempt and carry
 * not_applicable verification statuses (no JEV will ever be prepared for them).
 */
export function buildBatchDraftTransactionInput(params: {
  sequenceNo: number;
  month: MonthName;
  adaCheckDate: string;
  adaCheckNo: string;
  paymentMode?: PaymentMode;
  dvNo: string;
  payeeName: string;
  natureOfTransaction: string;
  rawAmountString: string;
  suggestedTemplateId?: string;
  isCancelled?: boolean;
  cancellationReason?: string;
}): BatchDraftTransactionInput {
  const numericStr = (params.rawAmountString || '0').replace(/[^0-9.-]/g, '');
  const rciNet = round2(Math.max(0, parseFloat(numericStr) || 0));
  const isCancelled = Boolean(params.isCancelled);
  const payeeName = params.payeeName.trim();
  const natureOfTransaction = params.natureOfTransaction.trim();

  return {
    sequenceNo: params.sequenceNo,
    month: params.month,
    adaCheckDate: params.adaCheckDate,
    adaCheckNo: params.adaCheckNo,
    paymentMode: params.paymentMode === 'ada' ? 'ada' : 'check',
    dvNo: params.dvNo,
    // Cancelled rows stay truly blank apart from date/serial: no placeholder text.
    payeeName: isCancelled ? payeeName : payeeName || 'Unnamed Payee',
    natureOfTransaction: isCancelled
      ? natureOfTransaction
      : natureOfTransaction || 'Disbursement voucher',
    rciAmount: rciNet,
    declaredJevGross: 0,
    grossAmount: 0,
    netAmount: rciNet,
    taxWithheld: 0,
    isCancelled,
    cancellationReason: (params.cancellationReason || '').trim().slice(0, 200),
    templateId: params.suggestedTemplateId || undefined,
    journalLines: [],
    attributes: defaultAttributes(),
    // Cancelled checks never get a JEV, so nothing about them is "pending".
    remarks: isCancelled ? '' : 'pending JEV encoding',
    forceDraft: true,
    mathStatus: isCancelled ? 'not_applicable' : 'pending_jev',
    taxStatus: isCancelled ? 'not_applicable' : 'pending_base',
    documentaryStatus: isCancelled ? 'not_applicable' : 'incomplete',
    clerkReviewStatus: 'draft',
    amountModelVersion: 2,
  };
}

