import {
  type AccountRole,
  type AccountRoleSource,
  type AuditAttributesMap,
  type ClerkReviewStatus,
  type CoaAccount,
  type DocumentaryVerificationStatus,
  type DvSignatoriesMap,
  type EntryTemplate,
  type GrossBasisOverride,
  type JournalLine,
  type LegacySnapshot,
  type MathReconciliationStatus,
  type PaymentMode,
  type ProcurementMeta,
  type TaxBaseType,
  type TaxMode,
  type TaxRoundingMethod,
  type TaxRulePreset,
  type TaxVerificationComponent,
  type TaxVerificationStatus,
  type TestOfControlsRecord,
  type TestOfControlsStatus,
  type TransactionRecord,
  type TransactionStatus,
  type VerificationAuditCategory,
  type VerificationAuditEvent,
} from '../types/rci';
import { readPair } from './slashPair';

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function applyTaxRounding(value: number, method: TaxRoundingMethod = 'half_up_2dp'): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  const absCents = Math.abs(value) * 100;
  if (method === 'truncate_2dp') {
    return (sign * Math.trunc(absCents + 1e-6)) / 100;
  }
  return (sign * Math.round(absCents + 1e-6)) / 100;
}

/** Tax on an integer-centavos base, returned in centavos (no float drift). */
export function applyTaxToCents(
  baseCents: number,
  rate: number,
  method: TaxRoundingMethod = 'half_up_2dp',
): number {
  const safeRate = Math.min(1, Math.max(0, Number(rate) || 0));
  const rawCents = Math.abs(Number(baseCents) || 0) * safeRate;
  if (!Number.isFinite(rawCents)) return 0;
  if (method === 'truncate_2dp') return Math.trunc(rawCents + 1e-6);
  return Math.round(rawCents + 1e-6);
}

/**
 * Derive the expected tax base for a rule from the JEV gross:
 * VAT-inclusive rules strip the 12% VAT (÷ 1.12); direct-gross rules use it as-is.
 */
export function deriveBaseForRule(
  baseType: TaxBaseType,
  jevGross: number,
): number | null {
  const gross = Number(jevGross);
  if (!Number.isFinite(gross) || gross <= 0) return null;
  if (baseType === 'gross_inclusive_vat' || baseType === 'vatable_sales') {
    return round2(gross / 1.12);
  }
  if (baseType === 'gross_total') return round2(gross);
  return null;
}

/** Human-readable formula for a component card tooltip. */
export function describeTaxComputation(
  comp: Pick<
    TaxVerificationComponent,
    'taxBaseType' | 'taxBaseAmount' | 'applicableRate' | 'roundingMethod'
  >,
  jevGross?: number,
): string {
  const methodLabel =
    comp.roundingMethod === 'truncate_2dp' ? 'Truncate 2dp' : 'Half-Up 2dp';
  const rate = Math.min(1, Math.max(0, Number(comp.applicableRate) || 0));
  const ratePct = round2(rate * 100);
  const typedBase =
    comp.taxBaseAmount !== null &&
    comp.taxBaseAmount !== undefined &&
    Number.isFinite(Number(comp.taxBaseAmount))
      ? round2(Number(comp.taxBaseAmount))
      : null;
  const effectiveBase =
    typedBase ?? (Number(jevGross) > 0 ? deriveBaseForRule(comp.taxBaseType, Number(jevGross)) : null);
  if (effectiveBase === null) {
    return `Enter Base₱ · × ${ratePct}% (${methodLabel})`;
  }
  const expected = applyTaxRounding(effectiveBase * rate, comp.roundingMethod);
  const baseText =
    (comp.taxBaseType === 'gross_inclusive_vat' || comp.taxBaseType === 'vatable_sales') &&
    Number(jevGross) > 0
      ? `₱${formatPeso(Number(jevGross))} ÷ 1.12 = ₱${formatPeso(effectiveBase)}`
      : `₱${formatPeso(effectiveBase)}`;
  return `${baseText} × ${ratePct}% = ₱${formatPeso(expected)} (${methodLabel})`;
}

/** Map a BIR account title (e.g. "Due to BIR - 5%") to the matching rule preset id. */
export function suggestPresetIdForBirTitle(title: string): string | null {
  const text = String(title || '');
  const mapping: Array<[string, string]> = [
    ['5%', 'trp-vat5-vatable-sales'],
    ['3%', 'trp-pt3-direct'],
    ['2%', 'trp-ewt2-vat-excl'],
    ['1%', 'trp-ewt1-vat-excl'],
  ];
  for (const [needle, presetId] of mapping) {
    if (text.includes(needle)) return presetId;
  }
  return null;
}

/** Advisory warning when a direct-gross rule is paired with a VAT-stripped base. */
export function describeBaseRuleWarning(
  comp: Pick<TaxVerificationComponent, 'taxBaseType' | 'taxBaseAmount'>,
  jevGross: number,
): string | null {
  if (comp.taxBaseType !== 'gross_total') return null;
  const base = comp.taxBaseAmount;
  if (base === null || base === undefined || !Number.isFinite(Number(base))) return null;
  if (!Number.isFinite(Number(jevGross)) || Number(jevGross) <= 0) return null;
  if (Number(base) < Number(jevGross) - 0.01) {
    return 'Direct-gross rule expects Base ≈ JEV Gross; current base looks VAT-stripped (÷1.12?).';
  }
  return null;
}

export function formatPeso(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function computeBalanceSummary(lines: JournalLine[]): {
  totalDebit: number;
  totalCredit: number;
  delta: number;
  isBalanced: boolean;
} {
  const totalDebit = round2(lines.reduce((acc, l) => acc + (Number(l.debit) || 0), 0));
  const totalCredit = round2(lines.reduce((acc, l) => acc + (Number(l.credit) || 0), 0));
  const delta = round2(totalDebit - totalCredit);
  return {
    totalDebit,
    totalCredit,
    delta,
    isBalanced: lines.length >= 2 && totalDebit > 0 && Math.abs(delta) < 0.005,
  };
}

export const DEFAULT_TAX_RULE_PRESETS: TaxRulePreset[] = [
  {
    id: 'trp-vat5-vatable-sales',
    name: '5% Withholding VAT (Invoice VATable Sales)',
    version: '2026.1',
    effectiveFrom: '2021-01-01',
    applicableClassification: 'Government Money Payment - 5% Final/Creditable Withholding VAT',
    birReference: 'NIRC Sec. 114(C) / RR 16-2005 / RR 14-2002',
    defaultBirAccountCode: '20201010',
    defaultBirAccountTitle: 'Due to BIR - 5%',
    rate: 0.05,
    defaultTaxBaseType: 'vatable_sales',
    roundingMethod: 'half_up_2dp',
    computationRule: 'Explicit Invoice VATable Sales × 5%',
  },
  {
    id: 'trp-vat5-gross112',
    name: '5% Withholding VAT (VAT-Inclusive Gross / 1.12)',
    version: '2026.1',
    effectiveFrom: '2021-01-01',
    applicableClassification: 'Government Money Payment - 5% Creditable Withholding VAT',
    birReference: 'NIRC Sec. 114(C) / RR 16-2005 Sec. 4.114-2',
    defaultBirAccountCode: '20201010',
    defaultBirAccountTitle: 'Due to BIR - 5%',
    rate: 0.05,
    defaultTaxBaseType: 'gross_inclusive_vat',
    roundingMethod: 'half_up_2dp',
    computationRule: '(VAT-Inclusive Gross ÷ 1.12) × 5%',
  },
  {
    id: 'trp-ewt2-vat-excl',
    name: '2% EWT - Services (VAT-Exclusive Net Base)',
    version: '2026.1',
    effectiveFrom: '2018-01-01',
    applicableClassification: 'Creditable Expanded Withholding Tax - Services (2%)',
    birReference: 'RR 2-98 Sec. 2.57.2 / RR 11-2018',
    defaultBirAccountCode: '20201010',
    defaultBirAccountTitle: 'Due to BIR - 2%',
    rate: 0.02,
    defaultTaxBaseType: 'gross_inclusive_vat',
    roundingMethod: 'half_up_2dp',
    computationRule: 'VAT-Exclusive Service Base × 2%',
  },
  {
    id: 'trp-ewt1-vat-excl',
    name: '1% EWT - Goods (VAT-Exclusive Net Base)',
    version: '2026.1',
    effectiveFrom: '2018-01-01',
    applicableClassification: 'Creditable Expanded Withholding Tax - Goods (1%)',
    birReference: 'RR 2-98 Sec. 2.57.2 / RR 11-2018',
    defaultBirAccountCode: '20201010',
    defaultBirAccountTitle: 'Due to BIR - 1%',
    rate: 0.01,
    defaultTaxBaseType: 'gross_inclusive_vat',
    roundingMethod: 'half_up_2dp',
    computationRule: 'VAT-Exclusive Goods Base × 1%',
  },
  {
    id: 'trp-pt3-direct',
    name: '3% Non-VAT Percentage Tax (Direct Gross)',
    version: '2026.1',
    effectiveFrom: '2023-07-01',
    applicableClassification: 'Government Money Payment - 3% Non-VAT Percentage Tax',
    birReference: 'NIRC Sec. 116 / RR 8-2021',
    defaultBirAccountCode: '20201010',
    defaultBirAccountTitle: 'Due to BIR - 3%',
    rate: 0.03,
    defaultTaxBaseType: 'gross_total',
    roundingMethod: 'half_up_2dp',
    computationRule: 'Non-VAT Gross Amount × 3%',
  },
  {
    id: 'trp-ewt2-direct',
    name: '2% EWT - Non-VAT Services (Direct Gross)',
    version: '2026.1',
    effectiveFrom: '2018-01-01',
    applicableClassification: 'Creditable Expanded Withholding Tax - Non-VAT Services (2%)',
    birReference: 'RR 2-98 Sec. 2.57.2 / RR 11-2018',
    defaultBirAccountCode: '20201010',
    defaultBirAccountTitle: 'Due to BIR - 2%',
    rate: 0.02,
    defaultTaxBaseType: 'gross_total',
    roundingMethod: 'half_up_2dp',
    computationRule: 'Direct Non-VAT Gross × 2%',
  },
  {
    id: 'trp-ewt1-direct',
    name: '1% EWT - Non-VAT Goods (Direct Gross)',
    version: '2026.1',
    effectiveFrom: '2018-01-01',
    applicableClassification: 'Creditable Expanded Withholding Tax - Non-VAT Goods (1%)',
    birReference: 'RR 2-98 Sec. 2.57.2 / RR 11-2018',
    defaultBirAccountCode: '20201010',
    defaultBirAccountTitle: 'Due to BIR - 1%',
    rate: 0.01,
    defaultTaxBaseType: 'gross_total',
    roundingMethod: 'half_up_2dp',
    computationRule: 'Direct Non-VAT Gross × 1%',
  },
];

export function getRatesForTaxMode(
  taxMode: TaxMode,
  vatRate = 0,
  ewtRate = 0,
): { vatRate: number; ewtRate: number; isVatInclusiveBase: boolean } {
  switch (taxMode) {
    case 'none':
      return { vatRate: 0, ewtRate: 0, isVatInclusiveBase: false };
    case 'vat5':
      return { vatRate: 0.05, ewtRate: 0, isVatInclusiveBase: true };
    case 'vat5_ewt2':
      return { vatRate: 0.05, ewtRate: 0.02, isVatInclusiveBase: true };
    case 'vat5_ewt1':
      return { vatRate: 0.05, ewtRate: 0.01, isVatInclusiveBase: true };
    case 'pt3':
      return { vatRate: 0.03, ewtRate: 0, isVatInclusiveBase: false };
    case 'pt3_ewt1':
      return { vatRate: 0.03, ewtRate: 0.01, isVatInclusiveBase: false };
    case 'pt3_ewt2':
      return { vatRate: 0.03, ewtRate: 0.02, isVatInclusiveBase: false };
    case 'ewt2':
      return { vatRate: 0, ewtRate: 0.02, isVatInclusiveBase: false };
    default:
      return {
        vatRate,
        ewtRate,
        isVatInclusiveBase: vatRate >= 0.05,
      };
  }
}

export function formatTaxRuleSummary(
  taxMode: TaxMode,
  vatRate: number,
  ewtRate: number,
): string {
  const rates = getRatesForTaxMode(taxMode, vatRate, ewtRate);
  const v = Math.round(rates.vatRate * 100);
  const e = Math.round(rates.ewtRate * 100);
  if (v > 0 && e > 0) return `${v}% + ${e}%`;
  if (v > 0) return taxMode.startsWith('pt') ? `${v}% PT` : `${v}% VAT`;
  if (e > 0) return `${e}% EWT`;
  return 'None';
}

export function calculateTaxSplit(
  grossAmount: number,
  taxMode: TaxMode,
  vatRate = 0,
  ewtRate = 0,
  debitAccountCode = '20101010',
  debitAccountTitle = 'Accounts Payable',
  creditCashAccountCode = '10102020',
  creditCashAccountTitle = 'Cash in Bank - Local Currency, Current Account',
): {
  netAmount: number;
  taxWithheld: number;
  vatAmount: number;
  ewtAmount: number;
  journalLines: JournalLine[];
} {
  const gross = round2(Math.max(0, grossAmount));
  if (gross <= 0) {
    return {
      netAmount: 0,
      taxWithheld: 0,
      vatAmount: 0,
      ewtAmount: 0,
      journalLines: [
        {
          accountCode: debitAccountCode,
          accountTitle: debitAccountTitle,
          debit: 0,
          credit: 0,
          accountRole: 'settlement_debit',
          roleSource: 'coa_default',
        },
        {
          accountCode: creditCashAccountCode,
          accountTitle: creditCashAccountTitle,
          debit: 0,
          credit: 0,
          accountRole: 'cash_bank_payment',
          roleSource: 'coa_default',
        },
      ],
    };
  }

  const { vatRate: effectiveVat, ewtRate: effectiveEwt, isVatInclusiveBase } =
    getRatesForTaxMode(taxMode, vatRate, ewtRate);

  const taxBase = isVatInclusiveBase ? gross / 1.12 : gross;
  const vatAmount = effectiveVat > 0 ? round2(taxBase * effectiveVat) : 0;
  const ewtAmount = effectiveEwt > 0 ? round2(taxBase * effectiveEwt) : 0;
  const taxWithheld = round2(vatAmount + ewtAmount);
  const netAmount = round2(gross - taxWithheld);

  const lines: JournalLine[] = [
    {
      accountCode: debitAccountCode.slice(0, 30),
      accountTitle: debitAccountTitle.slice(0, 140),
      debit: gross,
      credit: 0,
      accountRole: 'settlement_debit',
      roleSource: 'coa_default',
    },
    {
      accountCode: creditCashAccountCode.slice(0, 30),
      accountTitle: creditCashAccountTitle.slice(0, 140),
      debit: 0,
      credit: netAmount,
      accountRole: 'cash_bank_payment',
      roleSource: 'coa_default',
    },
  ];

  if (vatAmount > 0) {
    lines.push({
      accountCode: '20201010',
      accountTitle: `Due to BIR - ${Math.round(effectiveVat * 100)}%`,
      debit: 0,
      credit: vatAmount,
      accountRole: 'withholding_tax',
      roleSource: 'coa_default',
    });
  }
  if (ewtAmount > 0) {
    lines.push({
      accountCode: '20201010',
      accountTitle: `Due to BIR - ${Math.round(effectiveEwt * 100)}%`,
      debit: 0,
      credit: ewtAmount,
      accountRole: 'withholding_tax',
      roleSource: 'coa_default',
    });
  }

  return {
    netAmount,
    taxWithheld,
    vatAmount,
    ewtAmount,
    journalLines: lines,
  };
}

export function buildLinesFromTemplate(grossAmount: number, template: EntryTemplate) {
  return calculateTaxSplit(
    grossAmount,
    template.taxMode,
    template.vatRate,
    template.ewtRate,
    template.debitAccountCode,
    template.debitAccountTitle,
    template.creditCashAccountCode,
    template.creditCashAccountTitle,
  );
}

const DEBIT_ROLES = new Set<AccountRole>(['settlement_debit', 'unrelated_debit']);
const CREDIT_ROLES = new Set<AccountRole>([
  'withholding_tax',
  'retention_payable',
  'other_deduction',
  'cash_bank_payment',
  'other_liability',
  'other_credit',
]);

function matchCoaAccount(line: JournalLine, catalog: CoaAccount[]): CoaAccount | undefined {
  const code = line.accountCode.trim().toLowerCase();
  const title = line.accountTitle.trim().toLowerCase();
  const exact = catalog.find(
    (a) => a.code.trim().toLowerCase() === code && a.title.trim().toLowerCase() === title,
  );
  if (exact) return exact;

  const byTitle = title
    ? catalog.find((a) => a.title.trim().toLowerCase() === title)
    : undefined;
  if (byTitle) return byTitle;

  const codeMatches = code
    ? catalog.filter((a) => a.code.trim().toLowerCase() === code)
    : [];
  if (codeMatches.length === 1) return codeMatches[0];
  if (codeMatches.length > 1) {
    const distinctClasses = new Set(codeMatches.map((m) => m.accountClass).filter(Boolean));
    if (distinctClasses.size === 1) return codeMatches[0];
  }
  return undefined;
}

export function resolveJournalLineRole(
  line: JournalLine,
  coaAccounts: CoaAccount[] = [],
): { role: AccountRole; source: AccountRoleSource } {
  const isDebitLine = (Number(line.debit) || 0) > 0 && (Number(line.credit) || 0) === 0;
  const isCreditLine = (Number(line.credit) || 0) > 0 && (Number(line.debit) || 0) === 0;

  if (line.accountRole && line.accountRole !== 'unclassified') {
    if (isDebitLine && DEBIT_ROLES.has(line.accountRole)) {
      return {
        role: line.accountRole,
        source: line.roleSource || 'line_override',
      };
    }
    if (isCreditLine && CREDIT_ROLES.has(line.accountRole)) {
      return {
        role: line.accountRole,
        source: line.roleSource || 'line_override',
      };
    }
    if (!isDebitLine && !isCreditLine) {
      return {
        role: line.accountRole,
        source: line.roleSource || 'line_override',
      };
    }
  }

  const matched = matchCoaAccount(line, coaAccounts);
  const source: AccountRoleSource = 'coa_default';

  if (matched) {
    const cls = matched.accountClass;
    if (isDebitLine) {
      if (cls === 'settlement_debit' || cls === 'unrelated_debit') {
        return { role: cls, source };
      }
      if (matched.normalSide === 'debit') {
        return { role: 'settlement_debit', source };
      }
      // Liability accounts remitted on the debit side (e.g., Due to GSIS/Pag-IBIG/PhilHealth)
      if (cls === 'other_liability' || cls === 'retention_payable') {
        return { role: 'settlement_debit', source };
      }
      return { role: 'unclassified', source: 'unclassified' };
    }
    if (isCreditLine) {
      if (cls && CREDIT_ROLES.has(cls)) {
        return { role: cls, source };
      }
      return { role: 'unclassified', source: 'unclassified' };
    }
    if (cls && cls !== 'unclassified') {
      return { role: cls, source };
    }
  }

  return { role: 'unclassified', source: 'unclassified' };
}

export interface ClassifiedJournalLine extends JournalLine {
  lineIndex: number;
  resolvedRole: AccountRole;
  resolvedRoleSource: AccountRoleSource;
}

export type GrossBasisSource =
  | 'agreed'
  | 'declared_jev_gross'
  | 'computed_settlement_debits'
  | 'disagreement_unresolved'
  | 'none';

export interface ReconciliationSummary {
  classifiedLines: ClassifiedJournalLine[];
  unclassifiedLineIndices: number[];
  declaredJevGross: number;
  computedSettlementDebitTotal: number;
  unrelatedDebitTotal: number;
  reconciliationGrossAmount: number | null;
  reconciliationGrossSource: GrossBasisSource;
  grossBasisDisagreement: boolean;
  grossBasisDelta: number;
  grossBasisOverridden: boolean;
  totalWithholdingTax: number;
  totalRetentionPayable: number;
  totalOtherDeductions: number;
  totalApplicableDeductions: number;
  totalCashBankPayment: number;
  totalOtherLiabilities: number;
  totalOtherCredits: number;
  totalDebit: number;
  totalCredit: number;
  journalBalanceDelta: number;
  isBalanced: boolean;
  rciAmount: number;
  expectedNetAmount: number | null;
  rciVsExpectedNetDelta: number | null;
  cashVsRciDelta: number;
  mathStatus: MathReconciliationStatus;
  reasons: string[];
}

export function computeReconciliationSummary(params: {
  rciAmount: number;
  declaredJevGross?: number;
  grossBasisOverride?: GrossBasisOverride;
  journalLines: JournalLine[];
  coaAccounts?: CoaAccount[];
}): ReconciliationSummary {
  const catalog = params.coaAccounts ?? [];
  const rciAmount = round2(Math.max(0, Number(params.rciAmount) || 0));
  const declaredJevGross = round2(Math.max(0, Number(params.declaredJevGross) || 0));

  const classifiedLines: ClassifiedJournalLine[] = params.journalLines.map((line, idx) => {
    const resolved = resolveJournalLineRole(line, catalog);
    return {
      ...line,
      lineIndex: idx,
      resolvedRole: resolved.role,
      resolvedRoleSource: resolved.source,
    };
  });

  const balance = computeBalanceSummary(params.journalLines);

  let computedSettlementDebitTotal = 0;
  let unrelatedDebitTotal = 0;
  let totalWithholdingTax = 0;
  let totalRetentionPayable = 0;
  let totalOtherDeductions = 0;
  let totalCashBankPayment = 0;
  let totalOtherLiabilities = 0;
  let totalOtherCredits = 0;
  const unclassifiedLineIndices: number[] = [];

  for (const line of classifiedLines) {
    const dr = round2(Math.max(0, Number(line.debit) || 0));
    const cr = round2(Math.max(0, Number(line.credit) || 0));
    if (dr === 0 && cr === 0) continue;

    if (line.resolvedRole === 'unclassified' || (dr > 0 && cr > 0)) {
      unclassifiedLineIndices.push(line.lineIndex);
    }

    if (dr > 0) {
      if (line.resolvedRole === 'settlement_debit') {
        computedSettlementDebitTotal = round2(computedSettlementDebitTotal + dr);
      } else if (line.resolvedRole === 'unrelated_debit') {
        unrelatedDebitTotal = round2(unrelatedDebitTotal + dr);
      }
    }

    if (cr > 0) {
      switch (line.resolvedRole) {
        case 'withholding_tax':
          totalWithholdingTax = round2(totalWithholdingTax + cr);
          break;
        case 'retention_payable':
          totalRetentionPayable = round2(totalRetentionPayable + cr);
          break;
        case 'other_deduction':
          totalOtherDeductions = round2(totalOtherDeductions + cr);
          break;
        case 'cash_bank_payment':
          totalCashBankPayment = round2(totalCashBankPayment + cr);
          break;
        case 'other_liability':
          totalOtherLiabilities = round2(totalOtherLiabilities + cr);
          break;
        case 'other_credit':
          totalOtherCredits = round2(totalOtherCredits + cr);
          break;
        default:
          break;
      }
    }
  }

  const totalApplicableDeductions = round2(
    totalWithholdingTax + totalRetentionPayable + totalOtherDeductions,
  );

  // Three-way gross basis resolution
  let reconciliationGrossAmount: number | null = null;
  let reconciliationGrossSource: GrossBasisSource = 'none';
  let grossBasisDisagreement = false;
  let grossBasisDelta = 0;
  let grossBasisOverridden = false;

  if (declaredJevGross > 0 && computedSettlementDebitTotal > 0) {
    grossBasisDelta = round2(declaredJevGross - computedSettlementDebitTotal);
    if (Math.abs(grossBasisDelta) <= 0.01) {
      reconciliationGrossAmount = declaredJevGross;
      reconciliationGrossSource = 'agreed';
    } else {
      grossBasisDisagreement = true;
      if (params.grossBasisOverride?.reason?.trim()) {
        grossBasisOverridden = true;
        reconciliationGrossSource = params.grossBasisOverride.selectedSource;
        reconciliationGrossAmount =
          params.grossBasisOverride.selectedSource === 'declared_jev_gross'
            ? declaredJevGross
            : computedSettlementDebitTotal;
      } else {
        reconciliationGrossSource = 'disagreement_unresolved';
        reconciliationGrossAmount = null;
      }
    }
  } else if (computedSettlementDebitTotal > 0) {
    reconciliationGrossAmount = computedSettlementDebitTotal;
    reconciliationGrossSource = 'computed_settlement_debits';
  } else if (declaredJevGross > 0) {
    reconciliationGrossAmount = declaredJevGross;
    reconciliationGrossSource = 'declared_jev_gross';
  }

  const expectedNetAmount =
    reconciliationGrossAmount !== null
      ? round2(reconciliationGrossAmount - totalApplicableDeductions)
      : null;
  const rciVsExpectedNetDelta =
    expectedNetAmount !== null ? round2(expectedNetAmount - rciAmount) : null;
  const cashVsRciDelta = round2(totalCashBankPayment - rciAmount);

  const reasons: string[] = [];
  let mathStatus: MathReconciliationStatus;

  const hasNonZeroLines = classifiedLines.some((l) => l.debit > 0 || l.credit > 0);
  if (!hasNonZeroLines) {
    mathStatus = 'pending_jev';
    reasons.push('Awaiting JEV encoding (0 JEV lines recorded).');
  } else if (unclassifiedLineIndices.length > 0) {
    mathStatus = 'manual_review';
    reasons.push(
      `${unclassifiedLineIndices.length} journal line(s) are unclassified or have mixed Dr/Cr values.`,
    );
  } else if (grossBasisDisagreement && !grossBasisOverridden) {
    mathStatus = 'manual_review';
    reasons.push(
      `Gross basis disagreement: Declared JEV Gross (₱${formatPeso(declaredJevGross)}) vs Computed Settlement Debits (₱${formatPeso(computedSettlementDebitTotal)}).`,
    );
  } else if (reconciliationGrossAmount === null) {
    mathStatus = 'manual_review';
    reasons.push('No settlement debit basis or declared JEV gross available.');
  } else {
    const netMismatch = rciVsExpectedNetDelta !== null && Math.abs(rciVsExpectedNetDelta) > 0.01;
    const cashMismatch = Math.abs(cashVsRciDelta) > 0.01;
    const balanceMismatch = !balance.isBalanced;

    if (netMismatch) {
      reasons.push(
        `Expected Net (₱${formatPeso(expectedNetAmount ?? 0)}) differs from RCI Amount (₱${formatPeso(rciAmount)}) by ₱${formatPeso(Math.abs(rciVsExpectedNetDelta ?? 0))}.`,
      );
    }
    if (cashMismatch) {
      reasons.push(
        `JEV Cash/Bank Credit (₱${formatPeso(totalCashBankPayment)}) differs from RCI Amount (₱${formatPeso(rciAmount)}) by ₱${formatPeso(Math.abs(cashVsRciDelta))}.`,
      );
    }
    if (balanceMismatch) {
      reasons.push(
        `JEV Total Debit (₱${formatPeso(balance.totalDebit)}) differs from Total Credit (₱${formatPeso(balance.totalCredit)}) by ₱${formatPeso(Math.abs(balance.delta))}.`,
      );
    }

    mathStatus = netMismatch || cashMismatch || balanceMismatch ? 'discrepancy' : 'reconciled';
    if (mathStatus === 'reconciled' && grossBasisDisagreement && grossBasisOverridden) {
      reasons.push('Reconciled using audited Gross Basis override.');
    }
  }

  return {
    classifiedLines,
    unclassifiedLineIndices,
    declaredJevGross,
    computedSettlementDebitTotal,
    unrelatedDebitTotal,
    reconciliationGrossAmount,
    reconciliationGrossSource,
    grossBasisDisagreement,
    grossBasisDelta,
    grossBasisOverridden,
    totalWithholdingTax,
    totalRetentionPayable,
    totalOtherDeductions,
    totalApplicableDeductions,
    totalCashBankPayment,
    totalOtherLiabilities,
    totalOtherCredits,
    totalDebit: balance.totalDebit,
    totalCredit: balance.totalCredit,
    journalBalanceDelta: balance.delta,
    isBalanced: balance.isBalanced,
    rciAmount,
    expectedNetAmount,
    rciVsExpectedNetDelta,
    cashVsRciDelta,
    mathStatus,
    reasons,
  };
}

export interface EvaluatedTaxComponent extends TaxVerificationComponent {
  status: 'verified' | 'variance' | 'pending_base' | 'incomplete_evidence' | 'manual_review';
  notes: string[];
}

export interface TaxVerificationSummary {
  components: EvaluatedTaxComponent[];
  withholdingLineCount: number;
  totalJevBirWithheld: number;
  totalExpectedTax: number;
  totalAllocatedActualTax: number;
  unallocatedBirCredit: number;
  doubleCountingConflict: boolean;
  taxStatus: TaxVerificationStatus;
  reasons: string[];
}

function doesLineMatchComponent(line: ClassifiedJournalLine, comp: TaxVerificationComponent): boolean {
  const codeMatch =
    comp.birAccountCode.trim() !== '' &&
    line.accountCode.trim().toLowerCase() === comp.birAccountCode.trim().toLowerCase();
  const titleComp = comp.birAccountTitle.trim().toLowerCase();
  const titleLine = line.accountTitle.trim().toLowerCase();
  if (codeMatch && titleComp && titleLine === titleComp) return true;
  if (titleComp && titleLine.includes(titleComp)) return true;
  if (codeMatch && !titleComp) return true;
  return false;
}

export function evaluateTaxVerification(params: {
  journalLines: JournalLine[];
  taxComponents?: TaxVerificationComponent[];
  attributes?: AuditAttributesMap;
  coaAccounts?: CoaAccount[];
  explicitNotApplicable?: boolean;
}): TaxVerificationSummary {
  const catalog = params.coaAccounts ?? [];
  const classified: ClassifiedJournalLine[] = params.journalLines.map((line, idx) => {
    const resolved = resolveJournalLineRole(line, catalog);
    return {
      ...line,
      lineIndex: idx,
      resolvedRole: resolved.role,
      resolvedRoleSource: resolved.source,
    };
  });

  const withholdingLines = classified.filter(
    (l) => l.resolvedRole === 'withholding_tax' && (Number(l.credit) || 0) > 0,
  );
  const totalJevBirWithheld = round2(
    withholdingLines.reduce((acc, l) => acc + (Number(l.credit) || 0), 0),
  );
  const rawComponents = params.taxComponents || [];

  const attrs = params.attributes;
  const docFlagged = attrs
    ? ['exclamation', 'wrong', 'flag'].includes(attrs.a1) ||
      ['exclamation', 'wrong', 'flag'].includes(attrs.a5)
    : false;

  // No tax components configured
  if (rawComponents.length === 0) {
    if (withholdingLines.length === 0) {
      return {
        components: [],
        withholdingLineCount: 0,
        totalJevBirWithheld: 0,
        totalExpectedTax: 0,
        totalAllocatedActualTax: 0,
        unallocatedBirCredit: 0,
        doubleCountingConflict: false,
        taxStatus: params.explicitNotApplicable ? 'not_applicable' : 'none_withheld',
        reasons: [
          params.explicitNotApplicable
            ? 'Marked tax-exempt / not applicable.'
            : 'No BIR withholding tax lines recorded in JEV.',
        ],
      };
    }
    return {
      components: [],
      withholdingLineCount: withholdingLines.length,
      totalJevBirWithheld,
      totalExpectedTax: 0,
      totalAllocatedActualTax: 0,
      unallocatedBirCredit: totalJevBirWithheld,
      doubleCountingConflict: false,
      taxStatus: 'pending_base',
      reasons: [
        `JEV contains ₱${formatPeso(totalJevBirWithheld)} Due to BIR credit across ${withholdingLines.length} line(s), awaiting Tax Verification Component breakdown.`,
      ],
    };
  }

  // Track unallocated remaining balance per JEV BIR credit line to strictly prevent double-counting
  const remainingByLine = new Map<number, number>();
  for (const l of withholdingLines) {
    remainingByLine.set(l.lineIndex, round2(l.credit));
  }

  let doubleCountingConflict = false;
  let anyUncertain = false;
  let anyMissingBase = false;
  let anyIncompleteEvidence = false;
  let anyVariance = false;
  const evaluatedComponents: EvaluatedTaxComponent[] = [];
  const reasons: string[] = [];

  for (const comp of rawComponents) {
    const notes: string[] = [];
    const rate = Math.min(1, Math.max(0, Number(comp.applicableRate) || 0));
    const hasBase =
      comp.taxBaseAmount !== undefined &&
      comp.taxBaseAmount !== null &&
      Number.isFinite(Number(comp.taxBaseAmount)) &&
      Number(comp.taxBaseAmount) > 0;

    const expectedWithholding =
      rate === 0
        ? 0
        : hasBase
          ? applyTaxToCents(Math.round(Number(comp.taxBaseAmount) * 100), rate, comp.roundingMethod) / 100
          : 0;

    // Resolve target JEV BIR credit line without reusing already exhausted credits
    let targetLine: ClassifiedJournalLine | undefined;
    if (comp.birLineIndex !== undefined && comp.birLineIndex >= 0) {
      targetLine = withholdingLines.find((l) => l.lineIndex === comp.birLineIndex);
    } else {
      targetLine =
        withholdingLines.find(
          (l) => doesLineMatchComponent(l, comp) && (remainingByLine.get(l.lineIndex) || 0) > 0.005,
        ) || withholdingLines.find((l) => doesLineMatchComponent(l, comp));
    }

    let allocatedActual = 0;
    if (targetLine) {
      const remaining = remainingByLine.get(targetLine.lineIndex) || 0;
      const desiredClaim =
        comp.actualWithholding > 0
          ? round2(comp.actualWithholding)
          : round2(Math.min(remaining, expectedWithholding > 0 ? expectedWithholding : remaining));

      if (desiredClaim > remaining + 0.01) {
        doubleCountingConflict = true;
        notes.push(
          `Double-counting / over-allocation conflict on line #${targetLine.lineIndex + 1} (${targetLine.accountTitle}): claimed ₱${formatPeso(desiredClaim)}, only ₱${formatPeso(remaining)} unallocated.`,
        );
        allocatedActual = round2(remaining);
        remainingByLine.set(targetLine.lineIndex, 0);
      } else {
        allocatedActual = desiredClaim;
        remainingByLine.set(targetLine.lineIndex, round2(Math.max(0, remaining - desiredClaim)));
      }
    } else {
      allocatedActual = round2(Math.max(0, Number(comp.actualWithholding) || 0));
      if (allocatedActual > 0) {
        notes.push('No matching JEV Withholding Tax Payable line found for claimed actual tax.');
      }
    }

    const difference = round2(allocatedActual - expectedWithholding);
    const uncertainClass =
      Boolean(comp.classificationUncertain) ||
      !comp.taxClassification.trim() ||
      comp.taxClassification.trim().toLowerCase() === 'uncertain';
    const evidenceMissing =
      !comp.hasCompleteEvidence || !comp.supportingDocRef.trim() || docFlagged;
    const baseMissing = rate > 0 && !hasBase;

    let compStatus: EvaluatedTaxComponent['status'] = 'verified';
    if (uncertainClass || doubleCountingConflict || (!targetLine && allocatedActual > 0)) {
      compStatus = 'manual_review';
      anyUncertain = true;
      if (uncertainClass) notes.push('Uncertain tax classification requires manual review.');
    } else if (baseMissing) {
      compStatus = 'pending_base';
      anyMissingBase = true;
      notes.push('Missing supporting tax base amount.');
    } else if (evidenceMissing) {
      compStatus = 'incomplete_evidence';
      anyIncompleteEvidence = true;
      notes.push('Incomplete supporting invoice/document evidence.');
    } else if (Math.abs(difference) > 0.01) {
      compStatus = 'variance';
      anyVariance = true;
      notes.push(
        `Variance of ₱${formatPeso(Math.abs(difference))} (Actual ₱${formatPeso(allocatedActual)} vs Expected ₱${formatPeso(expectedWithholding)}).`,
      );
    }

    reasons.push(...notes);
    evaluatedComponents.push({
      ...comp,
      birLineIndex: targetLine ? targetLine.lineIndex : comp.birLineIndex,
      expectedWithholding,
      actualWithholding: allocatedActual,
      difference,
      status: compStatus,
      notes,
    });
  }

  const totalExpectedTax = round2(
    evaluatedComponents.reduce((acc, c) => acc + c.expectedWithholding, 0),
  );
  const totalAllocatedActualTax = round2(
    evaluatedComponents.reduce((acc, c) => acc + c.actualWithholding, 0),
  );
  const unallocatedBirCredit = round2(
    Array.from(remainingByLine.values()).reduce((acc, val) => acc + val, 0),
  );

  if (unallocatedBirCredit > 0.01) {
    reasons.push(
      `₱${formatPeso(unallocatedBirCredit)} of JEV Due to BIR credit is not covered by any tax verification component.`,
    );
  }

  let taxStatus: TaxVerificationStatus = 'verified';
  if (doubleCountingConflict || anyUncertain) {
    taxStatus = 'manual_review';
  } else if (anyMissingBase) {
    taxStatus = 'pending_base';
  } else if (anyIncompleteEvidence) {
    taxStatus = 'incomplete_evidence';
  } else if (anyVariance || unallocatedBirCredit > 0.01) {
    taxStatus = 'variance';
  } else if (params.explicitNotApplicable && totalJevBirWithheld === 0) {
    taxStatus = 'not_applicable';
  }

  return {
    components: evaluatedComponents,
    withholdingLineCount: withholdingLines.length,
    totalJevBirWithheld,
    totalExpectedTax,
    totalAllocatedActualTax,
    unallocatedBirCredit,
    doubleCountingConflict,
    taxStatus,
    reasons,
  };
}

export function evaluateDocumentaryStatus(params: {
  attributes: AuditAttributesMap;
  procurement?: ProcurementMeta;
  taxComponents?: TaxVerificationComponent[];
  isDraft?: boolean;
}): DocumentaryVerificationStatus {
  if (params.isDraft) return 'incomplete';
  if (hasFlaggedAttribute(params.attributes)) return 'lacking';
  if (params.procurement?.rfqStatus === 'under3') return 'lacking';
  const components = params.taxComponents || [];
  if (components.some((c) => !c.hasCompleteEvidence || !c.supportingDocRef.trim())) {
    return 'incomplete';
  }
  return 'complete';
}

export function deriveClerkReviewStatus(
  status: TransactionStatus,
  attributes: AuditAttributesMap,
): ClerkReviewStatus {
  if (status === 'audited') return 'audited';
  if (status === 'draft') return 'draft';
  const attrSummary = countAttributesByType(attributes);
  if (attrSummary.wrong > 0) return 'for_verification';
  if (status === 'lacking' || attrSummary.exclamation > 0) return 'lacking';
  return 'pending_review';
}

export function isLegacyTransaction(tx: Pick<TransactionRecord, 'amountModelVersion'>): boolean {
  return !tx.amountModelVersion || tx.amountModelVersion < 2;
}

export function createLegacySnapshot(
  tx: Pick<TransactionRecord, 'grossAmount' | 'netAmount' | 'taxWithheld' | 'status'>,
  capturedByUid: string,
  capturedAt = new Date().toISOString(),
): LegacySnapshot {
  return {
    grossAmount: round2(Number(tx.grossAmount) || 0),
    netAmount: round2(Number(tx.netAmount) || 0),
    taxWithheld: round2(Number(tx.taxWithheld) || 0),
    status: tx.status,
    capturedAt,
    capturedByUid,
  };
}

export function createVerificationAuditEvent(params: {
  actorUid: string;
  actorName: string;
  category: VerificationAuditCategory;
  reason: string;
  targetRef?: string;
  previousValue?: string;
  newValue?: string;
  timestamp?: string;
}): VerificationAuditEvent {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return {
    id: `aud-${Date.now().toString(36)}-${rand}`,
    timestamp: params.timestamp || new Date().toISOString(),
    actorUid: cleanString(params.actorUid, 128) || 'system',
    actorName: cleanString(params.actorName, 120) || 'Auditor',
    category: params.category,
    targetRef: params.targetRef ? cleanString(params.targetRef, 120) : undefined,
    previousValue: params.previousValue ? cleanString(params.previousValue, 200) : undefined,
    newValue: params.newValue ? cleanString(params.newValue, 200) : undefined,
    reason: cleanString(params.reason, 300) || 'Recorded override',
  };
}

export function getDisplayRciNetAmount(tx: Pick<TransactionRecord, 'rciAmount' | 'netAmount'>): number {
  if (tx.rciAmount !== undefined && Number.isFinite(Number(tx.rciAmount))) {
    return round2(Number(tx.rciAmount));
  }
  return round2(Number(tx.netAmount) || 0);
}

export function isCancelledTransaction(tx: Pick<TransactionRecord, 'isCancelled'>): boolean {
  return Boolean(tx.isCancelled);
}

/** Shared label for JEV slots rendered on a cancelled check. */
export const NO_JEV_CANCELLED_LABEL = 'No JEV (cancelled)';

/**
 * Cancelled checks are exempt from JEV encoding: no Journal Entry Voucher is
 * ever prepared for them, so they must never surface as "pending JEV".
 */
export function isJevExempt(tx: Pick<TransactionRecord, 'isCancelled'>): boolean {
  return isCancelledTransaction(tx);
}

/** True only for live (non-cancelled) rows still awaiting their first JEV. */
export function isJevPending(
  tx: Pick<TransactionRecord, 'isCancelled' | 'journalLines' | 'grossAmount'>,
): boolean {
  if (isJevExempt(tx)) return false;
  return tx.journalLines.length === 0 && (Number(tx.grossAmount) || 0) === 0;
}

export interface LedgerTotalsSummary {
  /** Gross/JEV total of non-cancelled rows. */
  gross: number;
  /** RCI Net total of non-cancelled rows. */
  net: number;
  /** Tax withheld total of non-cancelled rows. */
  tax: number;
  /** Number of cancelled rows excluded from the totals above. */
  cancelledCount: number;
  cancelledNet: number;
  cancelledTax: number;
}

/**
 * Single source of truth for money totals: cancelled checks stay in the record
 * but are excluded from every aggregate (gross, RCI net, tax withheld).
 */
export function summarizeLedgerTotals(rows: TransactionRecord[]): LedgerTotalsSummary {
  let gross = 0;
  let net = 0;
  let tax = 0;
  let cancelledCount = 0;
  let cancelledNet = 0;
  let cancelledTax = 0;

  for (const tx of rows) {
    if (isCancelledTransaction(tx)) {
      cancelledCount += 1;
      cancelledNet = round2(cancelledNet + getDisplayRciNetAmount(tx));
      cancelledTax = round2(cancelledTax + (Number(tx.taxWithheld) || 0));
      continue;
    }
    gross = round2(gross + (Number(tx.grossAmount) || 0));
    net = round2(net + getDisplayRciNetAmount(tx));
    tax = round2(tax + (Number(tx.taxWithheld) || 0));
  }

  return { gross, net, tax, cancelledCount, cancelledNet, cancelledTax };
}

export function defaultAttributes(): AuditAttributesMap {
  return {
    a1: 'ok',
    a2: 'ok',
    a3: 'ok',
    a4: 'ok',
    a5: 'ok',
    a6: 'ok',
    a7: 'ok',
  };
}

export function normalizeAttributeState(
  state: AuditAttributesMap[keyof AuditAttributesMap],
): 'ok' | 'exclamation' | 'wrong' | 'na' {
  if (state === 'flag') return 'exclamation';
  if (state === 'exclamation' || state === 'wrong' || state === 'na') return state;
  return 'ok';
}

export function cycleAttributeState(
  state: AuditAttributesMap[keyof AuditAttributesMap],
): 'ok' | 'exclamation' | 'wrong' | 'na' {
  const norm = normalizeAttributeState(state);
  if (norm === 'ok') return 'exclamation';
  if (norm === 'exclamation') return 'wrong';
  if (norm === 'wrong') return 'na';
  return 'ok';
}

export function hasFlaggedAttribute(attrs: AuditAttributesMap): boolean {
  return Object.values(attrs).some((v) => {
    const n = normalizeAttributeState(v);
    return n === 'exclamation' || n === 'wrong';
  });
}

export function countFlaggedAttributes(attrs: AuditAttributesMap): number {
  return Object.values(attrs).filter((v) => {
    const n = normalizeAttributeState(v);
    return n === 'exclamation' || n === 'wrong';
  }).length;
}

export function countAttributesByType(attrs: AuditAttributesMap): {
  ok: number;
  exclamation: number;
  wrong: number;
  na: number;
} {
  const summary = { ok: 0, exclamation: 0, wrong: 0, na: 0 };
  for (const val of Object.values(attrs)) {
    summary[normalizeAttributeState(val)] += 1;
  }
  return summary;
}

export function incrementCodeString(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '1';
  const match = trimmed.match(/^(.*?)(\d+)$/);
  if (!match) return `${trimmed}-1`;
  const prefix = match[1];
  const digits = match[2];
  const nextNum = (parseInt(digits, 10) + 1).toString().padStart(digits.length, '0');
  return `${prefix}${nextNum}`;
}

export function cleanString(val: string | undefined, maxLen: number): string {
  if (!val) return '';
  return val.trim().slice(0, maxLen);
}

export function sanitizeProcurement(proc?: ProcurementMeta): ProcurementMeta | undefined {
  if (!proc) return undefined;
  const cleaned: ProcurementMeta = {};
  if (proc.poSubmittedToCoaDate?.trim()) cleaned.poSubmittedToCoaDate = proc.poSubmittedToCoaDate.trim().slice(0, 30);

  // Split "No / Date" pairs; legacy combined strings are parsed but never written back.
  const poPair = readPair(proc.poNo, proc.poDate, proc.poNoDate);
  if (poPair.left) cleaned.poNo = poPair.left.slice(0, 60);
  if (poPair.right) cleaned.poDate = poPair.right.slice(0, 20);

  if (proc.procurementMethod?.trim()) cleaned.procurementMethod = proc.procurementMethod.trim().slice(0, 60);
  if (proc.philgepsDate?.trim()) cleaned.philgepsDate = proc.philgepsDate.trim().slice(0, 40);

  const prPair = readPair(proc.prNo, proc.prDate, proc.prNoDate);
  if (prPair.left) cleaned.prNo = prPair.left.slice(0, 60);
  if (prPair.right) cleaned.prDate = prPair.right.slice(0, 20);

  if (proc.abstractDate?.trim()) cleaned.abstractDate = proc.abstractDate.trim().slice(0, 50);
  if (proc.rfqStatus && ['3plus', 'under3', 'na'].includes(proc.rfqStatus)) {
    cleaned.rfqStatus = proc.rfqStatus;
    if (proc.rfqStatus === '3plus') {
      cleaned.rfqCount = '3+';
    }
  } else if (proc.rfqCount?.trim()) {
    cleaned.rfqCount = proc.rfqCount.trim().slice(0, 20);
  }
  if (proc.iarNo?.trim()) cleaned.iarNo = proc.iarNo.trim().slice(0, 60);
  if (proc.iarDate?.trim()) cleaned.iarDate = proc.iarDate.trim().slice(0, 20);
  if (proc.orInvoiceRef?.trim()) cleaned.orInvoiceRef = proc.orInvoiceRef.trim().slice(0, 80);
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Split the OR "No / Date" pair into independently stored fields. The legacy
 * combined `orNoDate` is parsed as a fallback but never written back.
 */
export function sanitizeOrNoPair(
  no?: string | null,
  date?: string | null,
  legacy?: string | null,
): { orNo?: string; orDate?: string } {
  const pair = readPair(no, date, legacy);
  const cleaned: { orNo?: string; orDate?: string } = {};
  if (pair.left) cleaned.orNo = pair.left.slice(0, 60);
  if (pair.right) cleaned.orDate = pair.right.slice(0, 20);
  return cleaned;
}

/**
 * Split the JEV "No / Date" pair into independently stored fields. The legacy
 * combined `jevNoDate` is parsed as a fallback but never written back.
 */
export function sanitizeJevNoPair(
  no?: string | null,
  date?: string | null,
  legacy?: string | null,
): { jevNo?: string; jevDate?: string } {
  const pair = readPair(no, date, legacy);
  const cleaned: { jevNo?: string; jevDate?: string } = {};
  if (pair.left) cleaned.jevNo = pair.left.slice(0, 60);
  if (pair.right) cleaned.jevDate = pair.right.slice(0, 20);
  return cleaned;
}

export function defaultDvSignatories(): DvSignatoriesMap {
  return { a: 'ok', c: 'ok', d: 'ok' };
}

export function sanitizeDvSignatories(input?: DvSignatoriesMap | null): DvSignatoriesMap | undefined {
  if (!input) return undefined;
  const cleaned: DvSignatoriesMap = {};
  (['a', 'c', 'd'] as const).forEach((key) => {
    const raw = input[key];
    if (raw === undefined || raw === null) return;
    cleaned[key] = normalizeAttributeState(raw);
  });
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

const TEST_OF_CONTROLS_STATUSES: TestOfControlsStatus[] = ['allowed', 'suspended', 'disallowed'];

export function sanitizeTestOfControls(
  input?: TestOfControlsRecord | null,
): TestOfControlsRecord | undefined {
  if (!input) return undefined;
  const cleaned: TestOfControlsRecord = {};
  if (input.status && TEST_OF_CONTROLS_STATUSES.includes(input.status)) {
    cleaned.status = input.status;
  }
  if (typeof input.particulars === 'string' && input.particulars.trim()) {
    cleaned.particulars = input.particulars.trim().slice(0, 2000);
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/** Normalize a stored payment mode; anything but a case-insensitive 'ada' is treated as 'check'. */
export function normalizePaymentMode(value?: string | null): PaymentMode {
  return String(value ?? '').trim().toLowerCase() === 'ada' ? 'ada' : 'check';
}

export function paymentModeLabel(value?: string | null): 'Check' | 'ADA' {
  return normalizePaymentMode(value) === 'ada' ? 'ADA' : 'Check';
}

const ALL_ACCOUNT_ROLES = new Set<AccountRole>([
  'settlement_debit',
  'unrelated_debit',
  'withholding_tax',
  'retention_payable',
  'other_deduction',
  'cash_bank_payment',
  'other_liability',
  'other_credit',
  'unclassified',
]);

const ALL_ROLE_SOURCES = new Set<AccountRoleSource>([
  'line_override',
  'coa_default',
  'system_default',
  'unclassified',
]);

export function sanitizeJournalLines(
  lines: JournalLine[],
  options?: { allowEmpty?: boolean },
): JournalLine[] {
  const sliced = lines.slice(0, 20).map((line) => {
    const cleaned: JournalLine = {
      accountCode: cleanString(line.accountCode, 30) || '00000000',
      accountTitle: cleanString(line.accountTitle, 140) || 'Unspecified Account',
      debit: round2(Math.max(0, Number(line.debit) || 0)),
      credit: round2(Math.max(0, Number(line.credit) || 0)),
    };
    if (line.accountRole && ALL_ACCOUNT_ROLES.has(line.accountRole)) {
      cleaned.accountRole = line.accountRole;
    }
    if (line.roleSource && ALL_ROLE_SOURCES.has(line.roleSource)) {
      cleaned.roleSource = line.roleSource;
    }
    return cleaned;
  });
  if (sliced.length === 0 && !options?.allowEmpty) {
    sliced.push({
      accountCode: '20101010',
      accountTitle: 'Accounts Payable',
      debit: 0,
      credit: 0,
      accountRole: 'settlement_debit',
      roleSource: 'coa_default',
    });
  }
  return sliced;
}

const VALID_BASE_TYPES = new Set<TaxBaseType>([
  'vatable_sales',
  'gross_inclusive_vat',
  'gross_total',
  'contract_or_custom',
  'exempt_excluded',
]);

export function sanitizeTaxComponents(
  components?: TaxVerificationComponent[],
): TaxVerificationComponent[] {
  if (!components || components.length === 0) return [];
  return components.slice(0, 12).map((c) => {
    const rate = Math.min(1, Math.max(0, Number(c.applicableRate) || 0));
    const rounding: TaxRoundingMethod =
      c.roundingMethod === 'truncate_2dp' ? 'truncate_2dp' : 'half_up_2dp';
    const baseAmount =
      c.taxBaseAmount !== undefined && c.taxBaseAmount !== null && Number.isFinite(Number(c.taxBaseAmount))
        ? round2(Math.max(0, Number(c.taxBaseAmount)))
        : null;
    const expected = baseAmount !== null ? applyTaxToCents(Math.round(baseAmount * 100), rate, rounding) / 100 : 0;
    const actual = round2(Math.max(0, Number(c.actualWithholding) || 0));
    const cleaned: TaxVerificationComponent = {
      id: cleanString(c.id, 64) || `tax-${Date.now().toString(36)}`,
      birAccountCode: cleanString(c.birAccountCode, 30) || '20201010',
      birAccountTitle: cleanString(c.birAccountTitle, 140) || 'Due to BIR',
      taxClassification: cleanString(c.taxClassification, 140),
      applicableRate: rate,
      supportingDocRef: cleanString(c.supportingDocRef, 120),
      hasCompleteEvidence: Boolean(c.hasCompleteEvidence),
      classificationUncertain: Boolean(c.classificationUncertain),
      taxBaseType: VALID_BASE_TYPES.has(c.taxBaseType) ? c.taxBaseType : 'contract_or_custom',
      taxBaseAmount: baseAmount,
      roundingMethod: rounding,
      computationRule: cleanString(c.computationRule, 200),
      expectedWithholding: expected,
      actualWithholding: actual,
      difference: round2(actual - expected),
    };
    if (c.birLineIndex !== undefined && Number.isInteger(c.birLineIndex) && c.birLineIndex >= 0) {
      cleaned.birLineIndex = c.birLineIndex;
    }
    if (c.rulePresetId?.trim()) cleaned.rulePresetId = cleanString(c.rulePresetId, 80);
    if (c.ruleVersion?.trim()) cleaned.ruleVersion = cleanString(c.ruleVersion, 30);
    if (c.ruleEffectiveDate?.trim()) cleaned.ruleEffectiveDate = cleanString(c.ruleEffectiveDate, 30);
    if (c.birReference?.trim()) cleaned.birReference = cleanString(c.birReference, 120);
    if (c.ruleOverrideHistory && c.ruleOverrideHistory.length > 0) {
      cleaned.ruleOverrideHistory = c.ruleOverrideHistory.slice(-10).map((h) => ({
        timestamp: cleanString(h.timestamp, 40),
        actorUid: cleanString(h.actorUid, 128),
        actorName: cleanString(h.actorName, 120),
        previousSummary: cleanString(h.previousSummary, 200),
        newSummary: cleanString(h.newSummary, 200),
        reason: cleanString(h.reason, 200),
      }));
    }
    return cleaned;
  });
}

export function sanitizeVerificationAuditTrail(
  events?: VerificationAuditEvent[],
): VerificationAuditEvent[] {
  if (!events || events.length === 0) return [];
  return events.slice(-50).map((e) => {
    const cleaned: VerificationAuditEvent = {
      id: cleanString(e.id, 64) || 'aud-evt',
      timestamp: cleanString(e.timestamp, 40) || new Date().toISOString(),
      actorUid: cleanString(e.actorUid, 128) || 'system',
      actorName: cleanString(e.actorName, 120) || 'Auditor',
      category: e.category,
      reason: cleanString(e.reason, 300) || 'Recorded override',
    };
    if (e.targetRef?.trim()) cleaned.targetRef = cleanString(e.targetRef, 120);
    if (e.previousValue?.trim()) cleaned.previousValue = cleanString(e.previousValue, 200);
    if (e.newValue?.trim()) cleaned.newValue = cleanString(e.newValue, 200);
    return cleaned;
  });
}

