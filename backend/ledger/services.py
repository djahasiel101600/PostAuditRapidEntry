"""Shared helpers: membership lookups and server-maintained authorizedUids."""
from django.conf import settings

from .models import CoaAccount, EntryTemplate, Payee, TaxPreset, Transaction, WorkspaceMember


def is_superadmin(user):
    return bool(
        user
        and user.is_authenticated
        and user.email
        and user.email.lower() == settings.SUPERADMIN_EMAIL.lower()
    )


def get_role(user, workspace):
    """Return the user's role in the workspace, or None if not a member."""
    if not user or not user.is_authenticated:
        return None
    membership = WorkspaceMember.objects.filter(workspace=workspace, user=user).first()
    return membership.role if membership else None


def is_member(user, workspace):
    return get_role(user, workspace) is not None


def is_admin(user, workspace):
    return get_role(user, workspace) == 'admin'


def is_auditor_or_admin(user, workspace):
    return get_role(user, workspace) in ('admin', 'auditor')


def sync_authorized_uids(workspace):
    """Server-maintained replacement for the client syncWorkspaceAccessToRecords.

    Every workspace record is visible to all workspace members; keep the
    legacy authorizedUids field in sync for frontend type compatibility.
    """
    uids = workspace.memberUids
    for model in (Transaction, EntryTemplate, Payee, CoaAccount, TaxPreset):
        model.objects.filter(workspace=workspace).exclude(authorizedUids=uids).update(
            authorizedUids=uids
        )