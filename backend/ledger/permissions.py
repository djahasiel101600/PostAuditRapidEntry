"""DRF permission classes ported from firestore.rules role semantics."""
from rest_framework.permissions import BasePermission

from .services import get_role, is_member, is_superadmin


class WorkspacePermission(BasePermission):
    """Base: resolves the workspace from URL kwargs and checks membership.

    Subclasses set `write_roles` to restrict mutating actions.
    Read access requires membership (or superadmin).
    """

    write_roles = None  # None = any member may write

    def get_workspace(self, view):
        from .models import Workspace

        ws_id = view.kwargs.get('workspace_id') or view.kwargs.get('pk')
        if not ws_id:
            return None
        return Workspace.objects.filter(pk=ws_id).first()

    def has_permission(self, request, view):
        workspace = self.get_workspace(view)
        if workspace is None:
            return False
        view.workspace = workspace
        user = request.user
        if request.method in ('GET', 'HEAD', 'OPTIONS'):
            return is_member(user, workspace) or is_superadmin(user)
        if not is_member(user, workspace):
            return False
        if self.write_roles is None:
            return True
        return get_role(user, workspace) in self.write_roles


class IsWorkspaceMember(WorkspacePermission):
    write_roles = None


class IsWorkspaceAuditorOrAdmin(WorkspacePermission):
    write_roles = ('admin', 'auditor')


class IsWorkspaceAdmin(WorkspacePermission):
    write_roles = ('admin',)