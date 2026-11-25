import type { ViewModule } from '../types/rci';

/**
 * "Get Started" tutorial definition. Auto steps are derived live from
 * workspace data (never persisted); manual steps and the hidden flag are
 * persisted per user in localStorage.
 */
export interface GetStartedStep {
  id: string;
  title: string;
  description: string;
  target: ViewModule;
  kind: 'auto' | 'manual';
  optional?: boolean;
}

export const GET_STARTED_STEPS: GetStartedStep[] = [
  {
    id: 'create-workspace',
    title: 'Create your workspace',
    description:
      'A workspace holds one fiscal year of records. You can add more fiscal years later in Templates & Team.',
    target: 'settings',
    kind: 'auto',
  },
  {
    id: 'setup-coa',
    title: 'Set up your Chart of Accounts',
    description:
      'Add your office account codes in Templates & Team, or import them from a file/paste. Your accounts drive tax classification and journal verification.',
    target: 'settings',
    kind: 'auto',
  },
  {
    id: 'create-template',
    title: 'Create a Smart Template',
    description:
      'Templates pre-fill the tax split and journal accounts for recurring payments (e.g., meals, utilities, supplies).',
    target: 'settings',
    kind: 'auto',
  },
  {
    id: 'first-entry',
    title: 'Record your first entry',
    description:
      'Use Rapid Entry: pick a template or type a payee, enter the gross amount, and the tax split and journal lines are computed for you.',
    target: 'entry',
    kind: 'auto',
  },
  {
    id: 'review-ledger',
    title: 'Review the Monthly Ledger',
    description:
      'The ledger lists every entry for the selected month with its audit attributes. Open one to see the double-entry verification.',
    target: 'ledger',
    kind: 'manual',
  },
  {
    id: 'explore-dashboard',
    title: 'Explore Dashboard & Lacking Queue',
    description:
      'The dashboard summarizes totals and daily progress; the Lacking Queue collects entries with flagged documents or tax discrepancies.',
    target: 'dashboard',
    kind: 'manual',
  },
  {
    id: 'invite-team',
    title: 'Invite a teammate',
    description:
      'Optional: invite encoders or COA auditors by Google email from Templates & Team. They accept the invite after signing in.',
    target: 'settings',
    kind: 'auto',
    optional: true,
  },
];

export interface GetStartedProgressInput {
  workspaceCount: number;
  coaCount: number;
  templateCount: number;
  transactionCount: number;
  inviteCount: number;
  memberCount: number;
}

export function isStepComplete(
  step: GetStartedStep,
  input: GetStartedProgressInput,
  manualDone: ReadonlyArray<string>,
): boolean {
  if (step.kind === 'manual') return manualDone.includes(step.id);
  switch (step.id) {
    case 'create-workspace':
      return input.workspaceCount > 0;
    case 'setup-coa':
      return input.coaCount > 0;
    case 'create-template':
      return input.templateCount > 0;
    case 'first-entry':
      return input.transactionCount > 0;
    case 'invite-team':
      return input.inviteCount > 0 || input.memberCount > 1;
    default:
      return false;
  }
}

export function countCompleted(
  input: GetStartedProgressInput,
  manualDone: ReadonlyArray<string>,
): number {
  return GET_STARTED_STEPS.filter((s) => isStepComplete(s, input, manualDone)).length;
}

export interface GuidePersistedState {
  hidden: boolean;
  manualDone: string[];
}

const storageKey = (uid: string) => `rci_get_started_${uid}`;

export function loadGuideState(uid: string): GuidePersistedState {
  try {
    const raw = localStorage.getItem(storageKey(uid));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GuidePersistedState>;
      return {
        hidden: Boolean(parsed.hidden),
        manualDone: Array.isArray(parsed.manualDone) ? parsed.manualDone : [],
      };
    }
  } catch {
    // ignore corrupt/unavailable storage
  }
  return { hidden: false, manualDone: [] };
}

export function saveGuideState(uid: string, state: GuidePersistedState): void {
  try {
    localStorage.setItem(storageKey(uid), JSON.stringify(state));
  } catch {
    // ignore storage failure
  }
}