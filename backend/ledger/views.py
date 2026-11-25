"""API views implementing the firestore.rules permission semantics."""
from django.db import transaction as db_transaction
from django.shortcuts import get_object_or_404
from rest_framework import status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.mixins import DestroyModelMixin, ListModelMixin, UpdateModelMixin
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import philgeps
from .models import (
    CoaAccount,
    EntryTemplate,
    Payee,
    TaxPreset,
    Transaction,
    Workspace,
    WorkspaceInvite,
    WorkspaceMember,
)
from .permissions import IsWorkspaceAuditorOrAdmin, IsWorkspaceMember
from .serializers import (
    CoaAccountSerializer,
    EntryTemplateSerializer,
    PayeeSerializer,
    TaxPresetSerializer,
    TransactionSerializer,
    WorkspaceInviteSerializer,
    WorkspaceMemberSerializer,
    WorkspaceSerializer,
    changed_keys,
)
from .services import (
    get_role,
    is_admin,
    is_auditor_or_admin,
    is_member,
    is_superadmin,
    sync_authorized_uids,
)

# Field allowlists ported from firestore.rules transaction update branches
TX_AUDIT_FIELDS = {
    'attributes', 'dvSignatories', 'testOfControls', 'remarks', 'status', 'clerkReviewStatus',
    'documentaryStatus', 'verificationAuditTrail', 'submittedToCoaDate', 'jevNoDate',
}
TX_FULL_EDIT_FIELDS = {
    'month', 'sequenceNo', 'adaCheckDate', 'adaCheckNo', 'dvNo', 'dateReceived',
    'orNoDate', 'asaNo', 'jevNoDate', 'payeeName', 'natureOfTransaction',
    'grossAmount', 'netAmount', 'taxWithheld', 'rciAmount', 'declaredJevGross',
    'grossBasisOverride', 'taxComponents', 'mathStatus', 'taxStatus',
    'documentaryStatus', 'clerkReviewStatus', 'verificationAuditTrail',
    'amountModelVersion', 'legacySnapshot', 'templateId', 'journalLines',
    'isBalanced', 'attributes', 'dvSignatories', 'procurement', 'testOfControls', 'remarks',
    'status', 'submittedToCoaDate',
}
WORKSPACE_EDIT_FIELDS = {
    'name', 'agencyCode', 'fiscalYear', 'defaultCheckPrefix', 'defaultDvPrefix', 'coaInitialized',
}


class WorkspaceViewSet(viewsets.ModelViewSet):
    serializer_class = WorkspaceSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if is_superadmin(user):
            return Workspace.objects.all()
        return Workspace.objects.filter(members__user=user)

    def perform_create(self, serializer):
        with db_transaction.atomic():
            workspace = serializer.save(owner=self.request.user)
            user = self.request.user
            WorkspaceMember.objects.create(
                workspace=workspace,
                user=user,
                displayName=user.first_name or user.email.split('@')[0],
                role='admin',
            )

    def _check_write(self, request, workspace):
        if not (is_auditor_or_admin(request.user, workspace) or is_superadmin(request.user)):
            raise PermissionDenied('Only auditors or admins may modify this workspace.')

    def update(self, request, *args, **kwargs):
        kwargs['partial'] = True
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        workspace = serializer.instance
        self._check_write(self.request, workspace)
        changed = changed_keys(workspace, serializer.validated_data)
        if not changed <= WORKSPACE_EDIT_FIELDS:
            raise PermissionDenied('Field not editable with your role.')
        serializer.save()

    def perform_destroy(self, instance):
        self._check_write(self.request, instance)
        instance.delete()


class WorkspaceNestedViewSet(viewsets.ModelViewSet):
    """Base for workspace-scoped record viewsets (membership enforced by permission)."""

    permission_classes = [IsWorkspaceMember]
    model = None

    def get_queryset(self):
        return self.model.objects.filter(workspace_id=self.kwargs['workspace_id'])

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['workspace'] = self.workspace
        return context

    def update(self, request, *args, **kwargs):
        kwargs['partial'] = True
        return super().update(request, *args, **kwargs)

    def upsert(self, item, request, workspace, partial_on_existing=True):
        """Create or update a record by client-supplied id (Firestore set semantics)."""
        record_id = item.get('id')
        existing = self.model.objects.filter(pk=record_id, workspace=workspace).first() if record_id else None
        if existing is not None:
            serializer = self.get_serializer(existing, data=item, partial=partial_on_existing)
        else:
            serializer = self.get_serializer(data=item)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return serializer.instance, existing is None


class TransactionViewSet(WorkspaceNestedViewSet):
    model = Transaction
    serializer_class = TransactionSerializer

    def perform_create(self, serializer):
        data = serializer.validated_data
        if data.get('status') == 'audited':
            raise ValidationError('New transactions cannot be created as audited.')
        if data.get('clerkReviewStatus') == 'audited':
            raise ValidationError('New transactions cannot have audited clerk review.')
        serializer.save()

    def _apply_patch(self, request, instance):
        workspace = instance.workspace
        user = request.user
        role = get_role(user, workspace)
        serializer = self.get_serializer(instance, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        if (
            instance.legacySnapshot is not None
            and 'legacySnapshot' in data
            and data['legacySnapshot'] != instance.legacySnapshot
        ):
            raise PermissionDenied('legacySnapshot is immutable once captured.')

        if instance.status == 'audited':
            if not (role in ('admin', 'auditor') or is_superadmin(user)):
                raise PermissionDenied('Audited transactions may only be updated by auditors/admins.')
            allowed = TX_AUDIT_FIELDS | {'procurement'}
        else:
            setting_audited = (
                data.get('status') == 'audited' or data.get('clerkReviewStatus') == 'audited'
            )
            if setting_audited:
                if role not in ('admin', 'auditor'):
                    raise PermissionDenied('Only auditors/admins may mark transactions audited.')
                allowed = TX_AUDIT_FIELDS
            else:
                allowed = TX_FULL_EDIT_FIELDS

        changed = changed_keys(instance, data)
        if not changed <= allowed:
            raise PermissionDenied('Field not editable for this transaction state/role.')
        serializer.save()
        return serializer.instance

    def update(self, request, *args, **kwargs):
        return self.partial_update(request, *args, **kwargs)

    def partial_update(self, request, *args, **kwargs):
        instance = self._apply_patch(request, self.get_object())
        return Response(self.get_serializer(instance).data)

    def perform_destroy(self, instance):
        user = self.request.user
        workspace = instance.workspace
        allowed = (
            is_auditor_or_admin(user, workspace)
            or is_superadmin(user)
            or (instance.status != 'audited' and instance.createdByUid == user.username)
        )
        if not allowed:
            raise PermissionDenied('You may not delete this transaction.')
        instance.delete()

    @action(detail=True, methods=['post'], url_path='upgrade-v2')
    def upgrade_v2(self, request, workspace_id, pk):
        instance = self._apply_patch(request, self.get_object())
        return Response(self.get_serializer(instance).data)

    @action(detail=False, methods=['post'])
    def batch(self, request, workspace_id):
        items = request.data.get('items')
        if not isinstance(items, list) or not items or len(items) > 1000:
            raise ValidationError('items must be a non-empty list (max 1000).')
        workspace = self.workspace
        records = []
        created = 0
        with db_transaction.atomic():
            for item in items:
                if item.get('status') == 'audited' or item.get('clerkReviewStatus') == 'audited':
                    raise ValidationError('Batch items cannot be audited.')
                record, was_created = self.upsert(item, request, workspace)
                records.append(record)
                created += 1 if was_created else 0
        return Response(
            {
                'created': created,
                'count': len(records),
                'records': self.get_serializer(records, many=True).data,
            },
            status=status.HTTP_201_CREATED,
        )


class RecordViewSet(WorkspaceNestedViewSet):
    """Templates / Payees / COA: member CRUD; delete = auditor/admin or creator."""

    def perform_destroy(self, instance):
        user = self.request.user
        if not (
            is_auditor_or_admin(user, instance.workspace)
            or is_superadmin(user)
            or instance.createdByUid == user.username
        ):
            raise PermissionDenied('Only auditors/admins or the creator may delete this record.')
        instance.delete()


class EntryTemplateViewSet(RecordViewSet):
    model = EntryTemplate
    serializer_class = EntryTemplateSerializer

    def create(self, request, *args, **kwargs):
        record, _ = self.upsert(request.data, request, self.workspace)
        return Response(self.get_serializer(record).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['post'])
    def batch(self, request, workspace_id):
        items = request.data.get('items')
        if not isinstance(items, list) or not items or len(items) > 1000:
            raise ValidationError('items must be a non-empty list (max 1000).')
        records = []
        with db_transaction.atomic():
            for item in items:
                record, _ = self.upsert(item, request, self.workspace)
                records.append(record)
        return Response(
            {'count': len(records), 'records': self.get_serializer(records, many=True).data},
            status=status.HTTP_201_CREATED,
        )


class PayeeViewSet(RecordViewSet):
    model = Payee
    serializer_class = PayeeSerializer

    def create(self, request, *args, **kwargs):
        record, _ = self.upsert(request.data, request, self.workspace)
        return Response(self.get_serializer(record).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['post'])
    def batch(self, request, workspace_id):
        """Ensure-by-name semantics (batchEnsurePayees) or upsert-by-id (carry-forward)."""
        items = request.data.get('items')
        ensure_only = bool(request.data.get('ensureOnly'))
        if not isinstance(items, list) or not items or len(items) > 1000:
            raise ValidationError('items must be a non-empty list (max 1000).')
        workspace = self.workspace
        records = []
        with db_transaction.atomic():
            for item in items:
                name = (item.get('name') or '').strip()
                if not name or name == 'Unnamed Payee':
                    continue
                existing = None
                if item.get('id'):
                    existing = Payee.objects.filter(pk=item['id'], workspace=workspace).first()
                if existing is None:
                    existing = Payee.objects.filter(workspace=workspace, name__iexact=name).first()
                if existing is not None:
                    if ensure_only:
                        if item.get('defaultTemplateId') and not existing.defaultTemplateId:
                            existing.defaultTemplateId = item['defaultTemplateId'][:128]
                            existing.save(update_fields=['defaultTemplateId', 'updatedAt'])
                    else:
                        serializer = self.get_serializer(existing, data=item, partial=True)
                        serializer.is_valid(raise_exception=True)
                        serializer.save()
                    records.append(existing)
                else:
                    serializer = self.get_serializer(data=item)
                    serializer.is_valid(raise_exception=True)
                    serializer.save()
                    records.append(serializer.instance)
        return Response(
            {'count': len(records), 'records': self.get_serializer(records, many=True).data},
            status=status.HTTP_201_CREATED,
        )


class CoaAccountViewSet(RecordViewSet):
    model = CoaAccount
    serializer_class = CoaAccountSerializer

    def create(self, request, *args, **kwargs):
        record, _ = self.upsert(request.data, request, self.workspace)
        return Response(self.get_serializer(record).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['post'], url_path='batch')
    def batch(self, request, workspace_id):
        items = request.data.get('items')
        if not isinstance(items, list) or not items or len(items) > 1000:
            raise ValidationError('items must be a non-empty list (max 1000).')
        workspace = self.workspace
        records = []
        created = 0
        with db_transaction.atomic():
            for item in items:
                code = (item.get('code') or '').strip()
                title = (item.get('title') or '').strip()
                if not code or not title:
                    continue
                existing = None
                if item.get('id'):
                    existing = CoaAccount.objects.filter(pk=item['id'], workspace=workspace).first()
                if existing is None:
                    # dedupe on code+title (batchCreateCoaAccounts semantics)
                    duplicate = next(
                        (
                            a
                            for a in CoaAccount.objects.filter(workspace=workspace)
                            if a.code.strip().lower() == code.lower()
                            and a.title.strip().lower() == title.lower()
                        ),
                        None,
                    )
                    if duplicate is not None:
                        continue
                record, was_created = self.upsert(item, request, workspace)
                records.append(record)
                created += 1 if was_created else 0
        return Response(
            {
                'created': created,
                'count': len(records),
                'records': self.get_serializer(records, many=True).data,
            },
            status=status.HTTP_201_CREATED,
        )


class TaxPresetViewSet(WorkspaceNestedViewSet):
    model = TaxPreset
    serializer_class = TaxPresetSerializer
    permission_classes = [IsWorkspaceAuditorOrAdmin]

    def create(self, request, *args, **kwargs):
        record, _ = self.upsert(request.data, request, self.workspace)
        return Response(self.get_serializer(record).data, status=status.HTTP_201_CREATED)


class WorkspaceMemberViewSet(ListModelMixin, UpdateModelMixin, DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = WorkspaceMemberSerializer
    permission_classes = [IsWorkspaceMember]

    def get_queryset(self):
        return WorkspaceMember.objects.filter(workspace_id=self.kwargs['workspace_id'])

    def get_object(self):
        return get_object_or_404(self.get_queryset(), user__username=self.kwargs['pk'])

    def list(self, request, *args, **kwargs):
        workspace = self.workspace
        queryset = self.get_queryset()
        if not (is_admin(request.user, workspace) or workspace.owner_id == request.user.id):
            queryset = queryset.filter(user=request.user)
        return Response(self.get_serializer(queryset, many=True).data)

    def update(self, request, *args, **kwargs):
        kwargs['partial'] = True
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        member = serializer.instance
        if not is_admin(self.request.user, member.workspace):
            raise PermissionDenied('Only admins may change member roles.')
        if member.user_id == member.workspace.owner_id and serializer.validated_data.get('role') not in (None, 'admin'):
            raise PermissionDenied('The workspace owner must remain admin.')
        serializer.save()

    def perform_destroy(self, instance):
        if not is_admin(self.request.user, instance.workspace):
            raise PermissionDenied('Only admins may remove members.')
        if instance.user_id == instance.workspace.owner_id:
            raise PermissionDenied('The workspace owner cannot be removed.')
        workspace = instance.workspace
        instance.delete()
        sync_authorized_uids(workspace)


class WorkspaceInviteViewSet(ListModelMixin, DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = WorkspaceInviteSerializer
    permission_classes = [IsWorkspaceMember]

    def get_queryset(self):
        return WorkspaceInvite.objects.filter(workspace_id=self.kwargs['workspace_id'])

    def list(self, request, *args, **kwargs):
        workspace = self.workspace
        if is_admin(request.user, workspace) or workspace.owner_id == request.user.id:
            return Response(self.get_serializer(self.get_queryset(), many=True).data)
        return Response([])

    def create(self, request, *args, **kwargs):
        workspace = self.workspace
        if not is_admin(request.user, workspace):
            raise PermissionDenied('Only admins may invite members.')
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(
            workspace=workspace,
            workspaceName=workspace.name,
            workspaceOwnerUid=workspace.ownerUid,
            createdByUid=request.user.username,
            status='pending',
        )
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    def perform_destroy(self, instance):
        if not is_auditor_or_admin(self.request.user, instance.workspace):
            raise PermissionDenied('Only auditors/admins may delete invites.')
        instance.delete()


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def accept_invite(request, pk):
    invite = get_object_or_404(WorkspaceInvite, pk=pk)
    user = request.user
    if invite.invitedEmail.lower() != (user.email or '').lower():
        raise PermissionDenied('This invite was issued to a different email.')
    if invite.status != 'pending':
        raise ValidationError('Invite is no longer pending.')
    with db_transaction.atomic():
        WorkspaceMember.objects.get_or_create(
            workspace=invite.workspace,
            user=user,
            defaults={
                'displayName': user.first_name or user.email.split('@')[0],
                'role': invite.role,
                'inviteId': invite.id,
            },
        )
        invite.status = 'accepted'
        invite.save(update_fields=['status', 'updatedAt'])
        sync_authorized_uids(invite.workspace)
    return Response(
        {
            'invite': WorkspaceInviteSerializer(invite).data,
            'workspace': WorkspaceSerializer(invite.workspace).data,
        }
    )


class MyWorkspacesView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        links = []
        for membership in WorkspaceMember.objects.filter(user=user).select_related('workspace'):
            links.append(
                {
                    'id': f'{user.username}_{membership.workspace_id}'[:128],
                    'uid': user.username,
                    'workspaceId': membership.workspace_id,
                    'workspaceName': membership.workspace.name,
                    'role': membership.role,
                    'joinedAt': membership.joinedAt.isoformat(),
                }
            )
        return Response(links)


class MyInvitesView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        email = (request.user.email or '').lower()
        invites = WorkspaceInvite.objects.filter(invitedEmail=email, status='pending')
        return Response(WorkspaceInviteSerializer(invites, many=True).data)


class PhilGepsLookupView(APIView):
    """Look up a payee in the public PhilGEPS registered-merchants registry."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        name = ' '.join(str(request.query_params.get('name', '')).split())[:120]
        if len(name) < 3:
            return Response(
                {'detail': 'Payee name too short.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        force_refresh = request.query_params.get('refresh') == '1'
        try:
            payload = philgeps.lookup(name, force_refresh=force_refresh)
        except philgeps.PhilGepsError:
            return Response(
                {'detail': 'PhilGEPS is unavailable right now - enter the date manually.'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response(payload)
