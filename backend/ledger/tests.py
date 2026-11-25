"""Permission/validation tests ported from tests/firestore-rules.test.ts."""
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from .models import CoaAccount, Transaction, Workspace, WorkspaceInvite, WorkspaceMember

User = get_user_model()

ATTRS_OK = {f'a{i}': 'ok' for i in range(1, 8)}


def make_user(uid, email=None):
    return User.objects.create_user(
        username=uid, email=email or f'{uid}@example.com', first_name=uid.title()
    )


def make_workspace(owner, ws_id='ws-test'):
    workspace = Workspace.objects.create(
        id=ws_id, name='Test Workspace', agencyCode='NIA-TEST', fiscalYear=2026, owner=owner
    )
    WorkspaceMember.objects.create(
        workspace=workspace, user=owner, displayName=owner.first_name, role='admin'
    )
    return workspace


def add_member(workspace, user, role):
    return WorkspaceMember.objects.create(
        workspace=workspace, user=user, displayName=user.first_name, role=role
    )


def tx_payload(ws_id, tx_id='tx-1', **overrides):
    payload = {
        'id': tx_id,
        'workspaceId': ws_id,
        'month': 'January',
        'sequenceNo': 1,
        'adaCheckDate': '2026-01-05',
        'adaCheckNo': '3967001',
        'dvNo': '2026-01-0001',
        'payeeName': 'Test Payee',
        'natureOfTransaction': 'Office supplies',
        'grossAmount': 100.0,
        'netAmount': 95.0,
        'taxWithheld': 5.0,
        'journalLines': [
            {'accountCode': '50203010', 'accountTitle': 'Office Supplies', 'debit': 100.0, 'credit': 0},
            {'accountCode': '10102020', 'accountTitle': 'Cash in Bank', 'debit': 0, 'credit': 95.0},
            {'accountCode': '20201010', 'accountTitle': 'Due to BIR', 'debit': 0, 'credit': 5.0},
        ],
        'isBalanced': True,
        'attributes': dict(ATTRS_OK),
        'status': 'posted',
    }
    payload.update(overrides)
    return payload


class WorkspaceTestBase(APITestCase):
    def setUp(self):
        self.admin = make_user('uid-admin')
        self.auditor = make_user('uid-auditor')
        self.encoder = make_user('uid-encoder')
        self.outsider = make_user('uid-outsider')
        self.workspace = make_workspace(self.admin)
        add_member(self.workspace, self.auditor, 'auditor')
        add_member(self.workspace, self.encoder, 'encoder')
        self.tx_url = f'/api/workspaces/{self.workspace.id}/transactions/'

    def as_user(self, user):
        self.client.force_authenticate(user=user)


class TransactionRuleTests(WorkspaceTestBase):
    def test_empty_journal_lines_only_allowed_for_draft(self):
        self.as_user(self.encoder)
        draft = tx_payload(self.workspace.id, 'tx-draft', status='draft', journalLines=[], isBalanced=False)
        response = self.client.post(self.tx_url, draft, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        posted = tx_payload(self.workspace.id, 'tx-posted', journalLines=[])
        response = self.client.post(self.tx_url, posted, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_members_cannot_read_or_write(self):
        self.as_user(self.encoder)
        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')

        self.as_user(self.outsider)
        self.assertEqual(self.client.get(self.tx_url).status_code, status.HTTP_403_FORBIDDEN)
        response = self.client.post(self.tx_url, tx_payload(self.workspace.id, 'tx-x'), format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get(self.tx_url).status_code, status.HTTP_401_UNAUTHORIZED)

    def test_encoder_cannot_audited_auditor_can(self):
        self.as_user(self.encoder)
        # create directly as audited -> denied
        response = self.client.post(
            self.tx_url, tx_payload(self.workspace.id, status='audited'), format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')
        # encoder patch to audited -> denied
        response = self.client.patch(self.tx_url + 'tx-1/', {'status': 'audited'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        # auditor approves
        self.as_user(self.auditor)
        response = self.client.patch(
            self.tx_url + 'tx-1/',
            {'status': 'audited', 'clerkReviewStatus': 'audited'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # audited record: encoder cannot edit, auditor can edit audit fields
        self.as_user(self.encoder)
        response = self.client.patch(self.tx_url + 'tx-1/', {'remarks': 'hack'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        self.as_user(self.auditor)
        response = self.client.patch(self.tx_url + 'tx-1/', {'remarks': 'reviewed'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # audited record: amount edits denied even for auditor
        response = self.client.patch(self.tx_url + 'tx-1/', {'grossAmount': 999}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_legacy_snapshot_immutable_once_captured(self):
        snapshot = {
            'grossAmount': 100.0, 'netAmount': 95.0, 'taxWithheld': 5.0,
            'status': 'posted', 'capturedAt': '2026-01-05T00:00:00Z', 'capturedByUid': 'uid-encoder',
        }
        self.as_user(self.encoder)
        response = self.client.post(
            self.tx_url, tx_payload(self.workspace.id, legacySnapshot=snapshot), format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        altered = dict(snapshot, netAmount=1.0)
        response = self.client.patch(self.tx_url + 'tx-1/', {'legacySnapshot': altered}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_delete_rules(self):
        self.as_user(self.encoder)
        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')
        self.client.post(self.tx_url, tx_payload(self.workspace.id, 'tx-2'), format='json')

        # creator can delete own non-audited record
        response = self.client.delete(self.tx_url + 'tx-1/')
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

        # auditor can delete any record
        self.as_user(self.auditor)
        response = self.client.delete(self.tx_url + 'tx-2/')
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

    def test_batch_create(self):
        self.as_user(self.encoder)
        items = [tx_payload(self.workspace.id, f'tx-b{i}', sequenceNo=i + 1) for i in range(3)]
        response = self.client.post(self.tx_url + 'batch/', {'items': items}, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['created'], 3)
        self.assertEqual(Transaction.objects.filter(workspace=self.workspace).count(), 3)

    def test_server_owns_created_by_and_authorized_uids(self):
        self.as_user(self.encoder)
        response = self.client.post(
            self.tx_url,
            tx_payload(self.workspace.id, createdByUid='uid-admin', authorizedUids=['uid-admin']),
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['createdByUid'], 'uid-encoder')
        self.assertCountEqual(
            response.data['authorizedUids'], ['uid-admin', 'uid-auditor', 'uid-encoder']
        )


class CoaAndTaxPresetTests(WorkspaceTestBase):
    def test_coa_account_class_validation(self):
        self.as_user(self.encoder)
        url = f'/api/workspaces/{self.workspace.id}/coa-accounts/'
        response = self.client.post(
            url,
            {'id': 'coa-1', 'code': '50203010', 'title': 'Supplies', 'normalSide': 'debit', 'accountClass': 'bogus'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        response = self.client.post(
            url,
            {'id': 'coa-1', 'code': '50203010', 'title': 'Supplies', 'normalSide': 'debit', 'accountClass': 'settlement_debit'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_tax_preset_rbac(self):
        url = f'/api/workspaces/{self.workspace.id}/tax-presets/'
        preset = {
            'id': 'trp-1', 'name': 'EWT 2%', 'version': '2026.1', 'effectiveFrom': '2026-01-01',
            'applicableClassification': 'Services', 'birReference': 'RR 11-2018',
            'defaultBirAccountCode': '20201010', 'defaultBirAccountTitle': 'Due to BIR',
            'rate': 0.02, 'defaultTaxBaseType': 'gross_total', 'roundingMethod': 'half_up_2dp',
            'computationRule': 'Tax Base x Rate',
        }
        self.as_user(self.encoder)
        self.assertEqual(self.client.post(url, preset, format='json').status_code, status.HTTP_403_FORBIDDEN)

        self.as_user(self.auditor)
        self.assertEqual(self.client.post(url, preset, format='json').status_code, status.HTTP_201_CREATED)
        # upsert same id (version bump)
        response = self.client.post(url, dict(preset, version='2026.2'), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['version'], '2026.2')


class InviteFlowTests(WorkspaceTestBase):
    def test_invite_accept_flow_and_authorized_sync(self):
        self.as_user(self.encoder)
        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')

        invitee = make_user('uid-invitee', 'invitee@example.com')
        self.as_user(self.admin)
        response = self.client.post(
            f'/api/workspaces/{self.workspace.id}/invites/',
            {'id': 'inv-1', 'invitedEmail': 'Invitee@Example.com', 'role': 'encoder'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['invitedEmail'], 'invitee@example.com')

        # wrong user cannot accept
        self.as_user(self.outsider)
        response = self.client.post('/api/invites/inv-1/accept/')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        # invitee sees pending invite and accepts
        self.as_user(invitee)
        response = self.client.get('/api/me/invites/')
        self.assertEqual(len(response.data), 1)
        response = self.client.post('/api/invites/inv-1/accept/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(
            WorkspaceMember.objects.filter(workspace=self.workspace, user=invitee, role='encoder').exists()
        )
        self.assertEqual(WorkspaceInvite.objects.get(pk='inv-1').status, 'accepted')
        # existing records now include the new member
        self.assertIn('uid-invitee', Transaction.objects.get(pk='tx-1').authorizedUids)

        # double accept rejected
        response = self.client.post('/api/invites/inv-1/accept/')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_encoder_cannot_invite(self):
        self.as_user(self.encoder)
        response = self.client.post(
            f'/api/workspaces/{self.workspace.id}/invites/',
            {'id': 'inv-2', 'invitedEmail': 'x@example.com', 'role': 'encoder'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)


class WorkspaceAndMemberTests(WorkspaceTestBase):
    def test_workspace_update_roles(self):
        url = f'/api/workspaces/{self.workspace.id}/'
        self.as_user(self.encoder)
        response = self.client.patch(url, {'name': 'Renamed'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        self.as_user(self.auditor)
        response = self.client.patch(url, {'name': 'Renamed'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_workspace_create_creates_admin_membership(self):
        self.as_user(self.outsider)
        response = self.client.post(
            '/api/workspaces/',
            {'id': 'ws-new', 'name': 'My Workspace', 'agencyCode': 'NIA-X', 'fiscalYear': 2026},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['ownerUid'], 'uid-outsider')
        self.assertEqual(response.data['memberUids'], ['uid-outsider'])
        links = self.client.get('/api/me/workspaces/').data
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]['role'], 'admin')

    def test_member_role_change_admin_only_and_owner_protected(self):
        url = f'/api/workspaces/{self.workspace.id}/members/uid-encoder/'
        self.as_user(self.auditor)
        self.assertEqual(
            self.client.patch(url, {'role': 'auditor'}, format='json').status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.as_user(self.admin)
        self.assertEqual(
            self.client.patch(url, {'role': 'auditor'}, format='json').status_code,
            status.HTTP_200_OK,
        )
        # owner cannot be demoted or removed
        owner_url = f'/api/workspaces/{self.workspace.id}/members/uid-admin/'
        self.assertEqual(
            self.client.patch(owner_url, {'role': 'encoder'}, format='json').status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(self.client.delete(owner_url).status_code, status.HTTP_403_FORBIDDEN)

    def test_member_removal_syncs_authorized_uids(self):
        self.as_user(self.encoder)
        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')
        self.as_user(self.admin)
        response = self.client.delete(f'/api/workspaces/{self.workspace.id}/members/uid-encoder/')
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertNotIn('uid-encoder', Transaction.objects.get(pk='tx-1').authorizedUids)

    def test_non_owner_member_list_sees_only_self(self):
        self.as_user(self.encoder)
        response = self.client.get(f'/api/workspaces/{self.workspace.id}/members/')
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]['uid'], 'uid-encoder')

        self.as_user(self.admin)
        response = self.client.get(f'/api/workspaces/{self.workspace.id}/members/')
        self.assertEqual(len(response.data), 3)

    def test_superadmin_can_read_any_workspace(self):
        from django.test import override_settings

        with override_settings(SUPERADMIN_EMAIL='uid-outsider@example.com'):
            self.as_user(self.outsider)
            response = self.client.get(self.tx_url)
            self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_workspace_delete_cascades(self):
        self.as_user(self.encoder)
        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')
        self.as_user(self.admin)
        response = self.client.delete(f'/api/workspaces/{self.workspace.id}/')
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(Transaction.objects.count(), 0)
        self.assertEqual(WorkspaceMember.objects.count(), 0)