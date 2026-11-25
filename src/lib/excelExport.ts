import * as XLSX from 'xlsx';
import {
  getDisplayRciNetAmount,
  isLegacyTransaction,
  normalizeAttributeState,
} from './taxAndLedger';
import type { AuditAttributeState, MonthName, ProcurementMeta, TransactionRecord } from '../types/rci';

function attrSymbol(state: AuditAttributeState): string {
  const norm = normalizeAttributeState(state);
  if (norm === 'ok') return '✓';
  if (norm === 'exclamation') return '!';
  if (norm === 'wrong') return '✕';
  return 'N/A';
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
      : [{ accountCode: '', accountTitle: 'Pending JEV encoding', debit: 0, credit: 0 }];

    lines.forEach((line, idx) => {
      const isFirst = idx === 0;
      const mathLabel = legacy ? 'LEGACY' : (tx.mathStatus || 'pending_jev').toUpperCase();
      const taxLabel = legacy ? 'LEGACY' : (tx.taxStatus || 'pending_base').toUpperCase();
      const docLabel = legacy ? 'LEGACY' : (tx.documentaryStatus || 'incomplete').toUpperCase();
      const reviewLabel = (tx.clerkReviewStatus || tx.status).toUpperCase();

      wpRows.push({
        'No.': isFirst ? tx.sequenceNo : '',
        'Month': isFirst ? tx.month : '',
        'ADA/Check Date': isFirst ? tx.adaCheckDate : '',
        'ADA/Check No': isFirst ? tx.adaCheckNo : '',
        'DV No.': isFirst ? tx.dvNo : '',
        'Payee': isFirst ? tx.payeeName : '',
        'JEV Gross Amount': isFirst ? (hasJevLines || tx.grossAmount > 0 ? tx.grossAmount : 'Pending JEV') : '',
        'Total Tax Withheld': isFirst ? (hasJevLines || tx.taxWithheld > 0 ? tx.taxWithheld : 'Pending JEV') : '',
        'RCI Check/ADA Amount (Net)': isFirst ? rciNet : '',
        'Attr 1': isFirst ? attrSymbol(tx.attributes.a1) : '',
        'Attr 2 (E)': isFirst ? attrSymbol(tx.attributes.a2) : '',
        'Attr 3 (L)': isFirst ? attrSymbol(tx.attributes.a3) : '',
        'Attr 4 (A)': isFirst ? attrSymbol(tx.attributes.a4) : '',
        'Attr 5 (S)': isFirst ? attrSymbol(tx.attributes.a5) : '',
        'Attr 6': isFirst ? attrSymbol(tx.attributes.a6) : '',
        'Attr 7': isFirst ? attrSymbol(tx.attributes.a7) : '',
        'Date PO Submitted to COA': isFirst ? tx.procurement?.poSubmittedToCoaDate || '' : '',
        'PO No. / Date': isFirst ? tx.procurement?.poNoDate || '' : '',
        'Method of Procurement': isFirst ? tx.procurement?.procurementMethod || '' : '',
        'PhilGEPS / Date': isFirst ? tx.procurement?.philgepsDate || '' : '',
        'Purchase Request No / Date': isFirst ? tx.procurement?.prNoDate || '' : '',
        'Abstract of Canvass / Date': isFirst ? tx.procurement?.abstractDate || '' : '',
        'RFQ (3)': isFirst ? rfqExportCell(tx.procurement) : '',
        'Inspection & Acceptance Report Date': isFirst ? tx.procurement?.iarDate || '' : '',
        'Official Receipts / Invoice No.': isFirst ? tx.procurement?.orInvoiceRef || '' : '',
        'JEV No. and Date': isFirst ? tx.jevNoDate || (hasJevLines ? '' : 'Pending JEV') : '',
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
      });
    });
  }

  const rciRows = sorted.map((tx) => {
    const legacy = isLegacyTransaction(tx);
    const hasJevLines = tx.journalLines.length > 0;
    return {
      'No.': tx.sequenceNo,
      'Month': tx.month,
      'Date': tx.adaCheckDate,
      'Serial/Check No': tx.adaCheckNo,
      'DV/Payroll No.': tx.dvNo,
      'Payee': tx.payeeName,
      'Nature of Transaction': tx.natureOfTransaction,
      'RCI Check/ADA Amount (Net of Tax)': getDisplayRciNetAmount(tx),
      'JEV Gross Amount': hasJevLines || tx.grossAmount > 0 ? tx.grossAmount : 'Pending JEV',
      'Total Tax Withheld': hasJevLines || tx.taxWithheld > 0 ? tx.taxWithheld : 'Pending JEV',
      'Math Reconciliation': legacy ? 'Legacy' : tx.mathStatus || 'pending_jev',
      'Tax Verification': legacy ? 'Legacy' : tx.taxStatus || 'pending_base',
      'Documentary Status': legacy ? 'Legacy' : tx.documentaryStatus || 'incomplete',
      'Clerk Audit Review': tx.clerkReviewStatus || tx.status,
      'COA Submitted Date': tx.submittedToCoaDate || '',
      'Status': tx.status,
      'Remarks': tx.remarks || '',
    };
  });

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

