import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  clearTokens,
  getAccessToken,
  logApiError,
  wrapTimestamp,
  type AuthUser,
} from '../lib/api';
import { disableGoogleAutoSelect, signInWithGooglePopup } from '../lib/googleAuth';
import { getEffectiveTemplateKeywordsString } from '../lib/batchImportParser';
import {
  cleanString,
  computeBalanceSummary,
  computeReconciliationSummary,
  createLegacySnapshot,
  createVerificationAuditEvent,
  defaultAttributes,
  DEFAULT_TAX_RULE_PRESETS,
  deriveClerkReviewStatus,
  evaluateDocumentaryStatus,
  evaluateTaxVerification,
  hasFlaggedAttribute,
  isLegacyTransaction,
  round2,
  sanitizeJournalLines,
  sanitizeProcurement,
  sanitizeTaxComponents,
  sanitizeVerificationAuditTrail,
} from '../lib/taxAndLedger';
import {
  type AccountRole,
  type AuditAttributesMap,
  type ClerkReviewStatus,
  type CoaAccount,
  type DocumentaryVerificationStatus,
  type EntryTemplate,
  type GrossBasisOverride,
  type JournalLine,
  type LegacySnapshot,
  type MathReconciliationStatus,
  type MonthName,
  type PayeeRecord,
  type ProcurementMeta,
  type TaxRulePreset,
  type TaxVerificationComponent,
  type TaxVerificationStatus,
  type TransactionRecord,
  type TransactionStatus,
  type UserWorkspaceLink,
  type VerificationAuditEvent,
  type Workspace,
  type WorkspaceCoaAccount,
  type WorkspaceInvite,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceTaxPreset,
} from '../types/rci';

export interface CreateTransactionInput {
  month: MonthName;
  sequenceNo: number;
  adaCheckDate: string;
  adaCheckNo: string;
  dvNo: string;
  dateReceived?: string;
  orNoDate?: string;
  asaNo?: string;
  jevNoDate?: string;
  payeeName: string;
  natureOfTransaction: string;
  grossAmount: number;
  netAmount: number;
  taxWithheld: number;
  rciAmount?: number;
  declaredJevGross?: number;
  grossBasisOverride?: GrossBasisOverride;
  taxComponents?: TaxVerificationComponent[];
  mathStatus?: MathReconciliationStatus;
  taxStatus?: TaxVerificationStatus;
  documentaryStatus?: DocumentaryVerificationStatus;
  clerkReviewStatus?: ClerkReviewStatus;
  verificationAuditTrail?: VerificationAuditEvent[];
  amountModelVersion?: number;
  legacySnapshot?: LegacySnapshot;
  templateId?: string;
  journalLines: JournalLine[];
  attributes?: AuditAttributesMap;
  procurement?: ProcurementMeta;
  remarks?: string;
  forceDraft?: boolean;
  submittedToCoaDate?: string;
}

interface AuthWorkspaceContextValue {
  user: AuthUser | null;
  authLoading: boolean;
  workspaceLoading: boolean;
  signInWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  workspaces: UserWorkspaceLink[];
  activeWorkspace: Workspace | null;
  activeRole: WorkspaceRole;
  switchWorkspace: (workspaceId: string) => void;
  createWorkspace: (
    name: string,
    agencyCode: string,
    fiscalYear: number,
    options?: { carryForwardFromCurrent?: boolean },
  ) => Promise<void>;
  getWorkspaceDetails: (workspaceId: string) => Promise<Workspace | null>;
  updateWorkspace: (
    workspaceId: string,
    patch: {
      name: string;
      agencyCode: string;
      fiscalYear: number;
      defaultCheckPrefix?: string;
      defaultDvPrefix?: string;
    },
  ) => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  transactions: TransactionRecord[];
  templates: EntryTemplate[];
  payees: PayeeRecord[];
  coaAccounts: CoaAccount[];
  customCoaAccounts: WorkspaceCoaAccount[];
  taxPresets: TaxRulePreset[];
  customTaxPresets: WorkspaceTaxPreset[];
  members: WorkspaceMember[];
  sentInvites: WorkspaceInvite[];
  pendingInvitesForUser: WorkspaceInvite[];
  acceptInvite: (invite: WorkspaceInvite) => Promise<void>;
  inviteMember: (email: string, role: 'auditor' | 'encoder') => Promise<void>;
  createTransaction: (input: CreateTransactionInput) => Promise<string>;
  batchCreateTransactions: (inputs: CreateTransactionInput[]) => Promise<number>;
  updateTransaction: (txId: string, patch: Partial<TransactionRecord>) => Promise<void>;
  upgradeLegacyTransactionToV2: (tx: TransactionRecord, reason: string) => Promise<void>;
  deleteTransaction: (txId: string) => Promise<void>;
  createTemplate: (tpl: Omit<EntryTemplate, 'id' | 'workspaceId' | 'authorizedUids' | 'createdByUid' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateTemplate: (templateId: string, patch: Partial<Pick<EntryTemplate, 'name' | 'shortcutKey' | 'category' | 'defaultNature' | 'taxMode' | 'vatRate' | 'ewtRate' | 'requiresProcurement' | 'debitAccountCode' | 'debitAccountTitle' | 'creditCashAccountCode' | 'creditCashAccountTitle' | 'autoMatchKeywords'>>) => Promise<void>;
  deleteTemplate: (templateId: string) => Promise<void>;
  createCoaAccount: (acct: { code: string; title: string; normalSide: 'debit' | 'credit'; accountClass?: AccountRole }) => Promise<void>;
  batchCreateCoaAccounts: (items: Array<{ code: string; title: string; normalSide: 'debit' | 'credit'; accountClass?: AccountRole }>) => Promise<number>;
  updateCoaAccount: (accountId: string, patch: { code?: string; title?: string; normalSide?: 'debit' | 'credit'; accountClass?: AccountRole }) => Promise<void>;
  deleteCoaAccount: (accountId: string) => Promise<void>;
  upsertTaxPreset: (preset: TaxRulePreset, overrideReason?: string) => Promise<void>;
  deleteTaxPreset: (presetId: string) => Promise<void>;
  ensurePayeeExists: (name: string, defaultTemplateId?: string, defaultNature?: string, updateExistingTemplate?: boolean) => Promise<void>;
  upsertPayee: (payee: { id?: string; name: string; tin?: string; defaultTemplateId?: string; defaultNature?: string }) => Promise<void>;
  deletePayee: (payeeId: string) => Promise<void>;
  batchEnsurePayees: (items: Array<{ name: string; defaultTemplateId?: string; defaultNature?: string }>) => Promise<void>;
  syncWorkspaceAccessToRecords: () => Promise<void>;
  selectedMonth: MonthName;
  setSelectedMonth: (month: MonthName) => void;
}

const AuthWorkspaceContext = createContext<AuthWorkspaceContextValue | null>(null);

let idSeqCounter = 0;
function makeId(prefix: string): string {
  idSeqCounter = (idSeqCounter + 1) % 100000;
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${idSeqCounter.toString(36)}-${rand}`.replace(
    /[^a-zA-Z0-9_-]/g,
    '',
  );
}

const VALID_TAX_MODES = new Set<EntryTemplate['taxMode']>([
  'none',
  'vat5',
  'vat5_ewt2',
  'vat5_ewt1',
  'pt3',
  'pt3_ewt1',
  'pt3_ewt2',
  'ewt2',
  'custom',
]);

type Raw = Record<string, unknown>;

/** Map API ISO timestamps to Firestore-Timestamp-compatible { toDate } shims. */
function withTimestamps<T>(raw: Raw): T {
  return {
    ...raw,
    createdAt: wrapTimestamp(raw.createdAt as string | undefined),
    updatedAt: wrapTimestamp(raw.updatedAt as string | undefined),
  } as T;
}

function mapMember(raw: Raw): WorkspaceMember {
  return {
    ...(raw as unknown as WorkspaceMember),
    joinedAt: wrapTimestamp(raw.joinedAt as string | undefined),
    updatedAt: wrapTimestamp(raw.updatedAt as string | undefined),
  };
}

interface BatchResult {
  created?: number;
  count: number;
  records: Raw[];
}

export const AuthWorkspaceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  const [workspaceLinks, setWorkspaceLinks] = useState<UserWorkspaceLink[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('rci_active_workspace_id');
    } catch {
      return null;
    }
  });
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);

  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [templates, setTemplates] = useState<EntryTemplate[]>([]);
  const [payees, setPayees] = useState<PayeeRecord[]>([]);
  const [customCoaAccounts, setCustomCoaAccounts] = useState<WorkspaceCoaAccount[]>([]);
  const [customTaxPresets, setCustomTaxPresets] = useState<WorkspaceTaxPreset[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [sentInvites, setSentInvites] = useState<WorkspaceInvite[]>([]);
  const [pendingInvitesForUser, setPendingInvitesForUser] = useState<WorkspaceInvite[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<MonthName>('January');
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [transactionsLoaded, setTransactionsLoaded] = useState(false);
  const [coaLoaded, setCoaLoaded] = useState(false);
  const workspaceLinksRef = React.useRef<UserWorkspaceLink[]>([]);
  workspaceLinksRef.current = workspaceLinks;

  const signInWithGoogle = useCallback(async () => {
    const signedIn = await signInWithGooglePopup();
    setUser(signedIn);
  }, []);

  const logout = useCallback(async () => {
    clearTokens();
    disableGoogleAutoSelect();
    setUser(null);
    setActiveWorkspace(null);
    setWorkspaceLinks([]);
    setTransactions([]);
    setTemplates([]);
    setPayees([]);
    setCustomCoaAccounts([]);
    setCustomTaxPresets([]);
    setMembers([]);
    setSentInvites([]);
    setPendingInvitesForUser([]);
  }, []);

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId !== activeWorkspaceId) {
        setTransactions([]);
        setTemplates([]);
        setPayees([]);
        setCustomCoaAccounts([]);
        setCustomTaxPresets([]);
        setMembers([]);
        setSentInvites([]);
        setTemplatesLoaded(false);
        setTransactionsLoaded(false);
        setCoaLoaded(false);
      }
      setActiveWorkspaceId(workspaceId);
      try {
        localStorage.setItem('rci_active_workspace_id', workspaceId);
      } catch {
        // ignore storage failure
      }
    },
    [activeWorkspaceId],
  );

  // Auth bootstrap: restore session from stored JWT
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!getAccessToken()) {
        setUser(null);
        setAuthLoading(false);
        return;
      }
      try {
        const me = await apiGet<AuthUser>('/me/');
        if (!cancelled) setUser(me);
      } catch {
        clearTokens();
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshWorkspaceLinks = useCallback(async () => {
    const links = await apiGet<UserWorkspaceLink[]>('/me/workspaces/');
    setWorkspaceLinks(links);
    return links;
  }, []);

  const refreshPendingInvites = useCallback(async () => {
    const invites = await apiGet<WorkspaceInvite[]>('/me/invites/');
    setPendingInvitesForUser(invites);
  }, []);

  // Workspace links (replaces userWorkspaces onSnapshot)
  useEffect(() => {
    if (!user) {
      setWorkspaceLinks([]);
      return;
    }
    let cancelled = false;
    setWorkspaceLoading(true);
    void refreshWorkspaceLinks()
      .catch((error) => logApiError(error, 'list', '/me/workspaces/'))
      .finally(() => {
        if (!cancelled) setWorkspaceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, refreshWorkspaceLinks]);

  // Pending invites for the signed-in email (replaces collectionGroup onSnapshot)
  useEffect(() => {
    if (!user || !user.email || !user.emailVerified) {
      setPendingInvitesForUser([]);
      return;
    }
    void refreshPendingInvites().catch(() => setPendingInvitesForUser([]));
  }, [user, refreshPendingInvites]);

  const refreshTransactions = useCallback(async (wsId: string) => {
    const list = await apiGet<Raw[]>(`/workspaces/${wsId}/transactions/`);
    const mapped = list.map((raw) => withTimestamps<TransactionRecord>(raw));
    mapped.sort((a, b) => a.sequenceNo - b.sequenceNo);
    setTransactions(mapped);
    setTransactionsLoaded(true);
  }, []);

  const refreshTemplates = useCallback(async (wsId: string) => {
    const list = await apiGet<Raw[]>(`/workspaces/${wsId}/templates/`);
    const mapped = list.map((raw) => withTimestamps<EntryTemplate>(raw));
    mapped.sort((a, b) => a.shortcutKey.localeCompare(b.shortcutKey));
    setTemplates(mapped);
    setTemplatesLoaded(true);
  }, []);

  const refreshPayees = useCallback(async (wsId: string) => {
    const list = await apiGet<Raw[]>(`/workspaces/${wsId}/payees/`);
    const mapped = list.map((raw) => withTimestamps<PayeeRecord>(raw));
    mapped.sort((a, b) => a.name.localeCompare(b.name));
    setPayees(mapped);
  }, []);

  const refreshCoaAccounts = useCallback(async (wsId: string) => {
    const list = await apiGet<Raw[]>(`/workspaces/${wsId}/coa-accounts/`);
    const mapped = list.map((raw) => withTimestamps<WorkspaceCoaAccount>(raw));
    mapped.sort((a, b) => a.code.localeCompare(b.code) || a.title.localeCompare(b.title));
    setCustomCoaAccounts(mapped);
    setCoaLoaded(true);
  }, []);

  const refreshTaxPresets = useCallback(async (wsId: string) => {
    const list = await apiGet<Raw[]>(`/workspaces/${wsId}/tax-presets/`);
    setCustomTaxPresets(list.map((raw) => withTimestamps<WorkspaceTaxPreset>(raw)));
  }, []);

  const refreshTeam = useCallback(async (wsId: string) => {
    const [memberList, inviteList] = await Promise.all([
      apiGet<Raw[]>(`/workspaces/${wsId}/members/`),
      apiGet<Raw[]>(`/workspaces/${wsId}/invites/`),
    ]);
    setMembers(memberList.map(mapMember));
    setSentInvites(inviteList.map((raw) => withTimestamps<WorkspaceInvite>(raw)));
  }, []);

  const carryForwardWorkspaceSetup = useCallback(
    async (wsId: string): Promise<boolean> => {
      const sourceTemplates = templates;
      const tplIdMap = new Map<string, string>();
      const usedTplIds = new Set<string>();
      const usedPayeeIds = new Set<string>();
      const usedCoaIds = new Set<string>();
      const tplItems: Raw[] = [];
      const payeeItems: Raw[] = [];
      const coaItems: Raw[] = [];

      for (const tpl of sourceTemplates) {
        let safeTplId =
          tpl.id && /^[a-zA-Z0-9_-]{1,128}$/.test(tpl.id) ? tpl.id : makeId('tpl');
        if (usedTplIds.has(safeTplId)) safeTplId = makeId('tpl');
        usedTplIds.add(safeTplId);
        tplIdMap.set(tpl.id, safeTplId);
        const vatRate =
          typeof tpl.vatRate === 'number' && Number.isFinite(tpl.vatRate) && tpl.vatRate >= 0 && tpl.vatRate <= 1
            ? tpl.vatRate
            : 0;
        const ewtRate =
          typeof tpl.ewtRate === 'number' && Number.isFinite(tpl.ewtRate) && tpl.ewtRate >= 0 && tpl.ewtRate <= 1
            ? tpl.ewtRate
            : 0;
        const safeTaxMode = VALID_TAX_MODES.has(tpl.taxMode) ? tpl.taxMode : 'none';
        const keywords = getEffectiveTemplateKeywordsString(tpl);
        tplItems.push({
          id: safeTplId,
          name: cleanString(tpl.name, 100) || 'Template',
          shortcutKey: cleanString(tpl.shortcutKey, 16),
          category: cleanString(tpl.category, 60) || 'General',
          defaultNature: cleanString(tpl.defaultNature, 300),
          taxMode: safeTaxMode,
          vatRate,
          ewtRate,
          requiresProcurement: Boolean(tpl.requiresProcurement),
          debitAccountCode: cleanString(tpl.debitAccountCode, 30),
          debitAccountTitle: cleanString(tpl.debitAccountTitle, 140),
          creditCashAccountCode: cleanString(tpl.creditCashAccountCode, 30),
          creditCashAccountTitle: cleanString(tpl.creditCashAccountTitle, 140),
          autoMatchKeywords: cleanString(keywords, 300),
        });
      }

      for (const payee of payees) {
        const name = cleanString(payee.name, 180);
        if (!name) continue;
        let safePayeeId =
          payee.id && /^[a-zA-Z0-9_-]{1,128}$/.test(payee.id) ? payee.id : makeId('payee');
        if (usedPayeeIds.has(safePayeeId)) safePayeeId = makeId('payee');
        usedPayeeIds.add(safePayeeId);
        const payload: Raw = { id: safePayeeId, name };
        if (payee.tin?.trim()) payload.tin = cleanString(payee.tin, 30);
        if (payee.defaultTemplateId?.trim()) {
          const mappedTplId = tplIdMap.get(payee.defaultTemplateId) || payee.defaultTemplateId;
          payload.defaultTemplateId = cleanString(mappedTplId, 128);
        }
        if (payee.defaultNature?.trim()) {
          payload.defaultNature = cleanString(payee.defaultNature, 300);
        }
        payeeItems.push(payload);
      }

      const coaSource = customCoaAccounts;

      for (const acct of coaSource) {
        const code = cleanString(acct.code, 30);
        const title = cleanString(acct.title, 140);
        if (!code || !title) continue;
        let safeCoaId =
          acct.id && /^[a-zA-Z0-9_-]{1,128}$/.test(acct.id) ? acct.id : makeId('coa');
        if (usedCoaIds.has(safeCoaId)) safeCoaId = makeId('coa');
        usedCoaIds.add(safeCoaId);
        coaItems.push({
          id: safeCoaId,
          code,
          title,
          normalSide: acct.normalSide === 'credit' ? 'credit' : 'debit',
          ...(acct.accountClass ? { accountClass: acct.accountClass } : {}),
        });
      }

      if (tplItems.length > 0) {
        await apiPost(`/workspaces/${wsId}/templates/batch/`, { items: tplItems });
      }
      if (payeeItems.length > 0) {
        await apiPost(`/workspaces/${wsId}/payees/batch/`, { items: payeeItems });
      }
      if (coaItems.length > 0) {
        await apiPost(`/workspaces/${wsId}/coa-accounts/batch/`, { items: coaItems });
      }
      return coaItems.length > 0;
    },
    [templates, payees, customCoaAccounts],
  );

  const createWorkspace = useCallback(
    async (
      name: string,
      agencyCode: string,
      fiscalYear: number,
      options?: { carryForwardFromCurrent?: boolean },
    ) => {
      if (!user) return;
      const wsName = cleanString(name, 120);
      const wsAgency = cleanString(agencyCode, 60);
      if (!wsName || !wsAgency) {
        throw new Error('Workspace name and agency code are required.');
      }
      const wsId = makeId('ws');
      const normalizedYear = Math.min(2099, Math.max(2020, Math.round(fiscalYear)));

      try {
        // Server atomically creates the workspace + admin membership
        await apiPost('/workspaces/', {
          id: wsId,
          name: wsName,
          agencyCode: wsAgency,
          fiscalYear: normalizedYear,
          defaultCheckPrefix: '',
          defaultDvPrefix: `${normalizedYear}-01-`,
          coaInitialized: false,
        });
      } catch (error) {
        logApiError(error, 'create', '/workspaces/');
        throw error;
      }

      // Optional carry-forward copies the user's own setup (never built-in seeds)
      if (options?.carryForwardFromCurrent && activeWorkspace) {
        try {
          const coaCopied = await carryForwardWorkspaceSetup(wsId);
          if (coaCopied) {
            await apiPatch(`/workspaces/${wsId}/`, { coaInitialized: true });
          }
        } catch (error) {
          logApiError(error, 'write', `/workspaces/${wsId}/carry-forward`);
        }
      }

      await refreshWorkspaceLinks().catch(() => {});
      setSelectedMonth('January');
      switchWorkspace(wsId);
    },
    [
      user,
      activeWorkspace,
      carryForwardWorkspaceSetup,
      refreshWorkspaceLinks,
      switchWorkspace,
    ],
  );

  // Auto-select a workspace when none is active or the stored one is gone
  useEffect(() => {
    if (!user || authLoading || workspaceLoading) return;
    if (workspaceLinks.length === 0) return;
    if (!activeWorkspaceId || !workspaceLinks.some((w) => w.workspaceId === activeWorkspaceId)) {
      switchWorkspace(workspaceLinks[0].workspaceId);
    }
  }, [
    user,
    authLoading,
    workspaceLoading,
    workspaceLinks,
    activeWorkspaceId,
    switchWorkspace,
  ]);

  // Load activeWorkspace + subcollections (replaces the six onSnapshot listeners)
  useEffect(() => {
    if (!user || !activeWorkspaceId) {
      setActiveWorkspace(null);
      setTransactions([]);
      setTemplates([]);
      setPayees([]);
      setCustomCoaAccounts([]);
      setCustomTaxPresets([]);
      setMembers([]);
      setSentInvites([]);
      setTemplatesLoaded(false);
      setTransactionsLoaded(false);
      setCoaLoaded(false);
      return;
    }

    let cancelled = false;
    setTemplatesLoaded(false);
    setTransactionsLoaded(false);
    setCoaLoaded(false);

    void (async () => {
      try {
        const wsRaw = await apiGet<Raw>(`/workspaces/${activeWorkspaceId}/`);
        if (cancelled) return;
        setActiveWorkspace(withTimestamps<Workspace>(wsRaw));
        await Promise.all([
          refreshTransactions(activeWorkspaceId),
          refreshTemplates(activeWorkspaceId),
          refreshPayees(activeWorkspaceId),
          refreshCoaAccounts(activeWorkspaceId),
          refreshTaxPresets(activeWorkspaceId),
        ]);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
          // Workspace deleted or access revoked: fall back to another workspace
          setActiveWorkspace(null);
          void refreshWorkspaceLinks().catch(() => {});
          const fallback = workspaceLinksRef.current.find(
            (w) => w.workspaceId !== activeWorkspaceId,
          );
          if (fallback) {
            switchWorkspace(fallback.workspaceId);
          } else {
            setActiveWorkspaceId(null);
            try {
              localStorage.removeItem('rci_active_workspace_id');
            } catch {
              // ignore storage error
            }
          }
        } else {
          logApiError(error, 'get', `/workspaces/${activeWorkspaceId}/`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    user,
    activeWorkspaceId,
    refreshTransactions,
    refreshTemplates,
    refreshPayees,
    refreshCoaAccounts,
    refreshTaxPresets,
    refreshWorkspaceLinks,
    switchWorkspace,
  ]);

  // Lightweight polling replaces Firestore realtime push (30s)
  useEffect(() => {
    if (!user || !activeWorkspaceId) return;
    const timer = setInterval(() => {
      void refreshTransactions(activeWorkspaceId).catch(() => {});
      void refreshTeam(activeWorkspaceId).catch(() => {});
      void refreshPendingInvites().catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, [user, activeWorkspaceId, refreshTransactions, refreshTeam, refreshPendingInvites]);

  // Members & sent invites (server scopes visibility by role/ownership)
  useEffect(() => {
    if (!user || !activeWorkspace) {
      setMembers([]);
      setSentInvites([]);
      return;
    }
    void refreshTeam(activeWorkspace.id).catch((error) =>
      logApiError(error, 'list', `/workspaces/${activeWorkspace.id}/members/`),
    );
  }, [user, activeWorkspace, refreshTeam]);

  const activeRole: WorkspaceRole = useMemo(() => {
    const link = workspaceLinks.find((w) => w.workspaceId === activeWorkspaceId);
    return link?.role || 'encoder';
  }, [workspaceLinks, activeWorkspaceId]);

  // Workspace accounts only — no built-in seed catalog
  const coaAccounts = useMemo<CoaAccount[]>(
    () =>
      customCoaAccounts.map((a) => ({
        id: a.id,
        code: a.code,
        title: a.title,
        normalSide: a.normalSide,
        accountClass: a.accountClass,
        isDefault: false,
      })),
    [customCoaAccounts],
  );

  const taxPresets = useMemo<TaxRulePreset[]>(() => {
    const byId = new Map<string, TaxRulePreset>();
    for (const def of DEFAULT_TAX_RULE_PRESETS) {
      byId.set(def.id, def);
    }
    for (const custom of customTaxPresets) {
      byId.set(custom.id, custom);
    }
    return Array.from(byId.values());
  }, [customTaxPresets]);

  const buildTransactionPayload = useCallback(
    (input: CreateTransactionInput) => {
      if (!user || !activeWorkspace) {
        throw new Error('Workspace not ready');
      }
      const allowEmpty = Boolean(input.forceDraft) && input.journalLines.length === 0;
      const lines = sanitizeJournalLines(input.journalLines, { allowEmpty });
      const balance = computeBalanceSummary(lines);
      const attrs = input.attributes || defaultAttributes();
      const proc = sanitizeProcurement(input.procurement);
      const flagged = hasFlaggedAttribute(attrs);

      let status: TransactionStatus = 'posted';
      if (input.forceDraft || lines.length === 0 || !balance.isBalanced) {
        status = 'draft';
      } else if (flagged) {
        status = 'lacking';
      }

      const safeNet = round2(Math.max(0, Number(input.netAmount) || 0));
      const safeRci =
        input.rciAmount !== undefined
          ? round2(Math.max(0, Number(input.rciAmount) || 0))
          : safeNet;

      // Server owns workspaceId, createdByUid, authorizedUids and timestamps
      const payload: Record<string, unknown> = {
        month: input.month,
        sequenceNo: Math.max(1, Math.round(input.sequenceNo || 1)),
        adaCheckDate: cleanString(input.adaCheckDate, 20),
        adaCheckNo: cleanString(input.adaCheckNo, 40),
        dvNo: cleanString(input.dvNo, 40),
        payeeName: cleanString(input.payeeName, 180) || 'Unnamed Payee',
        natureOfTransaction: cleanString(input.natureOfTransaction, 500),
        grossAmount: round2(Math.max(0, Number(input.grossAmount) || 0)),
        netAmount: safeNet,
        taxWithheld: round2(Math.max(0, Number(input.taxWithheld) || 0)),
        rciAmount: safeRci,
        amountModelVersion: input.amountModelVersion || 2,
        journalLines: lines,
        isBalanced: balance.isBalanced,
        attributes: attrs,
        status,
      };

      if (input.declaredJevGross !== undefined) {
        payload.declaredJevGross = round2(Math.max(0, Number(input.declaredJevGross) || 0));
      }
      if (input.grossBasisOverride) {
        payload.grossBasisOverride = input.grossBasisOverride;
      }
      if (input.taxComponents && input.taxComponents.length > 0) {
        payload.taxComponents = sanitizeTaxComponents(input.taxComponents);
      }
      if (input.mathStatus) payload.mathStatus = input.mathStatus;
      if (input.taxStatus) payload.taxStatus = input.taxStatus;
      if (input.documentaryStatus) payload.documentaryStatus = input.documentaryStatus;
      if (input.clerkReviewStatus && input.clerkReviewStatus !== 'audited') {
        payload.clerkReviewStatus = input.clerkReviewStatus;
      } else {
        payload.clerkReviewStatus = deriveClerkReviewStatus(status, attrs);
      }
      if (input.verificationAuditTrail && input.verificationAuditTrail.length > 0) {
        payload.verificationAuditTrail = sanitizeVerificationAuditTrail(input.verificationAuditTrail);
      }
      if (input.legacySnapshot) payload.legacySnapshot = input.legacySnapshot;
      if (input.dateReceived?.trim()) payload.dateReceived = cleanString(input.dateReceived, 20);
      if (input.orNoDate?.trim()) payload.orNoDate = cleanString(input.orNoDate, 40);
      if (input.asaNo?.trim()) payload.asaNo = cleanString(input.asaNo, 40);
      if (input.jevNoDate?.trim()) payload.jevNoDate = cleanString(input.jevNoDate, 50);
      if (input.templateId?.trim()) payload.templateId = cleanString(input.templateId, 128);
      if (proc) payload.procurement = proc;
      if (input.remarks?.trim()) payload.remarks = cleanString(input.remarks, 800);
      if (input.submittedToCoaDate?.trim()) {
        payload.submittedToCoaDate = cleanString(input.submittedToCoaDate, 20);
      }

      return payload;
    },
    [user, activeWorkspace],
  );

  const createTransaction = useCallback(
    async (input: CreateTransactionInput): Promise<string> => {
      if (!activeWorkspace) throw new Error('No active workspace');
      const wsId = activeWorkspace.id;
      const txId = makeId('tx');
      const payload = buildTransactionPayload(input);

      try {
        await apiPost(`/workspaces/${wsId}/transactions/`, { id: txId, ...payload });
        await refreshTransactions(wsId);
        return txId;
      } catch (error) {
        logApiError(error, 'create', `/workspaces/${wsId}/transactions/${txId}`);
        throw error;
      }
    },
    [activeWorkspace, buildTransactionPayload, refreshTransactions],
  );

  const batchCreateTransactions = useCallback(
    async (inputs: CreateTransactionInput[]): Promise<number> => {
      if (!activeWorkspace || inputs.length === 0) return 0;
      const wsId = activeWorkspace.id;
      const chunkSize = 100;
      let totalCreated = 0;

      for (let i = 0; i < inputs.length; i += chunkSize) {
        const chunk = inputs.slice(i, i + chunkSize);
        const items = chunk.map((input) => ({ id: makeId('tx'), ...buildTransactionPayload(input) }));
        try {
          const result = await apiPost<BatchResult>(`/workspaces/${wsId}/transactions/batch/`, {
            items,
          });
          totalCreated += result.count;
        } catch (error) {
          logApiError(error, 'write', `/workspaces/${wsId}/transactions/batch/`);
          throw error;
        }
      }

      await refreshTransactions(wsId).catch(() => {});
      return totalCreated;
    },
    [activeWorkspace, buildTransactionPayload, refreshTransactions],
  );

  const updateTransaction = useCallback(
    async (txId: string, patch: Partial<TransactionRecord>) => {
      if (!activeWorkspace) return;
      const wsId = activeWorkspace.id;
      const cleanPatch: Record<string, unknown> = {};

      if (patch.month !== undefined) cleanPatch.month = patch.month;
      if (patch.sequenceNo !== undefined) cleanPatch.sequenceNo = Math.max(1, Math.round(patch.sequenceNo));
      if (patch.adaCheckDate !== undefined) cleanPatch.adaCheckDate = cleanString(patch.adaCheckDate, 20);
      if (patch.adaCheckNo !== undefined) cleanPatch.adaCheckNo = cleanString(patch.adaCheckNo, 40);
      if (patch.dvNo !== undefined) cleanPatch.dvNo = cleanString(patch.dvNo, 40);
      if (patch.dateReceived !== undefined) cleanPatch.dateReceived = cleanString(patch.dateReceived, 20);
      if (patch.orNoDate !== undefined) cleanPatch.orNoDate = cleanString(patch.orNoDate, 40);
      if (patch.asaNo !== undefined) cleanPatch.asaNo = cleanString(patch.asaNo, 40);
      if (patch.jevNoDate !== undefined) cleanPatch.jevNoDate = cleanString(patch.jevNoDate, 50);
      if (patch.payeeName !== undefined) cleanPatch.payeeName = cleanString(patch.payeeName, 180) || 'Unnamed Payee';
      if (patch.natureOfTransaction !== undefined) {
        cleanPatch.natureOfTransaction = cleanString(patch.natureOfTransaction, 500);
      }
      if (patch.grossAmount !== undefined) cleanPatch.grossAmount = round2(Math.max(0, patch.grossAmount));
      if (patch.netAmount !== undefined) cleanPatch.netAmount = round2(Math.max(0, patch.netAmount));
      if (patch.taxWithheld !== undefined) cleanPatch.taxWithheld = round2(Math.max(0, patch.taxWithheld));
      if (patch.rciAmount !== undefined) cleanPatch.rciAmount = round2(Math.max(0, patch.rciAmount));
      if (patch.declaredJevGross !== undefined) {
        cleanPatch.declaredJevGross = round2(Math.max(0, patch.declaredJevGross));
      }
      if (patch.grossBasisOverride !== undefined) cleanPatch.grossBasisOverride = patch.grossBasisOverride;
      if (patch.taxComponents !== undefined) {
        cleanPatch.taxComponents = sanitizeTaxComponents(patch.taxComponents);
      }
      if (patch.mathStatus !== undefined) cleanPatch.mathStatus = patch.mathStatus;
      if (patch.taxStatus !== undefined) cleanPatch.taxStatus = patch.taxStatus;
      if (patch.documentaryStatus !== undefined) cleanPatch.documentaryStatus = patch.documentaryStatus;
      if (patch.clerkReviewStatus !== undefined) cleanPatch.clerkReviewStatus = patch.clerkReviewStatus;
      if (patch.verificationAuditTrail !== undefined) {
        cleanPatch.verificationAuditTrail = sanitizeVerificationAuditTrail(patch.verificationAuditTrail);
      }
      if (patch.amountModelVersion !== undefined) {
        cleanPatch.amountModelVersion = patch.amountModelVersion;
      }
      if (patch.legacySnapshot !== undefined) cleanPatch.legacySnapshot = patch.legacySnapshot;
      if (patch.templateId !== undefined) cleanPatch.templateId = cleanString(patch.templateId, 128);
      if (patch.journalLines !== undefined) {
        const sanitized = sanitizeJournalLines(patch.journalLines, {
          allowEmpty: patch.status === 'draft' && patch.journalLines.length === 0,
        });
        cleanPatch.journalLines = sanitized;
        cleanPatch.isBalanced = computeBalanceSummary(sanitized).isBalanced;
      } else if (patch.isBalanced !== undefined) {
        cleanPatch.isBalanced = patch.isBalanced;
      }
      if (patch.attributes !== undefined) cleanPatch.attributes = patch.attributes;
      if (patch.procurement !== undefined) {
        const proc = sanitizeProcurement(patch.procurement);
        if (proc) cleanPatch.procurement = proc;
      }
      if (patch.remarks !== undefined) cleanPatch.remarks = cleanString(patch.remarks, 800);
      if (patch.status !== undefined) cleanPatch.status = patch.status;
      if (patch.submittedToCoaDate !== undefined) {
        cleanPatch.submittedToCoaDate = cleanString(patch.submittedToCoaDate, 20);
      }

      try {
        await apiPatch(`/workspaces/${wsId}/transactions/${txId}/`, cleanPatch);
        await refreshTransactions(wsId);
      } catch (error) {
        logApiError(error, 'update', `/workspaces/${wsId}/transactions/${txId}`);
        throw error;
      }
    },
    [activeWorkspace, refreshTransactions],
  );

  const upgradeLegacyTransactionToV2 = useCallback(
    async (tx: TransactionRecord, reason: string): Promise<void> => {
      if (!user || !activeWorkspace || !isLegacyTransaction(tx)) return;
      const snapshot = tx.legacySnapshot || createLegacySnapshot(tx, user.uid);
      const rciNet = round2(tx.rciAmount ?? tx.netAmount ?? 0);
      const declaredGross = round2(tx.declaredJevGross ?? tx.grossAmount ?? 0);
      const recon = computeReconciliationSummary({
        rciAmount: rciNet,
        declaredJevGross: declaredGross,
        grossBasisOverride: tx.grossBasisOverride,
        journalLines: tx.journalLines,
        coaAccounts,
      });
      const taxEval = evaluateTaxVerification({
        journalLines: recon.classifiedLines,
        taxComponents: tx.taxComponents || [],
        attributes: tx.attributes,
        coaAccounts,
      });
      const docStatus = evaluateDocumentaryStatus({
        attributes: tx.attributes,
        procurement: tx.procurement,
        taxComponents: tx.taxComponents || [],
        isDraft: tx.status === 'draft',
      });
      const clerkStatus = deriveClerkReviewStatus(tx.status, tx.attributes);
      const evt = createVerificationAuditEvent({
        actorUid: user.uid,
        actorName: user.displayName || user.email || 'Clerk Auditor',
        category: 'legacy_v2_upgrade',
        targetRef: tx.adaCheckNo,
        previousValue: `v1 (Gross ${tx.grossAmount}, Net ${tx.netAmount}, Tax ${tx.taxWithheld})`,
        newValue: `v2 (${recon.mathStatus} / ${taxEval.taxStatus})`,
        reason: reason.trim() || 'Explicit upgrade to v2 RCI-to-JEV verification',
      });
      const trail = sanitizeVerificationAuditTrail([...(tx.verificationAuditTrail || []), evt]);

      await updateTransaction(tx.id, {
        rciAmount: rciNet,
        declaredJevGross: declaredGross,
        mathStatus: recon.mathStatus,
        taxStatus: taxEval.taxStatus,
        documentaryStatus: docStatus,
        clerkReviewStatus: clerkStatus,
        verificationAuditTrail: trail,
        amountModelVersion: 2,
        legacySnapshot: snapshot,
      });
    },
    [user, activeWorkspace, coaAccounts, updateTransaction],
  );

  const deleteTransaction = useCallback(
    async (txId: string): Promise<void> => {
      if (!activeWorkspace) return;
      const wsId = activeWorkspace.id;
      try {
        await apiDelete(`/workspaces/${wsId}/transactions/${txId}/`);
        await refreshTransactions(wsId);
      } catch (error) {
        logApiError(error, 'delete', `/workspaces/${wsId}/transactions/${txId}`);
        throw error;
      }
    },
    [activeWorkspace, refreshTransactions],
  );

  const createTemplate = useCallback(
    async (
      tpl: Omit<
        EntryTemplate,
        'id' | 'workspaceId' | 'authorizedUids' | 'createdByUid' | 'createdAt' | 'updatedAt'
      >,
    ) => {
      if (!user || !activeWorkspace) return;
      const wsId = activeWorkspace.id;
      const tplId = makeId('tpl');
      try {
        await apiPost(`/workspaces/${wsId}/templates/`, {
          id: tplId,
          name: cleanString(tpl.name, 100) || 'Custom Template',
          shortcutKey: cleanString(tpl.shortcutKey, 16),
          category: cleanString(tpl.category, 60) || 'General',
          defaultNature: cleanString(tpl.defaultNature, 300),
          taxMode: tpl.taxMode,
          vatRate: Math.min(1, Math.max(0, Number(tpl.vatRate) || 0)),
          ewtRate: Math.min(1, Math.max(0, Number(tpl.ewtRate) || 0)),
          requiresProcurement: Boolean(tpl.requiresProcurement),
          debitAccountCode: cleanString(tpl.debitAccountCode, 30) || '20101010',
          debitAccountTitle: cleanString(tpl.debitAccountTitle, 140) || 'Accounts Payable',
          creditCashAccountCode: cleanString(tpl.creditCashAccountCode, 30) || '10102020',
          creditCashAccountTitle:
            cleanString(tpl.creditCashAccountTitle, 140) ||
            'Cash in Bank - Local Currency, Current Account',
          autoMatchKeywords: cleanString(tpl.autoMatchKeywords, 300),
        });
        await refreshTemplates(wsId);
      } catch (error) {
        logApiError(error, 'create', `/workspaces/${wsId}/templates/${tplId}`);
        throw error;
      }
    },
    [user, activeWorkspace, refreshTemplates],
  );

  const updateTemplate = useCallback(
    async (
      templateId: string,
      patch: Partial<
        Pick<
          EntryTemplate,
          | 'name'
          | 'shortcutKey'
          | 'category'
          | 'defaultNature'
          | 'taxMode'
          | 'vatRate'
          | 'ewtRate'
          | 'requiresProcurement'
          | 'debitAccountCode'
          | 'debitAccountTitle'
          | 'creditCashAccountCode'
          | 'creditCashAccountTitle'
          | 'autoMatchKeywords'
        >
      >,
    ) => {
      if (!activeWorkspace) return;
      const wsId = activeWorkspace.id;
      const cleanPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) cleanPatch.name = cleanString(patch.name, 100) || 'Template';
      if (patch.shortcutKey !== undefined) cleanPatch.shortcutKey = cleanString(patch.shortcutKey, 16);
      if (patch.category !== undefined) cleanPatch.category = cleanString(patch.category, 60) || 'General';
      if (patch.defaultNature !== undefined) cleanPatch.defaultNature = cleanString(patch.defaultNature, 300);
      if (patch.taxMode !== undefined) cleanPatch.taxMode = patch.taxMode;
      if (patch.vatRate !== undefined) cleanPatch.vatRate = Math.min(1, Math.max(0, Number(patch.vatRate) || 0));
      if (patch.ewtRate !== undefined) cleanPatch.ewtRate = Math.min(1, Math.max(0, Number(patch.ewtRate) || 0));
      if (patch.requiresProcurement !== undefined) cleanPatch.requiresProcurement = Boolean(patch.requiresProcurement);
      if (patch.debitAccountCode !== undefined) cleanPatch.debitAccountCode = cleanString(patch.debitAccountCode, 30) || '20101010';
      if (patch.debitAccountTitle !== undefined) cleanPatch.debitAccountTitle = cleanString(patch.debitAccountTitle, 140) || 'Accounts Payable';
      if (patch.creditCashAccountCode !== undefined) cleanPatch.creditCashAccountCode = cleanString(patch.creditCashAccountCode, 30) || '10102020';
      if (patch.creditCashAccountTitle !== undefined) {
        cleanPatch.creditCashAccountTitle =
          cleanString(patch.creditCashAccountTitle, 140) ||
          'Cash in Bank - Local Currency, Current Account';
      }
      if (patch.autoMatchKeywords !== undefined) {
        cleanPatch.autoMatchKeywords = cleanString(patch.autoMatchKeywords, 300);
      }

      try {
        await apiPatch(`/workspaces/${wsId}/templates/${templateId}/`, cleanPatch);
        await refreshTemplates(wsId);
      } catch (error) {
        logApiError(error, 'update', `/workspaces/${wsId}/templates/${templateId}`);
        throw error;
      }
    },
    [activeWorkspace, refreshTemplates],
  );

  const deleteTemplate = useCallback(
    async (templateId: string) => {
      if (!activeWorkspace) return;
      const wsId = activeWorkspace.id;
      try {
        await apiDelete(`/workspaces/${wsId}/templates/${templateId}/`);
        await refreshTemplates(wsId);
      } catch (error) {
        logApiError(error, 'delete', `/workspaces/${wsId}/templates/${templateId}`);
        throw error;
      }
    },
    [activeWorkspace, refreshTemplates],
  );  const createCoaAccount = useCallback(
    async (acct: {
      code: string;
      title: string;
      normalSide: 'debit' | 'credit';
      accountClass?: AccountRole;
    }) => {
      if (!user || !activeWorkspace) return;
      const code = cleanString(acct.code, 30);
      const title = cleanString(acct.title, 140);
      if (!code || !title) return;
      const wsId = activeWorkspace.id;
      const acctId = makeId('coa');
      try {
        await apiPost(`/workspaces/${wsId}/coa-accounts/`, {
          id: acctId,
          code,
          title,
          normalSide: acct.normalSide === 'credit' ? 'credit' : 'debit',
          accountClass:
            acct.accountClass || (acct.normalSide === 'credit' ? 'other_credit' : 'settlement_debit'),
        });
        await refreshCoaAccounts(wsId);
      } catch (error) {
        logApiError(error, 'create', `/workspaces/${wsId}/coa-accounts/${acctId}`);
        throw error;
      }
    },
    [user, activeWorkspace, refreshCoaAccounts],
  );

  const batchCreateCoaAccounts = useCallback(
    async (
      items: Array<{
        code: string;
        title: string;
        normalSide: 'debit' | 'credit';
        accountClass?: AccountRole;
      }>,
    ): Promise<number> => {
      if (!user || !activeWorkspace || items.length === 0) return 0;
      const wsId = activeWorkspace.id;
      const existingKeys = new Set(
        coaAccounts.map((a) => `${a.code.trim().toLowerCase()}::${a.title.trim().toLowerCase()}`),
      );
      const uniqueItems = items.filter((item) => {
        const code = cleanString(item.code, 30);
        const title = cleanString(item.title, 140);
        if (!code || !title) return false;
        const key = `${code.toLowerCase()}::${title.toLowerCase()}`;
        if (existingKeys.has(key)) return false;
        existingKeys.add(key);
        return true;
      });

      if (uniqueItems.length === 0) return 0;
      const payloadItems = uniqueItems.map((item) => ({
        id: makeId('coa'),
        code: cleanString(item.code, 30),
        title: cleanString(item.title, 140),
        normalSide: item.normalSide === 'credit' ? 'credit' : 'debit',
        accountClass:
          item.accountClass ||
          (item.normalSide === 'credit' ? 'other_credit' : 'settlement_debit'),
      }));

      try {
        const result = await apiPost<BatchResult>(`/workspaces/${wsId}/coa-accounts/batch/`, {
          items: payloadItems,
        });
        await refreshCoaAccounts(wsId);
        return result.created ?? result.count;
      } catch (error) {
        logApiError(error, 'write', `/workspaces/${wsId}/coa-accounts/batch/`);
        throw error;
      }
    },
    [user, activeWorkspace, coaAccounts, refreshCoaAccounts],
  );

  const updateCoaAccount = useCallback(
    async (
      accountId: string,
      patch: {
        code?: string;
        title?: string;
        normalSide?: 'debit' | 'credit';
        accountClass?: AccountRole;
      },
    ) => {
      if (!activeWorkspace) return;
      const wsId = activeWorkspace.id;
      const cleanPatch: Record<string, unknown> = {};
      if (patch.code !== undefined) {
        const code = cleanString(patch.code, 30);
        if (code) cleanPatch.code = code;
      }
      if (patch.title !== undefined) {
        const title = cleanString(patch.title, 140);
        if (title) cleanPatch.title = title;
      }
      if (patch.normalSide !== undefined) {
        cleanPatch.normalSide = patch.normalSide === 'credit' ? 'credit' : 'debit';
      }
      if (patch.accountClass !== undefined) {
        cleanPatch.accountClass = patch.accountClass;
      }
      try {
        await apiPatch(`/workspaces/${wsId}/coa-accounts/${accountId}/`, cleanPatch);
        await refreshCoaAccounts(wsId);
      } catch (error) {
        logApiError(error, 'update', `/workspaces/${wsId}/coa-accounts/${accountId}`);
        throw error;
      }
    },
    [activeWorkspace, refreshCoaAccounts],
  );

  const deleteCoaAccount = useCallback(
    async (accountId: string) => {
      if (!activeWorkspace) return;
      const wsId = activeWorkspace.id;
      try {
        await apiDelete(`/workspaces/${wsId}/coa-accounts/${accountId}/`);
        await refreshCoaAccounts(wsId);
      } catch (error) {
        logApiError(error, 'delete', `/workspaces/${wsId}/coa-accounts/${accountId}`);
        throw error;
      }
    },
    [activeWorkspace, refreshCoaAccounts],
  );

  const upsertTaxPreset = useCallback(
    async (preset: TaxRulePreset, overrideReason?: string) => {
      if (!user || !activeWorkspace) return;
      const wsId = activeWorkspace.id;
      const presetId =
        preset.id && /^[a-zA-Z0-9_-]{1,80}$/.test(preset.id) ? preset.id : makeId('trp');
      const existing = customTaxPresets.find((p) => p.id === presetId);
      const prevBuiltIn = DEFAULT_TAX_RULE_PRESETS.find((p) => p.id === presetId);
      const prevSource = existing || prevBuiltIn;
      const actorName = cleanString(user.displayName || user.email || 'Auditor', 120);

      let nextHistory = [...(existing?.overrideHistory || preset.overrideHistory || [])];
      if (prevSource && overrideReason?.trim()) {
        nextHistory = [
          ...nextHistory,
          {
            timestamp: new Date().toISOString(),
            actorUid: user.uid,
            actorName,
            previousSummary: `${prevSource.version} · ${Math.round(prevSource.rate * 100)}% (${prevSource.defaultTaxBaseType})`,
            newSummary: `${preset.version} · ${Math.round(preset.rate * 100)}% (${preset.defaultTaxBaseType})`,
            reason: cleanString(overrideReason, 200),
          },
        ].slice(-20);
      }

      const payload: Record<string, unknown> = {
        id: presetId,
        name: cleanString(preset.name, 120) || 'Tax Rule Preset',
        version: cleanString(preset.version, 30) || '2026.1',
        effectiveFrom: cleanString(preset.effectiveFrom, 30) || '2026-01-01',
        applicableClassification:
          cleanString(preset.applicableClassification, 160) || 'General Withholding',
        birReference: cleanString(preset.birReference, 120) || 'NIRC / BIR RR',
        defaultBirAccountCode: cleanString(preset.defaultBirAccountCode, 30) || '20201010',
        defaultBirAccountTitle: cleanString(preset.defaultBirAccountTitle, 140) || 'Due to BIR',
        rate: Math.min(1, Math.max(0, Number(preset.rate) || 0)),
        defaultTaxBaseType: preset.defaultTaxBaseType,
        roundingMethod: preset.roundingMethod === 'truncate_2dp' ? 'truncate_2dp' : 'half_up_2dp',
        computationRule: cleanString(preset.computationRule, 200) || 'Tax Base x Rate',
        overrideHistory: nextHistory,
      };
      if (preset.effectiveTo?.trim()) {
        payload.effectiveTo = cleanString(preset.effectiveTo, 30);
      }

      try {
        // Server upserts by id (create endpoint handles existing records)
        await apiPost(`/workspaces/${wsId}/tax-presets/`, payload);
        await refreshTaxPresets(wsId);
      } catch (error) {
        logApiError(error, existing ? 'update' : 'create', `/workspaces/${wsId}/tax-presets/${presetId}`);
        throw error;
      }
    },
    [user, activeWorkspace, customTaxPresets, refreshTaxPresets],
  );

  const deleteTaxPreset = useCallback(
    async (presetId: string) => {
      if (!activeWorkspace) return;
      const wsId = activeWorkspace.id;
      try {
        await apiDelete(`/workspaces/${wsId}/tax-presets/${presetId}/`);
        await refreshTaxPresets(wsId);
      } catch (error) {
        logApiError(error, 'delete', `/workspaces/${wsId}/tax-presets/${presetId}`);
        throw error;
      }
    },
    [activeWorkspace, refreshTaxPresets],
  );

  const ensurePayeeExists = useCallback(
    async (
      name: string,
      defaultTemplateId?: string,
      defaultNature?: string,
      updateExistingTemplate = false,
    ) => {
      if (!user || !activeWorkspace) return;
      const wsId = activeWorkspace.id;
      const trimmed = cleanString(name, 180);
      if (!trimmed) return;
      const existingPayee = payees.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
      try {
        if (existingPayee) {
          if (updateExistingTemplate && defaultTemplateId?.trim()) {
            const patch: Record<string, unknown> = {
              defaultTemplateId: cleanString(defaultTemplateId, 128),
            };
            if (defaultNature?.trim()) patch.defaultNature = cleanString(defaultNature, 300);
            await apiPatch(`/workspaces/${wsId}/payees/${existingPayee.id}/`, patch);
            await refreshPayees(wsId);
          }
          return;
        }

        const payload: Record<string, unknown> = { id: makeId('payee'), name: trimmed };
        if (defaultTemplateId?.trim()) payload.defaultTemplateId = cleanString(defaultTemplateId, 128);
        if (defaultNature?.trim()) payload.defaultNature = cleanString(defaultNature, 300);
        await apiPost(`/workspaces/${wsId}/payees/`, payload);
        await refreshPayees(wsId);
      } catch (error) {
        logApiError(error, 'write', `/workspaces/${wsId}/payees/`);
        throw error;
      }
    },
    [user, activeWorkspace, payees, refreshPayees],
  );

  const upsertPayee = useCallback(
    async (payee: {
      id?: string;
      name: string;
      tin?: string;
      defaultTemplateId?: string;
      defaultNature?: string;
    }) => {
      if (!user || !activeWorkspace) return;
      const wsId = activeWorkspace.id;
      const name = cleanString(payee.name, 180);
      if (!name) return;

      const fields = {
        name,
        tin: cleanString(payee.tin, 30),
        defaultTemplateId: cleanString(payee.defaultTemplateId, 128),
        defaultNature: cleanString(payee.defaultNature, 300),
      };

      try {
        if (payee.id) {
          await apiPatch(`/workspaces/${wsId}/payees/${payee.id}/`, fields);
        } else {
          const existing = payees.find((p) => p.name.toLowerCase() === name.toLowerCase());
          if (existing) {
            await apiPatch(`/workspaces/${wsId}/payees/${existing.id}/`, fields);
          } else {
            await apiPost(`/workspaces/${wsId}/payees/`, { id: makeId('payee'), ...fields });
          }
        }
        await refreshPayees(wsId);
      } catch (error) {
        logApiError(error, 'write', `/workspaces/${wsId}/payees/`);
        throw error;
      }
    },
    [user, activeWorkspace, payees, refreshPayees],
  );

  const deletePayee = useCallback(
    async (payeeId: string) => {
      if (!activeWorkspace) return;
      const wsId = activeWorkspace.id;
      try {
        await apiDelete(`/workspaces/${wsId}/payees/${payeeId}/`);
        await refreshPayees(wsId);
      } catch (error) {
        logApiError(error, 'delete', `/workspaces/${wsId}/payees/${payeeId}`);
        throw error;
      }
    },
    [activeWorkspace, refreshPayees],
  );

  const batchEnsurePayees = useCallback(
    async (
      items: Array<{ name: string; defaultTemplateId?: string; defaultNature?: string }>,
    ) => {
      if (!user || !activeWorkspace || items.length === 0) return;
      const wsId = activeWorkspace.id;
      try {
        await apiPost(`/workspaces/${wsId}/payees/batch/`, { items, ensureOnly: true });
        await refreshPayees(wsId);
      } catch (error) {
        logApiError(error, 'write', `/workspaces/${wsId}/payees/batch/`);
        throw error;
      }
    },
    [user, activeWorkspace, refreshPayees],
  );

  const inviteMember = useCallback(
    async (email: string, role: 'auditor' | 'encoder') => {
      if (!user || !activeWorkspace) return;
      const wsId = activeWorkspace.id;
      const normalized = cleanString(email.toLowerCase(), 254);
      if (!normalized) return;
      const inviteId = makeId('inv');
      try {
        await apiPost(`/workspaces/${wsId}/invites/`, {
          id: inviteId,
          invitedEmail: normalized,
          role,
        });
        await refreshTeam(wsId);
      } catch (error) {
        logApiError(error, 'create', `/workspaces/${wsId}/invites/${inviteId}`);
        throw error;
      }
    },
    [user, activeWorkspace, refreshTeam],
  );

  const acceptInvite = useCallback(
    async (invite: WorkspaceInvite) => {
      if (!user) return;
      try {
        // Server atomically marks accepted + creates membership + syncs record access
        await apiPost(`/invites/${invite.id}/accept/`);
        await Promise.all([
          refreshWorkspaceLinks().catch(() => {}),
          refreshPendingInvites().catch(() => {}),
        ]);
        switchWorkspace(invite.workspaceId);
      } catch (error) {
        logApiError(error, 'write', `/invites/${invite.id}/accept/`);
        throw error;
      }
    },
    [user, refreshWorkspaceLinks, refreshPendingInvites, switchWorkspace],
  );

  // Server maintains authorizedUids from membership; kept for interface compatibility
  const syncWorkspaceAccessToRecords = useCallback(async () => {}, []);

  const getWorkspaceDetails = useCallback(async (workspaceId: string): Promise<Workspace | null> => {
    try {
      const raw = await apiGet<Raw>(`/workspaces/${workspaceId}/`);
      return withTimestamps<Workspace>(raw);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      logApiError(error, 'get', `/workspaces/${workspaceId}/`);
      return null;
    }
  }, []);

  const updateWorkspace = useCallback(
    async (
      workspaceId: string,
      patch: {
        name: string;
        agencyCode: string;
        fiscalYear: number;
        defaultCheckPrefix?: string;
        defaultDvPrefix?: string;
      },
    ) => {
      if (!user) return;
      const cleanName = cleanString(patch.name, 120);
      const cleanAgency = cleanString(patch.agencyCode, 60);
      if (!cleanName || !cleanAgency) return;
      const normalizedYear = Math.min(2099, Math.max(2020, Math.round(patch.fiscalYear)));
      const cleanPatch: Record<string, unknown> = {
        name: cleanName,
        agencyCode: cleanAgency,
        fiscalYear: normalizedYear,
      };
      if (patch.defaultCheckPrefix !== undefined) {
        cleanPatch.defaultCheckPrefix = cleanString(patch.defaultCheckPrefix, 20);
      }
      if (patch.defaultDvPrefix !== undefined) {
        cleanPatch.defaultDvPrefix = cleanString(patch.defaultDvPrefix, 20);
      }

      try {
        const raw = await apiPatch<Raw>(`/workspaces/${workspaceId}/`, cleanPatch);
        setActiveWorkspace((prev) =>
          prev && prev.id === workspaceId ? withTimestamps<Workspace>(raw) : prev,
        );
        await refreshWorkspaceLinks().catch(() => {});
      } catch (error) {
        logApiError(error, 'update', `/workspaces/${workspaceId}/`);
        throw error;
      }
    },
    [user, refreshWorkspaceLinks],
  );

  const deleteWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!user) return;
      try {
        // Server cascades all records, members and invites
        await apiDelete(`/workspaces/${workspaceId}/`);

        if (activeWorkspaceId === workspaceId) {
          const nextLink = workspaceLinksRef.current.find((w) => w.workspaceId !== workspaceId);
          if (nextLink) {
            switchWorkspace(nextLink.workspaceId);
          } else {
            setActiveWorkspaceId(null);
            setActiveWorkspace(null);
            try {
              localStorage.removeItem('rci_active_workspace_id');
            } catch {
              // ignore storage error
            }
          }
        }

        await refreshWorkspaceLinks().catch(() => {});
      } catch (error) {
        logApiError(error, 'delete', `/workspaces/${workspaceId}/`);
        throw error;
      }
    },
    [user, activeWorkspaceId, switchWorkspace, refreshWorkspaceLinks],
  );

  const value: AuthWorkspaceContextValue = {
    user,
    authLoading,
    workspaceLoading,
    signInWithGoogle,
    logout,
    workspaces: workspaceLinks,
    activeWorkspace,
    activeRole,
    switchWorkspace,
    createWorkspace,
    getWorkspaceDetails,
    updateWorkspace,
    deleteWorkspace,
    transactions,
    templates,
    payees,
    coaAccounts,
    customCoaAccounts,
    taxPresets,
    customTaxPresets,
    members,
    sentInvites,
    pendingInvitesForUser,
    acceptInvite,
    inviteMember,
    createTransaction,
    batchCreateTransactions,
    updateTransaction,
    upgradeLegacyTransactionToV2,
    deleteTransaction,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    createCoaAccount,
    batchCreateCoaAccounts,
    updateCoaAccount,
    deleteCoaAccount,
    upsertTaxPreset,
    deleteTaxPreset,
    ensurePayeeExists,
    upsertPayee,
    deletePayee,
    batchEnsurePayees,
    syncWorkspaceAccessToRecords,
    selectedMonth,
    setSelectedMonth,
  };

  return <AuthWorkspaceContext.Provider value={value}>{children}</AuthWorkspaceContext.Provider>;
};

export function useAuthWorkspace(): AuthWorkspaceContextValue {
  const ctx = useContext(AuthWorkspaceContext);
  if (!ctx) throw new Error('useAuthWorkspace must be used inside AuthWorkspaceProvider');
  return ctx;
}