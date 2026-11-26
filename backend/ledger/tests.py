"""Permission/validation tests ported from tests/firestore-rules.test.ts."""
from unittest import mock

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from . import philgeps
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

    def test_batch_defaults_payment_mode_and_accepts_ada(self):
        # Legacy Batch Paste payloads omitted paymentMode entirely; the server
        # must persist the default instead of failing the NOT NULL constraint.
        self.as_user(self.encoder)
        items = [
            tx_payload(self.workspace.id, 'tx-b-check', sequenceNo=1),
            tx_payload(self.workspace.id, 'tx-b-ada', sequenceNo=2, paymentMode='ada'),
        ]
        response = self.client.post(self.tx_url + 'batch/', {'items': items}, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Transaction.objects.get(pk='tx-b-check').paymentMode, 'check')
        self.assertEqual(Transaction.objects.get(pk='tx-b-ada').paymentMode, 'ada')

    def test_batch_accepts_jev_exempt_cancelled_rows(self):
        # Cancelled checks are JEV-exempt: zero journal lines, blank payee/nature,
        # and not_applicable verification statuses must round-trip via Batch Paste.
        self.as_user(self.encoder)
        item = tx_payload(
            self.workspace.id,
            'tx-b-cancelled',
            payeeName='',
            natureOfTransaction='',
            grossAmount=0,
            netAmount=0,
            taxWithheld=0,
            journalLines=[],
            status='draft',
            isCancelled=True,
            mathStatus='not_applicable',
            taxStatus='not_applicable',
            documentaryStatus='not_applicable',
            remarks='',
        )
        response = self.client.post(self.tx_url + 'batch/', {'items': [item]}, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        stored = Transaction.objects.get(pk='tx-b-cancelled')
        self.assertTrue(stored.isCancelled)
        self.assertEqual(stored.mathStatus, 'not_applicable')
        self.assertEqual(stored.taxStatus, 'not_applicable')
        self.assertEqual(stored.documentaryStatus, 'not_applicable')
        self.assertEqual(stored.remarks, '')

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

    def test_dv_signatories_and_test_of_controls_roundtrip(self):
        self.as_user(self.encoder)
        payload = tx_payload(
            self.workspace.id,
            dvSignatories={'a': 'ok', 'b': 'exclamation', 'c': 'na'},
            testOfControls={'status': 'suspended', 'particulars': 'DV 2026-01-0001 — awaiting OR copy.'},
        )
        response = self.client.post(self.tx_url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['dvSignatories']['b'], 'exclamation')
        self.assertEqual(response.data['testOfControls']['status'], 'suspended')

        stored = Transaction.objects.get(pk='tx-1')
        self.assertEqual(stored.dvSignatories, {'a': 'ok', 'b': 'exclamation', 'c': 'na'})
        self.assertEqual(stored.testOfControls['particulars'], 'DV 2026-01-0001 — awaiting OR copy.')

    def test_invalid_test_of_controls_status_rejected(self):
        self.as_user(self.encoder)
        payload = tx_payload(
            self.workspace.id, testOfControls={'status': 'maybe', 'particulars': 'x'}
        )
        response = self.client.post(self.tx_url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_invalid_dv_signatories_rejected(self):
        self.as_user(self.encoder)
        payload = tx_payload(self.workspace.id, dvSignatories={'a': 'ok', 'd': 'ok'})
        response = self.client.post(self.tx_url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        bad_state = tx_payload(self.workspace.id, 'tx-2', dvSignatories={'a': 'flag'})
        response = self.client.post(self.tx_url, bad_state, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_auditor_can_set_test_of_controls_on_audited_record(self):
        self.as_user(self.encoder)
        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')

        self.as_user(self.auditor)
        response = self.client.patch(
            self.tx_url + 'tx-1/',
            {'status': 'audited', 'clerkReviewStatus': 'audited'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        toc = {
            'status': 'disallowed',
            'particulars': '#1 · DV 2026-01-0001 · Check/ADA 3967001 · ₱95.00',
        }
        response = self.client.patch(self.tx_url + 'tx-1/', {'testOfControls': toc}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['testOfControls']['status'], 'disallowed')

        # Clearing via null is accepted (JSONField null=True); the nulled field
        # is then omitted from output by optional_empty_fields.
        response = self.client.patch(self.tx_url + 'tx-1/', {'testOfControls': None}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertNotIn('testOfControls', response.data)
        self.assertIsNone(Transaction.objects.get(pk='tx-1').testOfControls)

        # Encoders cannot touch audited records at all, Test of Controls included
        self.as_user(self.encoder)
        response = self.client.patch(self.tx_url + 'tx-1/', {'testOfControls': toc}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        # Admins share the auditor branch and can also set Test of Controls
        self.as_user(self.admin)
        response = self.client.patch(self.tx_url + 'tx-1/', {'testOfControls': toc}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['testOfControls']['status'], 'disallowed')

    def test_payment_mode_roundtrip_and_validation(self):
        self.as_user(self.encoder)
        response = self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Transaction.objects.get(pk='tx-1').paymentMode, 'check')

        ada_payload = tx_payload(self.workspace.id, 'tx-2', paymentMode='ada')
        response = self.client.post(self.tx_url, ada_payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Transaction.objects.get(pk='tx-2').paymentMode, 'ada')

        bad_payload = tx_payload(self.workspace.id, 'tx-3', paymentMode='cash')
        response = self.client.post(self.tx_url, bad_payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_payment_mode_patch_permissions(self):
        self.as_user(self.encoder)
        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')

        response = self.client.patch(self.tx_url + 'tx-1/', {'paymentMode': 'ada'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['paymentMode'], 'ada')

        self.as_user(self.auditor)
        response = self.client.patch(
            self.tx_url + 'tx-1/',
            {'status': 'audited', 'clerkReviewStatus': 'audited'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Mode is locked on audited rows (not in TX_AUDIT_FIELDS)
        response = self.client.patch(self.tx_url + 'tx-1/', {'paymentMode': 'check'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        # Same-value mode in an audited payload is skipped by changed_keys
        response = self.client.patch(
            self.tx_url + 'tx-1/',
            {'paymentMode': 'ada', 'remarks': 'complete'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(Transaction.objects.get(pk='tx-1').paymentMode, 'ada')


class CancelledCheckTests(WorkspaceTestBase):
    """Recording, evidence permissions, and batch guards for cancelled checks."""

    def test_encoder_records_cancelled_check_with_reason(self):
        self.as_user(self.encoder)
        payload = tx_payload(
            self.workspace.id,
            isCancelled=True,
            cancellationReason='Cancelled per agency RCI — replaced by check 3967050.',
        )
        response = self.client.post(self.tx_url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        stored = Transaction.objects.get(pk='tx-1')
        self.assertTrue(stored.isCancelled)
        self.assertEqual(
            stored.cancellationReason, 'Cancelled per agency RCI — replaced by check 3967050.'
        )
        # Workflow status is untouched by the cancellation flag.
        self.assertEqual(stored.status, 'posted')

    def test_attachment_evidence_is_auditor_admin_only(self):
        # Encoder cannot attach evidence at creation time.
        self.as_user(self.encoder)
        payload = tx_payload(
            self.workspace.id, isCancelled=True, cancelledCheckAttachment='attached'
        )
        response = self.client.post(self.tx_url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        # Encoder can record the cancelled check itself, then gets blocked on evidence.
        self.client.post(
            self.tx_url, tx_payload(self.workspace.id, isCancelled=True), format='json'
        )
        response = self.client.patch(
            self.tx_url + 'tx-1/', {'cancelledCheckAttachment': 'attached'}, format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        # Auditors may record evidence and append cancellation audit events.
        self.as_user(self.auditor)
        response = self.client.patch(
            self.tx_url + 'tx-1/',
            {
                'cancelledCheckAttachment': 'attached',
                'verificationAuditTrail': [
                    {
                        'id': 'evt-cc-1',
                        'category': 'cancelled_check_evidence',
                        'reason': 'Original cancelled check attached',
                    }
                ],
            },
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(Transaction.objects.get(pk='tx-1').cancelledCheckAttachment, 'attached')

    def test_attachment_on_non_cancelled_row_rejected(self):
        self.as_user(self.auditor)
        response = self.client.post(
            self.tx_url,
            tx_payload(self.workspace.id, cancelledCheckAttachment='attached'),
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')
        response = self.client.patch(
            self.tx_url + 'tx-1/', {'cancelledCheckAttachment': 'missing'}, format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_uncancel_clears_attachment_but_keeps_reason(self):
        self.as_user(self.auditor)
        self.client.post(
            self.tx_url,
            tx_payload(
                self.workspace.id,
                isCancelled=True,
                cancellationReason='Spoiled per RCI',
                cancelledCheckAttachment='attached',
            ),
            format='json',
        )
        response = self.client.patch(
            self.tx_url + 'tx-1/', {'isCancelled': False}, format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        stored = Transaction.objects.get(pk='tx-1')
        self.assertFalse(stored.isCancelled)
        self.assertEqual(stored.cancelledCheckAttachment, '')
        self.assertEqual(stored.cancellationReason, 'Spoiled per RCI')

    def test_audited_row_cancellation_flag_rbac(self):
        self.as_user(self.encoder)
        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')

        self.as_user(self.auditor)
        response = self.client.patch(
            self.tx_url + 'tx-1/',
            {'status': 'audited', 'clerkReviewStatus': 'audited'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.as_user(self.encoder)
        response = self.client.patch(
            self.tx_url + 'tx-1/', {'isCancelled': True}, format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        self.as_user(self.auditor)
        response = self.client.patch(
            self.tx_url + 'tx-1/',
            {'isCancelled': True, 'cancellationReason': 'Cancelled after audit review'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(Transaction.objects.get(pk='tx-1').isCancelled)

    def test_batch_records_cancelled_but_rejects_attachment(self):
        self.as_user(self.encoder)
        items = [
            tx_payload(
                self.workspace.id,
                'tx-c1',
                isCancelled=True,
                cancellationReason='Cancelled per RCI',
            ),
            tx_payload(self.workspace.id, 'tx-c2', sequenceNo=2),
        ]
        response = self.client.post(self.tx_url + 'batch/', {'items': items}, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertTrue(Transaction.objects.get(pk='tx-c1').isCancelled)
        self.assertFalse(Transaction.objects.get(pk='tx-c2').isCancelled)

        bad_items = [
            tx_payload(
                self.workspace.id,
                'tx-c3',
                isCancelled=True,
                cancelledCheckAttachment='attached',
            )
        ]
        response = self.client.post(
            self.tx_url + 'batch/', {'items': bad_items}, format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Transaction.objects.filter(pk='tx-c3').exists())

    def test_batch_cannot_modify_audited_transactions(self):
        self.as_user(self.encoder)
        self.client.post(self.tx_url, tx_payload(self.workspace.id), format='json')

        self.as_user(self.auditor)
        response = self.client.patch(
            self.tx_url + 'tx-1/',
            {'status': 'audited', 'clerkReviewStatus': 'audited'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.as_user(self.encoder)
        response = self.client.post(
            self.tx_url + 'batch/',
            {'items': [{'id': 'tx-1', 'remarks': 'bulk overwrite'}]},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Transaction.objects.get(pk='tx-1').remarks, '')

    def test_cancelled_row_stores_truly_blank_details(self):
        self.as_user(self.encoder)
        payload = tx_payload(
            self.workspace.id,
            isCancelled=True,
            payeeName='',
            dvNo='',
            natureOfTransaction='',
            status='draft',
            journalLines=[],
            isBalanced=False,
        )
        response = self.client.post(self.tx_url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        stored = Transaction.objects.get(pk='tx-1')
        self.assertEqual(stored.payeeName, '')
        self.assertEqual(stored.dvNo, '')
        self.assertEqual(stored.natureOfTransaction, '')
        self.assertTrue(stored.isCancelled)

        # Un-cancelling turns it back into an active row and requires a payee.
        self.as_user(self.auditor)
        response = self.client.patch(
            self.tx_url + 'tx-1/', {'isCancelled': False}, format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_cancelled_blank_payee_rejected(self):
        self.as_user(self.encoder)
        response = self.client.post(
            self.tx_url, tx_payload(self.workspace.id, payeeName=''), format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Transaction.objects.filter(pk='tx-1').exists())


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

    def test_invite_rejects_existing_member(self):
        self.as_user(self.admin)
        response = self.client.post(
            f'/api/workspaces/{self.workspace.id}/invites/',
            {'id': 'inv-3', 'invitedEmail': self.auditor.email, 'role': 'encoder'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(WorkspaceInvite.objects.filter(pk='inv-3').exists())

    def test_duplicate_pending_invite_rejected(self):
        self.as_user(self.admin)
        url = f'/api/workspaces/{self.workspace.id}/invites/'
        payload = {'id': 'inv-4', 'invitedEmail': 'new@example.com', 'role': 'encoder'}
        response = self.client.post(url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        payload['id'] = 'inv-5'
        response = self.client.post(url, payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            WorkspaceInvite.objects.filter(
                workspace=self.workspace, invitedEmail='new@example.com', status='pending'
            ).count(),
            1,
        )

    def test_invite_revoke_permissions(self):
        invitee = make_user('uid-invitee-2', 'revoke@example.com')
        self.as_user(self.admin)
        response = self.client.post(
            f'/api/workspaces/{self.workspace.id}/invites/',
            {'id': 'inv-6', 'invitedEmail': invitee.email, 'role': 'encoder'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        url = f'/api/workspaces/{self.workspace.id}/invites/inv-6/'
        self.as_user(self.encoder)
        self.assertEqual(self.client.delete(url).status_code, status.HTTP_403_FORBIDDEN)
        self.as_user(self.admin)
        self.assertEqual(self.client.delete(url).status_code, status.HTTP_204_NO_CONTENT)
        self.as_user(invitee)
        self.assertEqual(self.client.get('/api/me/invites/').data, [])

    def test_removed_member_loses_access(self):
        self.as_user(self.admin)
        response = self.client.delete(
            f'/api/workspaces/{self.workspace.id}/members/uid-encoder/'
        )
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.as_user(self.encoder)
        self.assertEqual(self.client.get(self.tx_url).status_code, status.HTTP_403_FORBIDDEN)


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


MERCHANT_FRAGMENT = '''
<tr>
  <td data-label="organization_name"><div class="wrapped-long-string">
    JDF HEAVY EQUIPMENT PARTS CENTER </div></td>
  <td data-label="type"> Single Proprietorship </td>
  <td data-label="red_approval_date"> 13-Nov-2012 </td>
  <td data-label="status"> Platinum </td>
  <td data-label="merchant_activity"> Active </td>
  <td data-label="issuancedate"> 11-Jun-2026 </td>
  <td data-label="expiredate"> 11-Jun-2027 </td>
  <td data-label="ref_numbers"> 201211-61858-611258536 </td>
</tr>
<tr>
  <td data-label="organization_name"><div class="wrapped-long-string">
    PYRAMID CONSOLIDATED BUILDERS &amp; GENERAL MERCHANDISE </div></td>
  <td data-label="type"> Single Proprietorship </td>
  <td data-label="red_approval_date"> 10-Dec-2007 </td>
  <td data-label="status"> Platinum </td>
  <td data-label="merchant_activity"> Active </td>
  <td data-label="issuancedate"> 20-Nov-2026 </td>
  <td data-label="expiredate"> 17-Dec-2027 </td>
  <td data-label="ref_numbers"> 200712-17928-925163381 </td>
</tr>
'''

JDF_RECORD = {
    'name': 'JDF HEAVY EQUIPMENT PARTS CENTER',
    'merchantType': 'Single Proprietorship',
    'redApprovalDate': '2012-11-13',
    'status': 'Platinum',
    'activity': 'Active',
    'issuedDate': '2026-06-11',
    'expiresDate': '2027-06-11',
    'refNumber': '201211-61858-611258536',
}


class PhilGepsParserTests(APITestCase):
    def test_parses_rows_with_nested_name_cells(self):
        rows = philgeps._parse_rows(MERCHANT_FRAGMENT)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], JDF_RECORD)
        self.assertEqual(rows[1]['name'], 'PYRAMID CONSOLIDATED BUILDERS & GENERAL MERCHANDISE')
        self.assertEqual(rows[1]['redApprovalDate'], '2007-12-10')

    def test_empty_fragment_yields_no_rows(self):
        self.assertEqual(philgeps._parse_rows('   '), [])

    def test_name_normalization_for_exact_match(self):
        self.assertEqual(
            philgeps._normalize_name('  JDF Heavy Equipment  Parts Center. '),
            'jdf heavy equipment parts center',
        )


class PhilGepsLookupTests(APITestCase):
    url = '/api/philgeps/merchants/'

    def setUp(self):
        self.user = make_user('uid-lookup')
        with philgeps._cache_lock:
            philgeps._cache.clear()

    def test_requires_authentication(self):
        response = self.client.get(self.url, {'name': 'JDF'})
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_rejects_short_names(self):
        self.client.force_authenticate(user=self.user)
        response = self.client.get(self.url, {'name': 'ab'})
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_returns_exact_match(self):
        self.client.force_authenticate(user=self.user)
        with mock.patch.object(
            philgeps, 'search_merchants', return_value=[dict(JDF_RECORD)]
        ) as fetch:
            response = self.client.get(
                self.url, {'name': 'jdf heavy equipment parts center'}
            )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(response.data['cached'])
        self.assertEqual(response.data['match'], JDF_RECORD)
        self.assertEqual(len(response.data['results']), 1)
        fetch.assert_called_once()

    def test_upstream_failure_returns_502(self):
        self.client.force_authenticate(user=self.user)
        with mock.patch.object(
            philgeps, 'search_merchants', side_effect=philgeps.PhilGepsError('down')
        ):
            response = self.client.get(self.url, {'name': 'JDF'})
        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)

    def test_cache_hits_and_force_refresh(self):
        with mock.patch.object(
            philgeps, 'search_merchants', return_value=[dict(JDF_RECORD)]
        ) as fetch:
            first = philgeps.lookup('JDF HEAVY EQUIPMENT PARTS CENTER')
            second = philgeps.lookup('jdf heavy equipment parts center')
            third = philgeps.lookup('JDF HEAVY EQUIPMENT PARTS CENTER', force_refresh=True)
        self.assertFalse(first['cached'])
        self.assertTrue(second['cached'])
        self.assertFalse(third['cached'])
        self.assertEqual(fetch.call_count, 2)
