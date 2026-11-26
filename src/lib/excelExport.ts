import * as XLSX from 'xlsx';
import {
  formatPeso,
  getDisplayRciNetAmount,
  isLegacyTransaction,
  normalizeAttributeState,
  paymentModeLabel,
  summarizeLedgerTotals,
} from './taxAndLedger';
import { renderSlashPair } from './slashPair';
import type { AuditAttributeState, MonthName, ProcurementMeta, TransactionRecord } from '../types/rci';

function attrSymbol(state: AuditAttributeState): string {
  const norm = normalizeAttributeState(state);
  if (norm === 'ok') return '✓';
  if (norm === 'exclamation') return '!';
  if (norm === 'wrong') return '✕';
  return 'N/A';
}

function tocStatusLabel(tx: TransactionRecord): string {
  const status = tx.testOfControls?.status;
  if (!status) return '';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function cancelledCheckFlag(tx: TransactionRecord): string {
  return tx.isCancelled ? 'CANCELLED' : '';
}

function cancelledCheckEvidence(tx: TransactionRecord): string {
  if (!tx.isCancelled) return '';
  if (tx.cancelledCheckAttachment === 'attached') return 'Attached';
  if (tx.cancelledCheckAttachment === 'missing') return 'Missing';
  if (tx.cancelledCheckAttachment === 'na') return 'N/A';
  return 'Pending';
}

/**
 * Cancelled checks never receive a JEV, so their money slots read as N/A
 * instead of "Pending JEV" (which would imply outstanding encoding work).
 */
function jevExportCell(tx: TransactionRecord, hasJevLines: boolean, value: number): string | number {
  if (hasJevLines || value > 0) return value;
  return tx.isCancelled ? 'N/A (cancelled)' : 'Pending JEV';
}

function rfqExportCell(proc?: ProcurementMeta): string {
  if (!proc) return '';
  if (proc.rfqStatus === '3plus') return '✓';
  if (proc.rfqStatus === 'under3' || proc.rfqStatus === 'na') return '';
  const num = parseInt(proc.rfqCount || '', 10);
  if (!Number.isNaN(num) && num >= 3) return '✓';
  if (proc.rfqCount === '3+' || proc.rfqCount === '✔') return '✓';
  return '';
}

export function buildWorkingPaperExportData(transactions: TransactionRecord[]): {
  wpRows: Array<Record<string, string | number>>;
  rciRows: Array<Record<string, string | number>>;
} {
  const wpRows: Array<Record<string, string | number>> = [];
  const sorted = [...transactions].sort((a, b) => a.sequenceNo - b.sequenceNo);

  for (const tx of sorted) {
    const legacy = isLegacyTransaction(tx);
    const hasJevLines = tx.journalLines.length > 0;
    const rciNet = getDisplayRciNetAmount(tx);
    const lines = hasJevLines
      ? tx.journalLines
      : [
          {
            accountCode: '',
            accountTitle: tx.isCancelled ? 'No JEV (cancelled)' : 'Pending JEV encoding',
            debit: 0,
            credit: 0,
          },
        ];

    lines.forEach((line, idx) => {
      const isFirst = idx === 0;
      const mathLabel = tx.isCancelled
        ? 'N/A (CANCELLED)'
        : legacy
          ? 'LEGACY'
          : (tx.mathStatus || 'pending_jev').toUpperCase();
      const taxLabel = tx.isCancelled
        ? 'N/A (CANCELLED)'
        : legacy
          ? 'LEGACY'
          : (tx.taxStatus || 'pending_base').toUpperCase();
      const docLabel = tx.isCancelled
        ? 'N/A (CANCELLED)'
        : legacy
          ? 'LEGACY'
          : (tx.documentaryStatus || 'incomplete').toUpperCase();
      const reviewLabel = (tx.clerkReviewStatus || tx.status).toUpperCase();

      wpRows.push({
        'No.': isFirst ? tx.sequenceNo : '',
        'Month': isFirst ? tx.month : '',
        'ADA/Check Date': isFirst ? tx.adaCheckDate : '',
        'ADA/Check No': isFirst ? tx.adaCheckNo : '',
        'Payment Mode': isFirst ? paymentModeLabel(tx.paymentMode) : '',
        'DV No.': isFirst ? tx.dvNo : '',
        'Payee': isFirst ? tx.payeeName : '',
        'JEV Gross Amount': isFirst ? jevExportCell(tx, hasJevLines, tx.grossAmount) : '',
        'Total Tax Withheld': isFirst ? jevExportCell(tx, hasJevLines, tx.taxWithheld) : '',
        'RCI Check/ADA Amount (Net)': isFirst ? rciNet : '',
        'Attr 1': isFirst ? attrSymbol(tx.attributes.a1) : '',
        'Attr 2 (E)': isFirst ? attrSymbol(tx.attributes.a2) : '',
        'Attr 3 (L)': isFirst ? attrSymbol(tx.attributes.a3) : '',
        'Attr 4 (A)': isFirst ? attrSymbol(tx.attributes.a4) : '',
        'Attr 5 (S)': isFirst ? attrSymbol(tx.attributes.a5) : '',
        'Attr 6': isFirst ? attrSymbol(tx.attributes.a6) : '',
        'Attr 7': isFirst ? attrSymbol(tx.attributes.a7) : '',
        'DV Sig. A': isFirst ? attrSymbol(tx.dvSignatories?.a || 'ok') : '',
        'DV Sig. C': isFirst ? attrSymbol(tx.dvSignatories?.c || 'ok') : '',
        'DV Sig. D': isFirst ? attrSymbol(tx.dvSignatories?.d || 'ok') : '',
        'Date PO Submitted to COA': isFirst ? tx.procurement?.poSubmittedToCoaDate || '' : '',
        'PO No. / Date': isFirst
          ? renderSlashPair(tx.procurement?.poNo, tx.procurement?.poDate, tx.procurement?.poNoDate)
          : '',
        'Method of Procurement': isFirst ? tx.procurement?.procurementMethod || '' : '',
        'PhilGEPS / Date': isFirst ? tx.procurement?.philgepsDate || '' : '',
        'Purchase Request No / Date': isFirst
          ? renderSlashPair(tx.procurement?.prNo, tx.procurement?.prDate, tx.procurement?.prNoDate)
          : '',
        'Abstract of Canvass / Date': isFirst ? tx.procurement?.abstractDate || '' : '',
        'RFQ (3)': isFirst ? rfqExportCell(tx.procurement) : '',
        'Inspection & Acceptance Report / Date': isFirst
          ? renderSlashPair(tx.procurement?.iarNo, tx.procurement?.iarDate, undefined)
          : '',
        'Official Receipts / Invoice No.': isFirst ? tx.procurement?.orInvoiceRef || '' : '',
        'Test of Controls': isFirst ? tocStatusLabel(tx) : '',
        'Test of Controls Particulars': isFirst ? tx.testOfControls?.particulars || '' : '',
        'JEV No. and Date': isFirst
          ? tx.jevNoDate ||
            (tx.isCancelled ? 'N/A (cancelled)' : hasJevLines ? '' : 'Pending JEV')
          : '',
        'Account Code': line.accountCode,
        'Account Title': line.accountTitle,
        'Account Role': line.accountRole || '',
        'Dr Amount': line.debit || '',
        'Cr Amount': line.credit || '',
        'Math Reconciliation': isFirst ? mathLabel : '',
        'Tax Verification': isFirst ? taxLabel : '',
        'Documentary Status': isFirst ? docLabel : '',
        'Clerk Audit Review': isFirst ? reviewLabel : '',
        'Status': isFirst ? tx.status.toUpperCase() : '',
        'Reasons/Remarks': isFirst ? tx.remarks || '' : '',
        'Cancelled Check': isFirst ? cancelledCheckFlag(tx) : '',
        'Cancellation Reason': isFirst ? (tx.isCancelled ? tx.cancellationReason || '' : '') : '',
        'Original Cancelled Check': isFirst ? cancelledCheckEvidence(tx) : '',
      });
    });
  }

  const rciRows: Array<Record<string, string | number>> = sorted.map((tx) => {
    const legacy = isLegacyTransaction(tx);
    const hasJevLines = tx.journalLines.length > 0;
    return {
      'No.': tx.sequenceNo,
      'Month': tx.month,
      'Date': tx.adaCheckDate,
      'Serial/Check No': tx.adaCheckNo,
      'Payment Mode': paymentModeLabel(tx.paymentMode),
      'DV/Payroll No.': tx.dvNo,
      'Payee': tx.payeeName,
      'Nature of Transaction': tx.natureOfTransaction,
      'RCI Check/ADA Amount (Net of Tax)': getDisplayRciNetAmount(tx),
      'JEV Gross Amount': jevExportCell(tx, hasJevLines, tx.grossAmount),
      'Total Tax Withheld': jevExportCell(tx, hasJevLines, tx.taxWithheld),
      'Math Reconciliation': tx.isCancelled
        ? 'N/A (cancelled)'
        : legacy
          ? 'Legacy'
          : tx.mathStatus || 'pending_jev',
      'Tax Verification': tx.isCancelled
        ? 'N/A (cancelled)'
        : legacy
          ? 'Legacy'
          : tx.taxStatus || 'pending_base',
      'Documentary Status': tx.isCancelled
        ? 'N/A (cancelled)'
        : legacy
          ? 'Legacy'
          : tx.documentaryStatus || 'incomplete',
      'Clerk Audit Review': tx.clerkReviewStatus || tx.status,
      'COA Submitted Date': tx.submittedToCoaDate || '',
      'Status': tx.status,
      'Remarks': tx.remarks || '',
      'Cancelled Check': cancelledCheckFlag(tx),
      'Cancellation Reason': tx.isCancelled ? tx.cancellationReason || '' : '',
      'Original Cancelled Check': cancelledCheckEvidence(tx),
    };
  });

  // Totals row keeps readers from double-counting cancelled rows. It only uses
  // keys already present in the header so existing row indexes stay stable.
  if (rciRows.length > 0) {
    const totals = summarizeLedgerTotals(sorted);
    rciRows.push({
      'No.': 'TOTALS (excl. cancelled)',
      'RCI Check/ADA Amount (Net of Tax)': totals.net,
      'JEV Gross Amount': totals.gross,
      'Total Tax Withheld': totals.tax,
      'Remarks':
        totals.cancelledCount > 0
          ? `${totals.cancelledCount} cancelled row(s) excluded (₱${formatPeso(totals.cancelledNet)})`
          : 'No cancelled rows excluded',
    });
  }

  return { wpRows, rciRows };
}

export function exportWorkingPaperWorkbook(
  workspaceName: string,
  month: MonthName | 'All',
  transactions: TransactionRecord[],
): void {
  const wb = XLSX.utils.book_new();
  const { wpRows, rciRows } = buildWorkingPaperExportData(transactions);

  const wsWorkingPaper = XLSX.utils.json_to_sheet(wpRows);
  XLSX.utils.book_append_sheet(wb, wsWorkingPaper, month === 'All' ? 'Working Paper' : `${month} WP`);

  const wsRci = XLSX.utils.json_to_sheet(rciRows);
  XLSX.utils.book_append_sheet(wb, wsRci, 'RCI Summary');

  const safeName = workspaceName.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const fileName = `${safeName}_${month}_RCI_Working_Paper.xlsx`;
  XLSX.writeFile(wb, fileName);
}

