import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  FileSpreadsheet,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { CoaAccountPicker } from './CoaAccountPicker';
import { useAuthWorkspace } from '../contexts/AuthWorkspaceContext';
import { getEffectiveTemplateKeywordsString } from '../lib/batchImportParser';
import { formatTaxRuleSummary, getRatesForTaxMode } from '../lib/taxAndLedger';
import {
  ACCOUNT_ROLE_LABELS,
  type AccountRole,
  type TaxBaseType,
  type TaxMode,
  type TaxRoundingMethod,
  type TaxRulePreset,
  type WorkspaceInvite,
  type WorkspaceMember,
  type WorkspaceRole,
} from '../types/rci';

type CoaImportRow = {
  code: string;
  title: string;
  normalSide: 'debit' | 'credit';
  accountClass?: AccountRole;
};

const ALL_ROLE_KEYS = new Set<AccountRole>(Object.keys(ACCOUNT_ROLE_LABELS) as AccountRole[]);

function parsePastedCoaRows(raw: string): CoaImportRow[] {
  const rows: CoaImportRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.includes('\t')
      ? trimmed.split('\t')
      : trimmed.split(',').map((s) => s.trim());
    if (parts.length < 2) continue;
    const code = parts[0].trim();
    const title = parts[1].trim();
    if (!code || !title) continue;
    if (/^(account\s*)?code$/i.test(code) && /^(account\s*)?title$/i.test(title)) continue;
    const sideRaw = (parts[2] || '').trim().toLowerCase();
    const normalSide: 'debit' | 'credit' =
      sideRaw.startsWith('c') || sideRaw === 'credit' ? 'credit' : 'debit';
    const roleRaw = (parts[3] || '').trim().toLowerCase() as AccountRole;
    const accountClass: AccountRole = ALL_ROLE_KEYS.has(roleRaw)
      ? roleRaw
      : normalSide === 'credit'
        ? 'other_credit'
        : 'settlement_debit';
    rows.push({ code: code.slice(0, 30), title: title.slice(0, 140), normalSide, accountClass });
  }
  return rows;
}

export const TemplatesAndTeamView: React.FC = () => {
  const {
    activeWorkspace,
    activeRole,
    user,
    workspaces,
    switchWorkspace,
    createWorkspace,
    getWorkspaceDetails,
    updateWorkspace,
    deleteWorkspace,
    templates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    payees,
    upsertPayee,
    deletePayee,
    coaAccounts,
    customCoaAccounts,
    createCoaAccount,
    batchCreateCoaAccounts,
    updateCoaAccount,
    deleteCoaAccount,
    taxPresets,
    customTaxPresets,
    upsertTaxPreset,
    deleteTaxPreset,
    members,
    sentInvites,
    pendingInvitesForUser,
    acceptInvite,
    inviteMember,
    updateMemberRole,
    removeMember,
    revokeInvite,
  } = useAuthWorkspace();

  const canManageCatalog = activeRole === 'admin' || activeRole === 'auditor';
  const canManageTeam = activeRole === 'admin';

  // New Template State
  const [tplName, setTplName] = useState('');
  const [tplShortcut, setTplShortcut] = useState('Alt+7');
  const [tplCategory] = useState('General');
  const [tplNature, setTplNature] = useState('');
  const [tplKeywords, setTplKeywords] = useState('');
  const [tplTaxMode, setTplTaxMode] = useState<TaxMode>('vat5_ewt2');
  const [tplDebitCode, setTplDebitCode] = useState('20101010');
  const [tplDebitTitle, setTplDebitTitle] = useState('Accounts Payable');
  const [tplCreditCode, setTplCreditCode] = useState('10102020');
  const [tplCreditTitle, setTplCreditTitle] = useState(
    'Cash in Bank - Local Currency, Current Account',
  );
  const [tplRequiresProc, setTplRequiresProc] = useState(false);
  const [editingTplKeywordsId, setEditingTplKeywordsId] = useState<string | null>(null);
  const [editTplKeywordsVal, setEditTplKeywordsVal] = useState('');
  const [editingTplId, setEditingTplId] = useState<string | null>(null);
  const [editTplName, setEditTplName] = useState('');
  const [editTplShortcut, setEditTplShortcut] = useState('');
  const [editTplTaxMode, setEditTplTaxMode] = useState<TaxMode>('vat5_ewt2');
  const [editTplNature, setEditTplNature] = useState('');
  const [editTplRequiresProc, setEditTplRequiresProc] = useState(false);
  const [editTplDebitCode, setEditTplDebitCode] = useState('20101010');
  const [editTplDebitTitle, setEditTplDebitTitle] = useState('Accounts Payable');
  const [editTplCreditCode, setEditTplCreditCode] = useState('10102020');
  const [editTplCreditTitle, setEditTplCreditTitle] = useState(
    'Cash in Bank - Local Currency, Current Account',
  );
  const [editTplKeywordsFull, setEditTplKeywordsFull] = useState('');

  // Payee Directory Manager State
  const [payeeSearch, setPayeeSearch] = useState('');
  const [newPayeeName, setNewPayeeName] = useState('');
  const [newPayeeTin, setNewPayeeTin] = useState('');
  const [newPayeeTplId, setNewPayeeTplId] = useState('');
  const [newPayeeNature, setNewPayeeNature] = useState('');
  const [editingPayeeId, setEditingPayeeId] = useState<string | null>(null);
  const [editPayeeName, setEditPayeeName] = useState('');
  const [editPayeeTin, setEditPayeeTin] = useState('');
  const [editPayeeTplId, setEditPayeeTplId] = useState('');
  const [editPayeeNature, setEditPayeeNature] = useState('');

  // Chart of Accounts Manager State
  const [coaSearch, setCoaSearch] = useState('');
  const [newCoaCode, setNewCoaCode] = useState('');
  const [newCoaTitle, setNewCoaTitle] = useState('');
  const [newCoaSide, setNewCoaSide] = useState<'debit' | 'credit'>('debit');
  const [newCoaClass, setNewCoaClass] = useState<AccountRole>('settlement_debit');
  const [editingCoaId, setEditingCoaId] = useState<string | null>(null);
  const [editCoaCode, setEditCoaCode] = useState('');
  const [editCoaTitle, setEditCoaTitle] = useState('');
  const [editCoaSide, setEditCoaSide] = useState<'debit' | 'credit'>('debit');
  const [editCoaClass, setEditCoaClass] = useState<AccountRole>('settlement_debit');
  const [showCoaImport, setShowCoaImport] = useState(false);
  const [coaPasteText, setCoaPasteText] = useState('');
  const [importingCoa, setImportingCoa] = useState(false);

  // Versioned Tax Rule Preset State
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  const [presetVersion, setPresetVersion] = useState('2026.1');
  const [presetEffectiveFrom, setPresetEffectiveFrom] = useState('2026-01-01');
  const [presetClassification, setPresetClassification] = useState('');
  const [presetBirRef, setPresetBirRef] = useState('');
  const [presetRatePct, setPresetRatePct] = useState('5');
  const [presetBaseType, setPresetBaseType] = useState<TaxBaseType>('vatable_sales');
  const [presetRounding, setPresetRounding] = useState<TaxRoundingMethod>('half_up_2dp');
  const [presetRuleText, setPresetRuleText] = useState('');
  const [presetOverrideReason, setPresetOverrideReason] = useState('');
  const [showPresetForm, setShowPresetForm] = useState(false);

  // Team Invite State
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'encoder' | 'auditor'>('encoder');

  // New / Edit / Delete Workspace State
  const [newWsName, setNewWsName] = useState('');
  const [newWsAgency, setNewWsAgency] = useState(activeWorkspace?.agencyCode ?? '');
  const [newWsYear, setNewWsYear] = useState(() => (activeWorkspace?.fiscalYear ?? 2026) + 1);
  const [carryForwardSetup, setCarryForwardSetup] = useState(true);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [editingWsId, setEditingWsId] = useState<string | null>(null);
  const [editWsName, setEditWsName] = useState('');
  const [editWsAgency, setEditWsAgency] = useState('');
  const [editWsYear, setEditWsYear] = useState(2026);
  const [editWsCheckPrefix, setEditWsCheckPrefix] = useState('');
  const [editWsDvPrefix, setEditWsDvPrefix] = useState('2026-01-');
  const [savingWsEdit, setSavingWsEdit] = useState(false);
  const [confirmDeleteWsId, setConfirmDeleteWsId] = useState<string | null>(null);
  const [deletingWsId, setDeletingWsId] = useState<string | null>(null);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (activeWorkspace?.fiscalYear) {
      setNewWsYear(activeWorkspace.fiscalYear + 1);
    }
  }, [activeWorkspace?.fiscalYear]);

  const filteredCoaAccounts = useMemo(() => {
    const q = coaSearch.trim().toLowerCase();
    if (!q) return coaAccounts;
    return coaAccounts.filter(
      (a) => a.code.toLowerCase().includes(q) || a.title.toLowerCase().includes(q),
    );
  }, [coaAccounts, coaSearch]);

  const filteredPayees = useMemo(() => {
    const q = payeeSearch.trim().toLowerCase();
    if (!q) return payees;
    return payees.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.tin || '').toLowerCase().includes(q) ||
        (p.defaultNature || '').toLowerCase().includes(q),
    );
  }, [payees, payeeSearch]);

  const parsedCoaRows = useMemo(() => parsePastedCoaRows(coaPasteText), [coaPasteText]);

  const handleAddTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tplName.trim()) return;
    const { vatRate, ewtRate } = getRatesForTaxMode(tplTaxMode);

    await createTemplate({
      name: tplName.trim(),
      shortcutKey: tplShortcut.trim() || 'Alt+7',
      category: tplCategory.trim() || 'General',
      defaultNature: tplNature.trim() || `To payment of ${tplName.trim().toLowerCase()}`,
      taxMode: tplTaxMode,
      vatRate,
      ewtRate,
      requiresProcurement: tplRequiresProc,
      debitAccountCode: tplDebitCode.trim() || '20101010',
      debitAccountTitle: tplDebitTitle.trim() || 'Accounts Payable',
      creditCashAccountCode: tplCreditCode.trim() || '10102020',
      creditCashAccountTitle:
        tplCreditTitle.trim() || 'Cash in Bank - Local Currency, Current Account',
      autoMatchKeywords: tplKeywords.trim(),
    });
    setTplName('');
    setTplNature('');
    setTplKeywords('');
    setNotice('Smart template added.');
  };

  const handleAddPayee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPayeeName.trim()) return;
    await upsertPayee({
      name: newPayeeName.trim(),
      tin: newPayeeTin.trim(),
      defaultTemplateId: newPayeeTplId,
      defaultNature: newPayeeNature.trim(),
    });
    setNewPayeeName('');
    setNewPayeeTin('');
    setNewPayeeTplId('');
    setNewPayeeNature('');
    setNotice('Payee saved to directory.');
  };

  const handleAddCoaAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCoaCode.trim() || !newCoaTitle.trim()) return;
    await createCoaAccount({
      code: newCoaCode.trim(),
      title: newCoaTitle.trim(),
      normalSide: newCoaSide,
      accountClass: newCoaClass,
    });
    setNewCoaCode('');
    setNewCoaTitle('');
    setNotice('Account added to workspace Chart of Accounts.');
  };

  const handleCoaFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingCoa(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, {
        defval: '',
      });

      const extracted: CoaImportRow[] = [];
      for (const row of rawRows) {
        const keys = Object.keys(row);
        const codeKey = keys.find((k) => /code|acct.*no|uacs/i.test(k)) || keys[0];
        const titleKey = keys.find((k) => /title|name|account|desc/i.test(k) && k !== codeKey) || keys[1];
        const sideKey = keys.find((k) => /side|normal|type|dr.*cr/i.test(k));
        const roleKey = keys.find((k) => /role|class/i.test(k));

        const code = String(row[codeKey] ?? '').trim().slice(0, 30);
        const title = String(row[titleKey] ?? '').trim().slice(0, 140);
        if (!code || !title) continue;
        const sideStr = sideKey ? String(row[sideKey] ?? '').trim().toLowerCase() : '';
        const normalSide: 'debit' | 'credit' =
          sideStr.startsWith('c') || sideStr.includes('credit') ? 'credit' : 'debit';
        const roleRaw = (roleKey ? String(row[roleKey] ?? '').trim().toLowerCase() : '') as AccountRole;
        const accountClass: AccountRole = ALL_ROLE_KEYS.has(roleRaw)
          ? roleRaw
          : normalSide === 'credit'
            ? 'other_credit'
            : 'settlement_debit';
        extracted.push({ code, title, normalSide, accountClass });
      }

      if (extracted.length === 0) {
        setNotice('No valid Account Code & Account Title rows found in the uploaded file.');
      } else {
        const added = await batchCreateCoaAccounts(extracted);
        setNotice(`Imported ${added} new account(s) from ${file.name} (duplicates skipped).`);
        setShowCoaImport(false);
      }
    } finally {
      setImportingCoa(false);
      e.target.value = '';
    }
  };

  const handleImportPastedCoa = async () => {
    if (parsedCoaRows.length === 0) return;
    setImportingCoa(true);
    try {
      const added = await batchCreateCoaAccounts(parsedCoaRows);
      setNotice(`Imported ${added} new Chart of Accounts item(s) to workspace.`);
      setCoaPasteText('');
      setShowCoaImport(false);
    } finally {
      setImportingCoa(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim() || teamBusy) return;
    setTeamError(null);
    setTeamBusy(true);
    try {
      await inviteMember(inviteEmail.trim(), inviteRole);
      setNotice(`Invitation sent to ${inviteEmail.trim()}.`);
      setInviteEmail('');
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : 'Failed to send invitation.');
    } finally {
      setTeamBusy(false);
    }
  };

  const handleRoleChange = async (member: WorkspaceMember, role: WorkspaceRole) => {
    if (teamBusy || member.role === role) return;
    setTeamError(null);
    setTeamBusy(true);
    try {
      await updateMemberRole(member.uid, role);
      setNotice(`Role for ${member.displayName} set to ${role}.`);
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : 'Failed to update member role.');
    } finally {
      setTeamBusy(false);
    }
  };

  const handleRemoveMember = async (member: WorkspaceMember) => {
    if (teamBusy) return;
    if (!window.confirm(`Remove ${member.displayName} from this workspace?`)) return;
    setTeamError(null);
    setTeamBusy(true);
    try {
      await removeMember(member.uid);
      setNotice(`${member.displayName} removed from the workspace.`);
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : 'Failed to remove member.');
    } finally {
      setTeamBusy(false);
    }
  };

  const handleRevokeInvite = async (invite: WorkspaceInvite) => {
    if (teamBusy) return;
    if (!window.confirm(`Revoke the invitation to ${invite.invitedEmail}?`)) return;
    setTeamError(null);
    setTeamBusy(true);
    try {
      await revokeInvite(invite.id);
      setNotice(`Invitation to ${invite.invitedEmail} revoked.`);
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : 'Failed to revoke invitation.');
    } finally {
      setTeamBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {notice && (
        <div className="bg-emerald-50 border border-emerald-200 rounded px-4 py-2.5 text-xs text-emerald-800 flex items-center justify-between">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-emerald-700 underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {pendingInvitesForUser.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-blue-950 font-display mb-2">
            Pending Workspace Invitations
          </h3>
          <div className="space-y-2">
            {pendingInvitesForUser.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between bg-white border border-blue-200 rounded px-3 py-2 text-xs"
              >
                <span>
                  Invited to <strong>{inv.workspaceName}</strong> as{' '}
                  <span className="capitalize font-medium">{inv.role}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void acceptInvite(inv)}
                  className="inline-flex items-center gap-1 px-3 py-1 bg-slate-900 text-white rounded hover:bg-slate-800 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Join Workspace</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Smart Entry Templates + Workspace Chart of Accounts Manager */}
        <div className="lg:col-span-7 space-y-6">
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 font-display">
                  Smart Rapid-Entry Templates
                </h3>
                <p className="text-xs text-slate-500">
                  Preset accounting splits and BIR tax rates triggered by Alt+1..6 shortcuts.
                </p>
              </div>
            </div>

            <form
              onSubmit={handleAddTemplate}
              className="p-4 bg-slate-50 border-b border-slate-200 grid grid-cols-12 gap-2"
            >
              <input
                type="text"
                value={tplName}
                onChange={(e) => setTplName(e.target.value)}
                placeholder="Template Name (e.g., Fuel & Oil)"
                className="col-span-12 sm:col-span-5 h-8 px-2.5 text-xs bg-white border border-slate-200 rounded"
                required
              />
              <input
                type="text"
                value={tplShortcut}
                onChange={(e) => setTplShortcut(e.target.value)}
                placeholder="Alt+7"
                className="col-span-4 sm:col-span-2 h-8 px-2 text-xs font-mono bg-white border border-slate-200 rounded"
              />
              <select
                value={tplTaxMode}
                onChange={(e) => setTplTaxMode(e.target.value as TaxMode)}
                className="col-span-8 sm:col-span-3 h-8 px-2 text-xs bg-white border border-slate-200 rounded"
              >
                <option value="vat5_ewt2">5% VAT + 2% EWT</option>
                <option value="vat5_ewt1">5% VAT + 1% EWT</option>
                <option value="vat5">5% VAT Only</option>
                <option value="pt3">3% PT Only (Non-VAT)</option>
                <option value="pt3_ewt1">3% PT + 1% EWT (Non-VAT Goods)</option>
                <option value="pt3_ewt2">3% PT + 2% EWT (Non-VAT Services)</option>
                <option value="ewt2">2% EWT Only</option>
                <option value="none">No Tax Withheld</option>
              </select>
              <button
                type="submit"
                className="col-span-12 sm:col-span-2 h-8 inline-flex items-center justify-center gap-1 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add</span>
              </button>

              <input
                type="text"
                value={tplNature}
                onChange={(e) => setTplNature(e.target.value)}
                placeholder="Default Nature of Transaction..."
                className="col-span-12 sm:col-span-9 h-8 px-2.5 text-xs bg-white border border-slate-200 rounded"
              />
              <label className="col-span-12 sm:col-span-3 flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer px-1">
                <input
                  type="checkbox"
                  checked={tplRequiresProc}
                  onChange={(e) => setTplRequiresProc(e.target.checked)}
                />
                <span>Requires PO Trail</span>
              </label>

              <div className="col-span-12 sm:col-span-6 space-y-1">
                <span className="block text-[10px] font-medium text-slate-500">
                  Debit Account (Code &amp; Title)
                </span>
                <CoaAccountPicker
                  accountCode={tplDebitCode}
                  accountTitle={tplDebitTitle}
                  accounts={coaAccounts}
                  suggestedNormalSide="debit"
                  onChange={({ accountCode, accountTitle }) => {
                    setTplDebitCode(accountCode);
                    setTplDebitTitle(accountTitle);
                  }}
                />
              </div>

              <div className="col-span-12 sm:col-span-6 space-y-1">
                <span className="block text-[10px] font-medium text-slate-500">
                  Cash / Credit Account (Code &amp; Title)
                </span>
                <CoaAccountPicker
                  accountCode={tplCreditCode}
                  accountTitle={tplCreditTitle}
                  accounts={coaAccounts}
                  suggestedNormalSide="credit"
                  onChange={({ accountCode, accountTitle }) => {
                    setTplCreditCode(accountCode);
                    setTplCreditTitle(accountTitle);
                  }}
                />
              </div>
              <div className="col-span-12 space-y-1">
                <span className="block text-[10px] font-medium text-slate-500">
                  Batch Paste Auto-Match Keywords (comma-separated)
                </span>
                <input
                  type="text"
                  value={tplKeywords}
                  onChange={(e) => setTplKeywords(e.target.value)}
                  maxLength={300}
                  placeholder="e.g., fuel, gasoline, diesel, lube (used when pasting mixed Excel rows)"
                  className="w-full h-8 px-2.5 text-xs bg-white border border-slate-200 rounded"
                />
              </div>
            </form>

            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-100 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                <tr>
                  <th className="py-2 px-3">Shortcut</th>
                  <th className="py-2 px-3">Template &amp; Auto-Match Keywords</th>
                  <th className="py-2 px-3">Tax Rule</th>
                  <th className="py-2 px-3">Debit / Cash Account</th>
                  <th className="py-2 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {templates.map((tpl) => {
                  const kwString = getEffectiveTemplateKeywordsString(tpl);
                  const isEditingKw = editingTplKeywordsId === tpl.id;
                  const isEditingFull = editingTplId === tpl.id;
                  if (isEditingFull) {
                    return (
                      <tr key={tpl.id} className="bg-slate-50/90">
                        <td colSpan={5} className="p-3">
                          <div className="grid grid-cols-12 gap-2">
                            <input
                              type="text"
                              value={editTplName}
                              onChange={(e) => setEditTplName(e.target.value)}
                              placeholder="Template Name"
                              maxLength={100}
                              className="col-span-12 sm:col-span-5 h-8 px-2.5 text-xs bg-white border border-slate-300 rounded"
                            />
                            <input
                              type="text"
                              value={editTplShortcut}
                              onChange={(e) => setEditTplShortcut(e.target.value)}
                              placeholder="Alt+1"
                              maxLength={16}
                              className="col-span-4 sm:col-span-2 h-8 px-2 text-xs font-mono bg-white border border-slate-300 rounded"
                            />
                            <select
                              value={editTplTaxMode}
                              onChange={(e) => setEditTplTaxMode(e.target.value as TaxMode)}
                              className="col-span-8 sm:col-span-3 h-8 px-2 text-xs bg-white border border-slate-300 rounded"
                            >
                              <option value="vat5_ewt2">5% VAT + 2% EWT</option>
                              <option value="vat5_ewt1">5% VAT + 1% EWT</option>
                              <option value="vat5">5% VAT Only</option>
                              <option value="pt3">3% PT Only (Non-VAT)</option>
                              <option value="pt3_ewt1">3% PT + 1% EWT (Non-VAT Goods)</option>
                              <option value="pt3_ewt2">3% PT + 2% EWT (Non-VAT Services)</option>
                              <option value="ewt2">2% EWT Only</option>
                              <option value="none">No Tax Withheld</option>
                            </select>
                            <label className="col-span-12 sm:col-span-2 flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer px-1">
                              <input
                                type="checkbox"
                                checked={editTplRequiresProc}
                                onChange={(e) => setEditTplRequiresProc(e.target.checked)}
                              />
                              <span>PO Trail</span>
                            </label>

                            <input
                              type="text"
                              value={editTplNature}
                              onChange={(e) => setEditTplNature(e.target.value)}
                              placeholder="Default Nature of Transaction..."
                              maxLength={300}
                              className="col-span-12 h-8 px-2.5 text-xs bg-white border border-slate-300 rounded"
                            />

                            <div className="col-span-12 sm:col-span-6 space-y-1">
                              <span className="block text-[10px] font-medium text-slate-500">
                                Debit Account (Code &amp; Title)
                              </span>
                              <CoaAccountPicker
                                accountCode={editTplDebitCode}
                                accountTitle={editTplDebitTitle}
                                accounts={coaAccounts}
                                suggestedNormalSide="debit"
                                onChange={({ accountCode, accountTitle }) => {
                                  setEditTplDebitCode(accountCode);
                                  setEditTplDebitTitle(accountTitle);
                                }}
                              />
                            </div>

                            <div className="col-span-12 sm:col-span-6 space-y-1">
                              <span className="block text-[10px] font-medium text-slate-500">
                                Cash / Credit Account (Code &amp; Title)
                              </span>
                              <CoaAccountPicker
                                accountCode={editTplCreditCode}
                                accountTitle={editTplCreditTitle}
                                accounts={coaAccounts}
                                suggestedNormalSide="credit"
                                onChange={({ accountCode, accountTitle }) => {
                                  setEditTplCreditCode(accountCode);
                                  setEditTplCreditTitle(accountTitle);
                                }}
                              />
                            </div>

                            <div className="col-span-12 sm:col-span-8">
                              <input
                                type="text"
                                value={editTplKeywordsFull}
                                onChange={(e) => setEditTplKeywordsFull(e.target.value)}
                                maxLength={300}
                                placeholder="Batch Paste Auto-Match Keywords (comma-separated)"
                                className="w-full h-8 px-2.5 text-xs bg-white border border-slate-300 rounded"
                              />
                            </div>

                            <div className="col-span-12 sm:col-span-4 flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={async () => {
                                  if (!editTplName.trim()) return;
                                  const { vatRate, ewtRate } = getRatesForTaxMode(editTplTaxMode);
                                  await updateTemplate(tpl.id, {
                                    name: editTplName.trim(),
                                    shortcutKey: editTplShortcut.trim() || tpl.shortcutKey,
                                    taxMode: editTplTaxMode,
                                    vatRate,
                                    ewtRate,
                                    defaultNature: editTplNature.trim(),
                                    requiresProcurement: editTplRequiresProc,
                                    debitAccountCode: editTplDebitCode.trim() || '20101010',
                                    debitAccountTitle:
                                      editTplDebitTitle.trim() || 'Accounts Payable',
                                    creditCashAccountCode:
                                      editTplCreditCode.trim() || '10102020',
                                    creditCashAccountTitle:
                                      editTplCreditTitle.trim() ||
                                      'Cash in Bank - Local Currency, Current Account',
                                    autoMatchKeywords: editTplKeywordsFull.trim(),
                                  });
                                  setEditingTplId(null);
                                  setNotice(`Updated template "${editTplName.trim()}".`);
                                }}
                                className="h-8 px-3 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingTplId(null)}
                                className="h-8 px-2.5 border border-slate-200 bg-white text-slate-600 text-xs rounded hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={tpl.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-mono text-slate-500 align-top">
                        {tpl.shortcutKey}
                      </td>
                      <td className="py-2 px-3 align-top">
                        <div className="font-medium text-slate-900">{tpl.name}</div>
                        {isEditingKw && canManageCatalog ? (
                          <div className="mt-1 flex items-center gap-1">
                            <input
                              type="text"
                              value={editTplKeywordsVal}
                              onChange={(e) => setEditTplKeywordsVal(e.target.value)}
                              maxLength={300}
                              placeholder="comma-separated keywords..."
                              className="flex-1 h-7 px-2 text-[11px] bg-white border border-slate-300 rounded"
                            />
                            <button
                              type="button"
                              onClick={async () => {
                                await updateTemplate(tpl.id, {
                                  autoMatchKeywords: editTplKeywordsVal.trim(),
                                });
                                setEditingTplKeywordsId(null);
                                setNotice(`Updated auto-match keywords for ${tpl.name}.`);
                              }}
                              title="Save keywords"
                              className="p-1 text-emerald-700 hover:bg-emerald-50 rounded cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingTplKeywordsId(null)}
                              title="Cancel"
                              className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                            <span className="truncate max-w-[230px]">
                              Keywords:{' '}
                              <span className="font-mono text-slate-600">
                                {kwString || 'none'}
                              </span>
                            </span>
                            {canManageCatalog && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingTplKeywordsId(tpl.id);
                                  setEditTplKeywordsVal(kwString);
                                }}
                                title="Edit auto-match keywords"
                                className="text-blue-700 hover:underline cursor-pointer shrink-0"
                              >
                                Keywords
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-600 align-top">
                        {formatTaxRuleSummary(tpl.taxMode, tpl.vatRate, tpl.ewtRate)}
                      </td>
                      <td className="py-2 px-3 text-slate-600 align-top">
                        <div>
                          <span className="font-mono text-[11px] text-slate-500 mr-1">
                            {tpl.debitAccountCode}
                          </span>
                          {tpl.debitAccountTitle}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Cr: <span className="font-mono">{tpl.creditCashAccountCode}</span> ·{' '}
                          {tpl.creditCashAccountTitle}
                        </div>
                      </td>
                      <td className="py-2 px-3 text-right align-top whitespace-nowrap">
                        {canManageCatalog ? (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingTplKeywordsId(null);
                                setEditingTplId(tpl.id);
                                setEditTplName(tpl.name);
                                setEditTplShortcut(tpl.shortcutKey);
                                setEditTplTaxMode(tpl.taxMode);
                                setEditTplNature(tpl.defaultNature);
                                setEditTplRequiresProc(tpl.requiresProcurement);
                                setEditTplDebitCode(tpl.debitAccountCode);
                                setEditTplDebitTitle(tpl.debitAccountTitle);
                                setEditTplCreditCode(tpl.creditCashAccountCode);
                                setEditTplCreditTitle(tpl.creditCashAccountTitle);
                                setEditTplKeywordsFull(kwString);
                              }}
                              title="Edit template account code, title & details"
                              className="p-1 text-slate-400 hover:text-slate-800 rounded cursor-pointer"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                await deleteTemplate(tpl.id);
                                setNotice(`Deleted template "${tpl.name}".`);
                              }}
                              title="Delete template"
                              className="p-1 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-400">View-only</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Workspace Chart of Accounts Manager */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 font-display">
                  Chart of Accounts (RCA / Workspace Codes)
                </h3>
                <p className="text-xs text-slate-500">
                  Add custom account codes &amp; titles or import your agency&apos;s Excel/CSV COA list ({coaAccounts.length} available).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCoaImport((v) => !v)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{showCoaImport ? 'Close Import' : 'Import .xlsx / CSV'}</span>
              </button>
            </div>

            {showCoaImport && (
              <div className="p-4 bg-slate-50 border-b border-slate-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-slate-600">
                    Upload an Excel/CSV file with <strong>Account Code</strong> and{' '}
                    <strong>Account Title</strong> columns, or paste lines below:
                  </div>
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded hover:bg-slate-100 cursor-pointer whitespace-nowrap">
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
                    <span>{importingCoa ? 'Importing...' : 'Choose .xlsx / .csv'}</span>
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={handleCoaFileUpload}
                      className="hidden"
                      disabled={importingCoa}
                    />
                  </label>
                </div>

                <textarea
                  rows={4}
                  value={coaPasteText}
                  onChange={(e) => setCoaPasteText(e.target.value)}
                  placeholder={`50203090\tFuel, Oil and Lubricants Expenses\tdebit\n50213050\tRepairs and Maintenance - Machinery and Equipment\tdebit\n10102020\tCash in Bank - Local Currency, Current Account\tcredit`}
                  className="w-full p-2.5 text-xs font-mono bg-white border border-slate-200 rounded"
                />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-slate-500">
                    {parsedCoaRows.length} valid row(s) detected
                  </span>
                  <button
                    type="button"
                    disabled={parsedCoaRows.length === 0 || importingCoa}
                    onClick={() => void handleImportPastedCoa()}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                  >
                    Import Pasted Rows
                  </button>
                </div>
              </div>
            )}

            <form
              onSubmit={handleAddCoaAccount}
              className="p-3 bg-slate-50/70 border-b border-slate-200 grid grid-cols-12 gap-2"
            >
              <input
                type="text"
                value={newCoaCode}
                onChange={(e) => setNewCoaCode(e.target.value)}
                placeholder="Account Code (e.g. 50203090)"
                maxLength={30}
                required
                className="col-span-4 sm:col-span-2 h-8 px-2 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded"
              />
              <input
                type="text"
                value={newCoaTitle}
                onChange={(e) => setNewCoaTitle(e.target.value)}
                placeholder="Account Title (e.g. Fuel, Oil and Lubricants Expenses)"
                maxLength={140}
                required
                className="col-span-8 sm:col-span-4 h-8 px-2.5 text-xs bg-white border border-slate-200 rounded"
              />
              <select
                value={newCoaSide}
                onChange={(e) => {
                  const side = e.target.value as 'debit' | 'credit';
                  setNewCoaSide(side);
                  setNewCoaClass(side === 'credit' ? 'other_credit' : 'settlement_debit');
                }}
                className="col-span-4 sm:col-span-2 h-8 px-2 text-xs bg-white border border-slate-200 rounded"
              >
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
              <select
                aria-label="Account Role"
                value={newCoaClass}
                onChange={(e) => setNewCoaClass(e.target.value as AccountRole)}
                className="col-span-8 sm:col-span-2 h-8 px-2 text-xs bg-white border border-slate-200 rounded"
              >
                {(Object.keys(ACCOUNT_ROLE_LABELS) as AccountRole[]).map((role) => (
                  <option key={role} value={role}>
                    {ACCOUNT_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="col-span-12 sm:col-span-2 h-8 inline-flex items-center justify-center gap-1 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Code</span>
              </button>
            </form>

            <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2 bg-white">
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                type="text"
                value={coaSearch}
                onChange={(e) => setCoaSearch(e.target.value)}
                placeholder="Filter accounts by code or title..."
                className="w-full text-xs text-slate-800 bg-transparent focus:outline-none"
              />
              {coaSearch && (
                <button
                  type="button"
                  onClick={() => setCoaSearch('')}
                  className="text-[11px] text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                  <tr>
                    <th className="py-2 px-3 w-24">Code</th>
                    <th className="py-2 px-3">Account Title</th>
                    <th className="py-2 px-3 w-14">Side</th>
                    <th className="py-2 px-3 w-44">Account Role</th>
                    <th className="py-2 px-3 w-20 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredCoaAccounts.map((acct) => {
                    const isEditing = acct.id && editingCoaId === acct.id;
                    const resolvedClass: AccountRole =
                      acct.accountClass ||
                      (acct.normalSide === 'credit' ? 'other_credit' : 'settlement_debit');
                    return (
                      <tr
                        key={`${acct.id || 'def'}-${acct.code}-${acct.title}`}
                        className="hover:bg-slate-50"
                      >
                        <td className="py-1.5 px-3 font-mono tabular-nums text-slate-700">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editCoaCode}
                              onChange={(e) => setEditCoaCode(e.target.value)}
                              maxLength={30}
                              className="w-full h-7 px-1.5 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          ) : (
                            acct.code
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-slate-900">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editCoaTitle}
                              onChange={(e) => setEditCoaTitle(e.target.value)}
                              maxLength={140}
                              className="w-full h-7 px-2 text-xs border border-slate-300 rounded bg-white"
                            />
                          ) : (
                            <span>{acct.title}</span>
                          )}
                        </td>
                        <td className="py-1.5 px-3 font-mono text-[11px] uppercase text-slate-500">
                          {isEditing ? (
                            <select
                              value={editCoaSide}
                              onChange={(e) =>
                                setEditCoaSide(e.target.value as 'debit' | 'credit')
                              }
                              className="h-7 px-1 text-xs border border-slate-300 rounded bg-white"
                            >
                              <option value="debit">Dr</option>
                              <option value="credit">Cr</option>
                            </select>
                          ) : acct.normalSide === 'credit' ? (
                            'Cr'
                          ) : (
                            'Dr'
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-[11px] text-slate-600">
                          {isEditing ? (
                            <select
                              value={editCoaClass}
                              onChange={(e) => setEditCoaClass(e.target.value as AccountRole)}
                              className="w-full h-7 px-1 text-xs border border-slate-300 rounded bg-white"
                            >
                              {(Object.keys(ACCOUNT_ROLE_LABELS) as AccountRole[]).map((role) => (
                                <option key={role} value={role}>
                                  {ACCOUNT_ROLE_LABELS[role]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="truncate block max-w-[170px]" title={ACCOUNT_ROLE_LABELS[resolvedClass]}>
                              {ACCOUNT_ROLE_LABELS[resolvedClass]}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-right whitespace-nowrap">
                          {!canManageCatalog ? (
                            <span className="text-[10px] text-slate-400">View-only</span>
                          ) : acct.isDefault || !acct.id ? (
                            <span className="text-[10px] text-slate-400">Syncing...</span>
                          ) : isEditing && acct.id ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={async () => {
                                  if (!acct.id) return;
                                  await updateCoaAccount(acct.id, {
                                    code: editCoaCode,
                                    title: editCoaTitle,
                                    normalSide: editCoaSide,
                                    accountClass: editCoaClass,
                                  });
                                  setEditingCoaId(null);
                                  setNotice('Chart of Accounts entry updated.');
                                }}
                                title="Save"
                                className="p-1 text-emerald-700 hover:bg-emerald-50 rounded cursor-pointer"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingCoaId(null)}
                                title="Cancel"
                                className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!acct.id) return;
                                  setEditingCoaId(acct.id);
                                  setEditCoaCode(acct.code);
                                  setEditCoaTitle(acct.title);
                                  setEditCoaSide(acct.normalSide);
                                  setEditCoaClass(resolvedClass);
                                }}
                                title="Edit account code, title, normal side & role"
                                className="p-1 text-slate-400 hover:text-slate-800 rounded cursor-pointer"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  if (!acct.id) return;
                                  await deleteCoaAccount(acct.id);
                                  setNotice(`Removed COA account ${acct.code} · ${acct.title}.`);
                                }}
                                title="Delete account"
                                className="p-1 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Versioned & Traceable Tax Rule Presets Manager */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 font-display">
                  BIR Tax Verification Rule Presets (Versioned)
                </h3>
                <p className="text-xs text-slate-500">
                  Traceable BIR tax bases, effective dates, rounding methods, and override history.
                </p>
              </div>
              {canManageCatalog && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingPresetId(null);
                    setPresetName('');
                    setPresetVersion('2026.1');
                    setPresetEffectiveFrom('2026-01-01');
                    setPresetClassification('');
                    setPresetBirRef('');
                    setPresetRatePct('5');
                    setPresetBaseType('vatable_sales');
                    setPresetRounding('half_up_2dp');
                    setPresetRuleText('');
                    setPresetOverrideReason('');
                    setShowPresetForm((v) => !v);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-200 text-slate-700 rounded hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{showPresetForm ? 'Close Form' : 'New Tax Rule Preset'}</span>
                </button>
              )}
            </div>

            {showPresetForm && canManageCatalog && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!presetName.trim()) return;
                  if (editingPresetId && !presetOverrideReason.trim()) {
                    setNotice('Provide an override reason to log versioned preset changes.');
                    return;
                  }
                  const rateNum = Math.min(1, Math.max(0, (parseFloat(presetRatePct) || 0) / 100));
                  const nextPreset: TaxRulePreset = {
                    id: editingPresetId || '',
                    name: presetName.trim(),
                    version: presetVersion.trim() || '2026.1',
                    effectiveFrom: presetEffectiveFrom.trim() || '2026-01-01',
                    applicableClassification: presetClassification.trim() || presetName.trim(),
                    birReference: presetBirRef.trim() || 'NIRC / BIR RR',
                    defaultBirAccountCode: '20201010',
                    defaultBirAccountTitle: `Due to BIR - ${Math.round(rateNum * 100)}%`,
                    rate: rateNum,
                    defaultTaxBaseType: presetBaseType,
                    roundingMethod: presetRounding,
                    computationRule: presetRuleText.trim() || 'Tax Base × Rate',
                  };
                  await upsertTaxPreset(nextPreset, presetOverrideReason.trim() || undefined);
                  setShowPresetForm(false);
                  setEditingPresetId(null);
                  setNotice(`Saved Tax Rule Preset "${nextPreset.name}" (v${nextPreset.version}).`);
                }}
                className="p-4 bg-slate-50 border-b border-slate-200 grid grid-cols-12 gap-2 text-xs"
              >
                <input
                  type="text"
                  required
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Preset Name (e.g. 5% VAT - Electric Coop)"
                  className="col-span-12 sm:col-span-6 h-8 px-2.5 bg-white border border-slate-200 rounded"
                />
                <input
                  type="text"
                  required
                  value={presetVersion}
                  onChange={(e) => setPresetVersion(e.target.value)}
                  placeholder="Version (2026.1)"
                  className="col-span-6 sm:col-span-3 h-8 px-2 font-mono bg-white border border-slate-200 rounded"
                />
                <input
                  type="date"
                  required
                  value={presetEffectiveFrom}
                  onChange={(e) => setPresetEffectiveFrom(e.target.value)}
                  className="col-span-6 sm:col-span-3 h-8 px-2 font-mono bg-white border border-slate-200 rounded"
                />
                <input
                  type="text"
                  value={presetClassification}
                  onChange={(e) => setPresetClassification(e.target.value)}
                  placeholder="Applicable Classification"
                  className="col-span-12 sm:col-span-6 h-8 px-2.5 bg-white border border-slate-200 rounded"
                />
                <input
                  type="text"
                  value={presetBirRef}
                  onChange={(e) => setPresetBirRef(e.target.value)}
                  placeholder="BIR Reference (e.g. RR 16-2005)"
                  className="col-span-12 sm:col-span-6 h-8 px-2.5 bg-white border border-slate-200 rounded"
                />
                <div className="col-span-4 sm:col-span-2 flex items-center gap-1 bg-white border border-slate-200 rounded px-2 h-8">
                  <span className="text-slate-400 text-[10px]">Rate%</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={presetRatePct}
                    onChange={(e) => setPresetRatePct(e.target.value)}
                    className="w-full font-mono text-right bg-transparent focus:outline-none"
                  />
                </div>
                <select
                  value={presetBaseType}
                  onChange={(e) => setPresetBaseType(e.target.value as TaxBaseType)}
                  className="col-span-8 sm:col-span-4 h-8 px-2 bg-white border border-slate-200 rounded"
                >
                  <option value="vatable_sales">Invoice VATable Sales</option>
                  <option value="gross_inclusive_vat">VAT-Inclusive Gross / 1.12</option>
                  <option value="gross_total">Non-VAT Direct Gross</option>
                  <option value="contract_or_custom">Contract / Custom Base</option>
                  <option value="exempt_excluded">Exempt / Excluded</option>
                </select>
                <select
                  value={presetRounding}
                  onChange={(e) => setPresetRounding(e.target.value as TaxRoundingMethod)}
                  className="col-span-12 sm:col-span-3 h-8 px-2 bg-white border border-slate-200 rounded"
                >
                  <option value="half_up_2dp">Half-Up 2dp</option>
                  <option value="truncate_2dp">Truncate 2dp</option>
                </select>
                <input
                  type="text"
                  value={presetRuleText}
                  onChange={(e) => setPresetRuleText(e.target.value)}
                  placeholder="Computation Rule formula"
                  className="col-span-12 sm:col-span-3 h-8 px-2 bg-white border border-slate-200 rounded"
                />
                {editingPresetId && (
                  <input
                    type="text"
                    required
                    value={presetOverrideReason}
                    onChange={(e) => setPresetOverrideReason(e.target.value)}
                    placeholder="Required Override Reason (recorded in history)..."
                    className="col-span-12 h-8 px-2.5 bg-amber-50 border border-amber-300 rounded"
                  />
                )}
                <div className="col-span-12 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowPresetForm(false)}
                    className="h-8 px-3 border border-slate-200 bg-white rounded text-slate-600 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="h-8 px-4 bg-slate-900 text-white font-medium rounded hover:bg-slate-800 cursor-pointer"
                  >
                    {editingPresetId ? 'Save Override' : 'Save Preset'}
                  </button>
                </div>
              </form>
            )}

            <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
              {taxPresets.map((preset) => {
                const isWorkspaceOverride = customTaxPresets.some((c) => c.id === preset.id);
                return (
                  <div key={preset.id} className="px-4 py-2.5 text-xs hover:bg-slate-50 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="font-semibold text-slate-900">{preset.name}</span>
                        <span className="ml-2 font-mono text-[10px] text-slate-500">
                          v{preset.version} · Eff {preset.effectiveFrom}
                        </span>
                        {isWorkspaceOverride && (
                          <span className="ml-1.5 text-[10px] text-blue-700 font-medium">
                            Workspace Rule
                          </span>
                        )}
                      </div>
                      {canManageCatalog && (
                        <div className="inline-flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingPresetId(preset.id);
                              setPresetName(preset.name);
                              setPresetVersion(preset.version);
                              setPresetEffectiveFrom(preset.effectiveFrom);
                              setPresetClassification(preset.applicableClassification);
                              setPresetBirRef(preset.birReference);
                              setPresetRatePct(String(Math.round(preset.rate * 1000) / 10));
                              setPresetBaseType(preset.defaultTaxBaseType);
                              setPresetRounding(preset.roundingMethod);
                              setPresetRuleText(preset.computationRule);
                              setPresetOverrideReason('');
                              setShowPresetForm(true);
                            }}
                            title="Create versioned override"
                            className="p-1 text-slate-400 hover:text-slate-800 rounded cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {isWorkspaceOverride && (
                            <button
                              type="button"
                              onClick={async () => {
                                await deleteTaxPreset(preset.id);
                                setNotice(`Reverted/deleted workspace tax preset "${preset.name}".`);
                              }}
                              title="Delete workspace override"
                              className="p-1 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-600">
                      <span>{preset.birReference}</span>
                      <span className="mx-1.5 text-slate-300">·</span>
                      <span className="font-mono">{preset.computationRule}</span>
                      <span className="mx-1.5 text-slate-300">·</span>
                      <span className="font-mono">{preset.roundingMethod}</span>
                    </div>
                    {preset.overrideHistory && preset.overrideHistory.length > 0 && (
                      <div className="text-[10px] text-slate-500 font-mono">
                        Last override ({preset.overrideHistory[preset.overrideHistory.length - 1].timestamp.slice(0, 10)}):{' '}
                        {preset.overrideHistory[preset.overrideHistory.length - 1].reason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Column: Payee Directory Manager + Multi-User Team & Workspaces */}
        <div className="lg:col-span-5 space-y-6">
          {/* Payee Directory Manager */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900 font-display">
                Payee Directory &amp; Default Templates
              </h3>
              <p className="text-xs text-slate-500">
                Assign default templates to payees for instant Rapid Entry &amp; Batch Paste auto-matching ({payees.length} saved).
              </p>
            </div>

            <form
              onSubmit={handleAddPayee}
              className="p-3 bg-slate-50 border-b border-slate-200 grid grid-cols-12 gap-2"
            >
              <input
                type="text"
                required
                value={newPayeeName}
                onChange={(e) => setNewPayeeName(e.target.value)}
                placeholder="Payee Name"
                maxLength={180}
                className="col-span-7 h-8 px-2.5 text-xs bg-white border border-slate-200 rounded"
              />
              <input
                type="text"
                value={newPayeeTin}
                onChange={(e) => setNewPayeeTin(e.target.value)}
                placeholder="TIN (optional)"
                maxLength={30}
                className="col-span-5 h-8 px-2 text-xs font-mono bg-white border border-slate-200 rounded"
              />
              <select
                value={newPayeeTplId}
                onChange={(e) => setNewPayeeTplId(e.target.value)}
                className="col-span-7 h-8 px-2 text-xs bg-white border border-slate-200 rounded"
              >
                <option value="">No default template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="col-span-5 h-8 inline-flex items-center justify-center gap-1 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Save Payee</span>
              </button>
              <input
                type="text"
                value={newPayeeNature}
                onChange={(e) => setNewPayeeNature(e.target.value)}
                placeholder="Default Nature of Transaction (optional)"
                maxLength={300}
                className="col-span-12 h-8 px-2.5 text-xs bg-white border border-slate-200 rounded"
              />
            </form>

            <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2 bg-white">
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                type="text"
                value={payeeSearch}
                onChange={(e) => setPayeeSearch(e.target.value)}
                placeholder="Search saved payees or TIN..."
                className="w-full text-xs text-slate-800 bg-transparent focus:outline-none"
              />
              {payeeSearch && (
                <button
                  type="button"
                  onClick={() => setPayeeSearch('')}
                  className="text-[11px] text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
              {filteredPayees.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">
                  No payees match your search.
                </div>
              ) : (
                filteredPayees.map((p) => {
                  const isEditing = editingPayeeId === p.id;
                  const tplObj = templates.find((t) => t.id === p.defaultTemplateId);
                  return (
                    <div key={p.id} className="px-3 py-2.5 text-xs hover:bg-slate-50">
                      {isEditing ? (
                        <div className="space-y-1.5">
                          <div className="grid grid-cols-12 gap-1.5">
                            <input
                              type="text"
                              value={editPayeeName}
                              onChange={(e) => setEditPayeeName(e.target.value)}
                              maxLength={180}
                              className="col-span-7 h-7 px-2 text-xs bg-white border border-slate-300 rounded"
                            />
                            <input
                              type="text"
                              value={editPayeeTin}
                              onChange={(e) => setEditPayeeTin(e.target.value)}
                              placeholder="TIN"
                              maxLength={30}
                              className="col-span-5 h-7 px-2 text-xs font-mono bg-white border border-slate-300 rounded"
                            />
                          </div>
                          <select
                            value={editPayeeTplId}
                            onChange={(e) => setEditPayeeTplId(e.target.value)}
                            className="w-full h-7 px-2 text-xs bg-white border border-slate-300 rounded"
                          >
                            <option value="">No default template</option>
                            {templates.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={editPayeeNature}
                              onChange={(e) => setEditPayeeNature(e.target.value)}
                              placeholder="Default nature..."
                              maxLength={300}
                              className="flex-1 h-7 px-2 text-xs bg-white border border-slate-300 rounded"
                            />
                            <button
                              type="button"
                              onClick={async () => {
                                await upsertPayee({
                                  id: p.id,
                                  name: editPayeeName,
                                  tin: editPayeeTin,
                                  defaultTemplateId: editPayeeTplId,
                                  defaultNature: editPayeeNature,
                                });
                                setEditingPayeeId(null);
                                setNotice(`Updated payee "${editPayeeName.trim()}".`);
                              }}
                              title="Save payee"
                              className="p-1 text-emerald-700 hover:bg-emerald-50 rounded cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingPayeeId(null)}
                              title="Cancel"
                              className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 truncate">
                              {p.name}
                              {p.tin && (
                                <span className="font-mono text-[10px] text-slate-400 ml-1.5">
                                  · {p.tin}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500 truncate mt-0.5">
                              {tplObj ? (
                                <span className="text-emerald-700 font-medium">{tplObj.name}</span>
                              ) : (
                                <span className="text-slate-400">No default template</span>
                              )}
                              {p.defaultNature && (
                                <span className="text-slate-400"> · {p.defaultNature}</span>
                              )}
                            </div>
                          </div>
                          <div className="inline-flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingPayeeId(p.id);
                                setEditPayeeName(p.name);
                                setEditPayeeTin(p.tin || '');
                                setEditPayeeTplId(p.defaultTemplateId || '');
                                setEditPayeeNature(p.defaultNature || '');
                              }}
                              title="Edit payee default template"
                              className="p-1 text-slate-400 hover:text-slate-800 rounded cursor-pointer"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void deletePayee(p.id)}
                              title="Delete payee"
                              className="p-1 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 font-display">
                  Workspace &amp; Fiscal Year
                </h3>
                <p className="text-xs text-slate-500">Switch fiscal ledger or create a new year.</p>
              </div>
            </div>

            <div className="space-y-1.5">
              {workspaces.map((ws) => {
                const isActiveWs = activeWorkspace?.id === ws.workspaceId;
                const canManageWs = ws.role === 'admin' || ws.role === 'auditor';
                const isEditingWs = editingWsId === ws.workspaceId;
                const isConfirmingDelete = confirmDeleteWsId === ws.workspaceId;
                const displayName = isActiveWs ? activeWorkspace.name : ws.workspaceName;

                return (
                  <div
                    key={ws.workspaceId}
                    className={`rounded border ${
                      isActiveWs
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-800 border-slate-200'
                    }`}
                  >
                    {isEditingWs ? (
                      <div className="p-2.5 bg-white text-slate-900 rounded space-y-2">
                        <div className="grid grid-cols-12 gap-2">
                          <div className="col-span-12 sm:col-span-7">
                            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">
                              Workspace Name
                            </label>
                            <input
                              type="text"
                              value={editWsName}
                              onChange={(e) => setEditWsName(e.target.value)}
                              maxLength={120}
                              className="w-full h-7 px-2 text-xs border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div className="col-span-6 sm:col-span-3">
                            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">
                              Agency Code
                            </label>
                            <input
                              type="text"
                              value={editWsAgency}
                              onChange={(e) => setEditWsAgency(e.target.value)}
                              maxLength={60}
                              className="w-full h-7 px-2 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div className="col-span-6 sm:col-span-2">
                            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">
                              Fiscal Yr
                            </label>
                            <input
                              type="number"
                              min={2020}
                              max={2099}
                              value={editWsYear}
                              onChange={(e) =>
                                setEditWsYear(parseInt(e.target.value, 10) || 2026)
                              }
                              className="w-full h-7 px-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div className="col-span-6">
                            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">
                              Default Check Prefix
                            </label>
                            <input
                              type="text"
                              value={editWsCheckPrefix}
                              onChange={(e) => setEditWsCheckPrefix(e.target.value)}
                              maxLength={20}
                              placeholder="3967"
                              className="w-full h-7 px-2 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div className="col-span-6">
                            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">
                              Default DV Prefix
                            </label>
                            <input
                              type="text"
                              value={editWsDvPrefix}
                              onChange={(e) => setEditWsDvPrefix(e.target.value)}
                              maxLength={20}
                              placeholder={`${editWsYear}-01-`}
                              className="w-full h-7 px-2 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={savingWsEdit || !editWsName.trim() || !editWsAgency.trim()}
                            onClick={async () => {
                              setSavingWsEdit(true);
                              try {
                                await updateWorkspace(ws.workspaceId, {
                                  name: editWsName.trim(),
                                  agencyCode: editWsAgency.trim(),
                                  fiscalYear: editWsYear,
                                  defaultCheckPrefix: editWsCheckPrefix.trim(),
                                  defaultDvPrefix: editWsDvPrefix.trim(),
                                });
                                setEditingWsId(null);
                                setNotice(`Updated workspace "${editWsName.trim()}".`);
                              } finally {
                                setSavingWsEdit(false);
                              }
                            }}
                            className="h-7 px-2.5 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                          >
                            {savingWsEdit ? 'Saving...' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingWsId(null)}
                            className="h-7 px-2.5 border border-slate-200 text-slate-600 text-xs rounded hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                        <button
                          type="button"
                          onClick={() => switchWorkspace(ws.workspaceId)}
                          className="flex-1 min-w-0 text-left cursor-pointer"
                        >
                          <div className={isActiveWs ? 'font-medium truncate' : 'truncate'}>
                            {displayName}
                          </div>
                          {isActiveWs && activeWorkspace && (
                            <div className="text-[10px] text-slate-300 font-mono tabular-nums mt-0.5 truncate">
                              {activeWorkspace.agencyCode} · FY {activeWorkspace.fiscalYear} · Check{' '}
                              {activeWorkspace.defaultCheckPrefix || '3967'} · DV{' '}
                              {activeWorkspace.defaultDvPrefix ||
                                `${activeWorkspace.fiscalYear}-01-`}
                            </div>
                          )}
                        </button>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="capitalize font-mono text-[11px] opacity-80">
                            {ws.role}
                          </span>
                          {canManageWs && (
                            <>
                              <button
                                type="button"
                                onClick={async () => {
                                  setConfirmDeleteWsId(null);
                                  const details =
                                    isActiveWs && activeWorkspace
                                      ? activeWorkspace
                                      : await getWorkspaceDetails(ws.workspaceId);
                                  setEditingWsId(ws.workspaceId);
                                  setEditWsName(details?.name || ws.workspaceName);
                                  setEditWsAgency(details?.agencyCode || '');
                                  const yr = details?.fiscalYear || 2026;
                                  setEditWsYear(yr);
                                  setEditWsCheckPrefix(details?.defaultCheckPrefix || '');
                                  setEditWsDvPrefix(details?.defaultDvPrefix || `${yr}-01-`);
                                }}
                                title="Edit workspace & fiscal year details"
                                className={`p-1 rounded cursor-pointer ${
                                  isActiveWs
                                    ? 'text-slate-300 hover:text-white hover:bg-slate-800'
                                    : 'text-slate-400 hover:text-slate-800 hover:bg-slate-200/70'
                                }`}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingWsId(null);
                                  setConfirmDeleteWsId(
                                    isConfirmingDelete ? null : ws.workspaceId,
                                  );
                                }}
                                title="Delete workspace"
                                className={`p-1 rounded cursor-pointer ${
                                  isActiveWs
                                    ? 'text-slate-300 hover:text-red-300 hover:bg-slate-800'
                                    : 'text-slate-400 hover:text-red-600 hover:bg-red-50'
                                }`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {isConfirmingDelete && (
                      <div className="px-3 py-2 bg-red-50 text-red-900 border-t border-red-200 rounded-b flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span>
                          Delete <strong>{displayName}</strong> and all its entries?
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={deletingWsId === ws.workspaceId}
                            onClick={async () => {
                              setDeletingWsId(ws.workspaceId);
                              try {
                                await deleteWorkspace(ws.workspaceId);
                                setConfirmDeleteWsId(null);
                                setNotice(`Deleted workspace "${displayName}".`);
                              } finally {
                                setDeletingWsId(null);
                              }
                            }}
                            className="px-2 py-1 bg-red-600 text-white font-medium rounded hover:bg-red-700 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                          >
                            {deletingWsId === ws.workspaceId ? 'Deleting...' : 'Confirm Delete'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteWsId(null)}
                            className="px-2 py-1 bg-white border border-slate-200 text-slate-700 rounded hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="pt-3 border-t border-slate-100 space-y-2.5">
              <div className="grid grid-cols-12 gap-2">
                <input
                  type="text"
                  value={newWsName}
                  onChange={(e) => setNewWsName(e.target.value)}
                  placeholder={`New Workspace (e.g., Office Ledger ${newWsYear})`}
                  className="col-span-5 h-8 px-2.5 text-xs border border-slate-200 rounded bg-slate-50"
                />
                <input
                  type="text"
                  value={newWsAgency}
                  onChange={(e) => setNewWsAgency(e.target.value)}
                  placeholder="Agency code"
                  maxLength={60}
                  className="col-span-3 h-8 px-2.5 text-xs border border-slate-200 rounded bg-slate-50"
                />
                <input
                  type="number"
                  min={2020}
                  max={2099}
                  value={newWsYear}
                  onChange={(e) => setNewWsYear(parseInt(e.target.value, 10) || 2026)}
                  className="col-span-2 h-8 px-2 text-xs font-mono tabular-nums border border-slate-200 rounded bg-slate-50"
                />
                <button
                  type="button"
                  disabled={creatingWorkspace || !newWsName.trim() || !newWsAgency.trim()}
                  onClick={async () => {
                    if (!newWsName.trim() || !newWsAgency.trim() || creatingWorkspace) return;
                    setCreatingWorkspace(true);
                    try {
                      await createWorkspace(newWsName.trim(), newWsAgency.trim(), newWsYear, {
                        carryForwardFromCurrent: carryForwardSetup,
                      });
                      setNewWsName('');
                      setNotice(
                        carryForwardSetup
                          ? 'Created new fiscal workspace with carried-forward COA, Payees, and Smart Templates (0 transactions).'
                          : 'Created and switched to a new empty workspace — add COA, templates and payees as you go.',
                      );
                    } finally {
                      setCreatingWorkspace(false);
                    }
                  }}
                  className="col-span-2 h-8 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  {creatingWorkspace ? 'Creating...' : 'Create'}
                </button>
              </div>

              {activeWorkspace && (
                <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={carryForwardSetup}
                    onChange={(e) => setCarryForwardSetup(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <span>
                    <span className="font-medium text-slate-800">
                      Carry forward COA &amp; Payees from current workspace
                    </span>
                    <span className="block text-[11px] text-slate-500 mt-0.5 tabular-nums">
                      {carryForwardSetup
                        ? `Copies ${customCoaAccounts.length} COA · ${payees.length} payees · ${templates.length} templates into the new year (0 transactions).`
                        : 'Starts with an empty workspace — add COA, templates and payees as you go (0 transactions).'}
                    </span>
                  </span>
                </label>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 font-display">
                Office Team Collaboration
              </h3>
              <p className="text-xs text-slate-500">
                Invite encoders or COA auditors via verified Google email. They must sign
                in with that Google account and accept the invitation — share the app URL
                with them.
              </p>
            </div>

            {teamError && (
              <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-xs text-red-800 flex items-center justify-between gap-2">
                <span>{teamError}</span>
                <button
                  type="button"
                  onClick={() => setTeamError(null)}
                  title="Dismiss"
                  className="text-red-700 hover:text-red-900 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {canManageTeam && (
              <form onSubmit={handleInvite} className="grid grid-cols-12 gap-2">
                <input
                  type="email"
                  required
                  disabled={teamBusy}
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@gmail.com"
                  className="col-span-6 h-8 px-2.5 text-xs border border-slate-200 rounded bg-slate-50 disabled:opacity-50"
                />
                <select
                  disabled={teamBusy}
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'encoder' | 'auditor')}
                  className="col-span-3 h-8 px-2 text-xs border border-slate-200 rounded bg-slate-50 disabled:opacity-50"
                >
                  <option value="encoder">Encoder</option>
                  <option value="auditor">Auditor</option>
                </select>
                <button
                  type="submit"
                  disabled={teamBusy}
                  className="col-span-3 h-8 inline-flex items-center justify-center gap-1 bg-slate-900 text-white text-xs font-medium rounded hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>Invite</span>
                </button>
              </form>
            )}

            <div className="divide-y divide-slate-100 text-xs">
              {members.map((m) => {
                const isOwner = m.uid === m.workspaceOwnerUid;
                const isSelf = m.uid === user?.uid;
                const editable = canManageTeam && !isOwner && !isSelf;
                return (
                  <div key={m.uid} className="py-2 flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-900 truncate">{m.displayName}</span>
                    {editable ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <select
                          value={m.role}
                          disabled={teamBusy}
                          onChange={(e) =>
                            void handleRoleChange(m, e.target.value as WorkspaceRole)
                          }
                          aria-label={`Role for ${m.displayName}`}
                          className="h-7 px-1.5 text-[11px] border border-slate-200 rounded bg-slate-50 disabled:opacity-50 cursor-pointer"
                        >
                          <option value="encoder">Encoder</option>
                          <option value="auditor">Auditor</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button
                          type="button"
                          disabled={teamBusy}
                          onClick={() => void handleRemoveMember(m)}
                          title="Remove member"
                          className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-50 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span className="capitalize font-mono text-[11px] text-slate-500 shrink-0">
                        {m.role}
                        {isOwner ? ' · owner' : ''}
                        {isSelf && !isOwner ? ' · you' : ''}
                      </span>
                    )}
                  </div>
                );
              })}
              {sentInvites
                .filter((i) => i.status === 'pending')
                .map((inv) => (
                  <div key={inv.id} className="py-2 flex items-center justify-between gap-2 text-amber-700">
                    <span className="truncate">{inv.invitedEmail}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span className="font-mono text-[11px]">Pending ({inv.role})</span>
                      {canManageTeam && (
                        <button
                          type="button"
                          disabled={teamBusy}
                          onClick={() => void handleRevokeInvite(inv)}
                          title="Revoke invitation"
                          className="p-1 text-amber-600 hover:text-red-600 disabled:opacity-50 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
