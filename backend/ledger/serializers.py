"""Serializers porting firestore.rules shape validation to DRF.

Scalar constraints (enums, lengths, ranges) mirror the rules functions;
nested JSON structures are validated with the same bounds.
"""
import re
import uuid

from rest_framework import serializers

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

ID_RE = re.compile(r'^[a-zA-Z0-9_\-]{1,128}$')

MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
]
ATTRIBUTE_STATES = ['ok', 'flag', 'exclamation', 'wrong', 'na']
ACCOUNT_ROLES = [
    'settlement_debit', 'unrelated_debit', 'withholding_tax', 'retention_payable',
    'other_deduction', 'cash_bank_payment', 'other_liability', 'other_credit', 'unclassified',
]
ROLE_SOURCES = ['line_override', 'coa_default', 'system_default', 'unclassified']
TAX_BASE_TYPES = ['vatable_sales', 'gross_inclusive_vat', 'gross_total', 'contract_or_custom', 'exempt_excluded']
ROUNDING_METHODS = ['half_up_2dp', 'truncate_2dp']
TAX_MODES = ['none', 'vat5', 'vat5_ewt2', 'vat5_ewt1', 'pt3', 'pt3_ewt1', 'pt3_ewt2', 'ewt2', 'custom']
TX_STATUSES = ['draft', 'posted', 'lacking', 'audited']
MATH_STATUSES = ['pending_jev', 'reconciled', 'discrepancy', 'manual_review']
TAX_STATUSES = [
    'not_applicable', 'none_withheld', 'pending_base', 'incomplete_evidence',
    'verified', 'variance', 'manual_review',
]
DOC_STATUSES = ['incomplete', 'complete', 'lacking']
CLERK_STATUSES = ['draft', 'pending_review', 'for_verification', 'lacking', 'audited']
AUDIT_CATEGORIES = [
    'account_role_override', 'tax_rule_override', 'gross_basis_override',
    'legacy_v2_upgrade', 'clerk_review_decision',
]


def validate_id(value):
    if not ID_RE.match(value):
        raise serializers.ValidationError('Invalid id format.')
    return value


def changed_keys(instance, validated_data):
    """Keys in validated_data whose value differs from the stored instance."""
    changed = set()
    for key, value in validated_data.items():
        if getattr(instance, key, None) != value:
            changed.add(key)
    return changed


class WorkspaceSerializer(serializers.ModelSerializer):
    ownerUid = serializers.CharField(read_only=True)
    memberUids = serializers.ListField(child=serializers.CharField(), read_only=True)

    class Meta:
        model = Workspace
        fields = [
            'id', 'name', 'agencyCode', 'fiscalYear', 'ownerUid', 'memberUids',
            'defaultCheckPrefix', 'defaultDvPrefix', 'coaInitialized', 'createdAt', 'updatedAt',
        ]
        read_only_fields = ['createdAt', 'updatedAt']

    def validate_id(self, value):
        return validate_id(value)

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError('name must not be empty.')
        return value

    def validate_agencyCode(self, value):
        if not value.strip():
            raise serializers.ValidationError('agencyCode must not be empty.')
        return value

    def validate_fiscalYear(self, value):
        if not 2020 <= value <= 2099:
            raise serializers.ValidationError('fiscalYear must be between 2020 and 2099.')
        return value


class WorkspaceMemberSerializer(serializers.ModelSerializer):
    uid = serializers.CharField(read_only=True)
    workspaceId = serializers.CharField(source='workspace_id', read_only=True)
    workspaceOwnerUid = serializers.CharField(read_only=True)

    class Meta:
        model = WorkspaceMember
        fields = [
            'uid', 'workspaceId', 'workspaceOwnerUid', 'displayName', 'role',
            'inviteId', 'joinedAt', 'updatedAt',
        ]
        read_only_fields = ['displayName', 'inviteId', 'joinedAt', 'updatedAt']


class WorkspaceInviteSerializer(serializers.ModelSerializer):
    workspaceId = serializers.CharField(source='workspace_id', read_only=True)

    class Meta:
        model = WorkspaceInvite
        fields = [
            'id', 'workspaceId', 'workspaceName', 'workspaceOwnerUid', 'invitedEmail',
            'role', 'status', 'createdByUid', 'createdAt', 'updatedAt',
        ]
        read_only_fields = [
            'workspaceName', 'workspaceOwnerUid', 'status', 'createdByUid',
            'createdAt', 'updatedAt',
        ]

    def validate_id(self, value):
        return validate_id(value)

    def validate_invitedEmail(self, value):
        return value.strip().lower()


class WorkspaceRecordSerializer(serializers.ModelSerializer):
    """Base for workspace-scoped records: server-owned fields are read-only."""

    workspaceId = serializers.CharField(source='workspace_id', read_only=True)
    id = serializers.CharField(required=False, validators=[validate_id])
    createdByUid = serializers.CharField(read_only=True)
    authorizedUids = serializers.ListField(child=serializers.CharField(), read_only=True)

    #: optional fields omitted from output when empty (Firestore parity)
    optional_empty_fields = ()

    class Meta:
        read_only_fields = ['createdAt', 'updatedAt']

    def to_representation(self, instance):
        data = super().to_representation(instance)
        for key in self.optional_empty_fields:
            if key in data and data[key] in (None, ''):
                data.pop(key)
        return data

    def create(self, validated_data):
        validated_data.setdefault('id', uuid.uuid4().hex)
        workspace = self.context['workspace']
        user = self.context['request'].user
        validated_data['workspace'] = workspace
        validated_data['createdByUid'] = user.username
        validated_data['authorizedUids'] = workspace.memberUids
        return super().create(validated_data)


class TransactionSerializer(WorkspaceRecordSerializer):
    optional_empty_fields = (
        'dateReceived', 'orNoDate', 'asaNo', 'jevNoDate', 'rciAmount', 'declaredJevGross',
        'grossBasisOverride', 'mathStatus', 'taxStatus', 'documentaryStatus',
        'clerkReviewStatus', 'amountModelVersion', 'legacySnapshot', 'templateId',
        'procurement', 'remarks', 'submittedToCoaDate',
    )

    class Meta:
        model = Transaction
        fields = [
            'id', 'workspaceId', 'month', 'sequenceNo', 'adaCheckDate', 'adaCheckNo', 'dvNo',
            'dateReceived', 'orNoDate', 'asaNo', 'jevNoDate', 'payeeName', 'natureOfTransaction',
            'grossAmount', 'netAmount', 'taxWithheld', 'rciAmount', 'declaredJevGross',
            'grossBasisOverride', 'taxComponents', 'mathStatus', 'taxStatus', 'documentaryStatus',
            'clerkReviewStatus', 'verificationAuditTrail', 'amountModelVersion', 'legacySnapshot',
            'templateId', 'journalLines', 'isBalanced', 'attributes', 'procurement', 'remarks',
            'status', 'submittedToCoaDate', 'authorizedUids', 'createdByUid', 'createdAt', 'updatedAt',
        ]
        read_only_fields = ['createdAt', 'updatedAt']

    def validate_month(self, value):
        if value not in MONTHS:
            raise serializers.ValidationError('Invalid month.')
        return value

    def validate_sequenceNo(self, value):
        if not 1 <= value <= 999999:
            raise serializers.ValidationError('sequenceNo must be between 1 and 999999.')
        return value

    def validate_status(self, value):
        if value not in TX_STATUSES:
            raise serializers.ValidationError('Invalid status.')
        return value

    def validate_payeeName(self, value):
        if not value.strip():
            raise serializers.ValidationError('payeeName must not be empty.')
        return value

    def validate_attributes(self, value):
        if not isinstance(value, dict) or set(value.keys()) != {f'a{i}' for i in range(1, 8)}:
            raise serializers.ValidationError('attributes must contain exactly a1..a7.')
        if any(v not in ATTRIBUTE_STATES for v in value.values()):
            raise serializers.ValidationError('Invalid attribute state.')
        return value

    def validate_journalLines(self, value):
        if not isinstance(value, list) or len(value) > 20:
            raise serializers.ValidationError('journalLines must be a list of at most 20 lines.')
        for line in value:
            if not isinstance(line, dict) or not {'accountCode', 'accountTitle', 'debit', 'credit'} <= set(line):
                raise serializers.ValidationError('Journal line missing required keys.')
            if line.get('debit', 0) < 0 or line.get('credit', 0) < 0:
                raise serializers.ValidationError('Journal line amounts must be >= 0.')
            if 'accountRole' in line and line['accountRole'] not in ACCOUNT_ROLES:
                raise serializers.ValidationError('Invalid accountRole.')
            if 'roleSource' in line and line['roleSource'] not in ROLE_SOURCES:
                raise serializers.ValidationError('Invalid roleSource.')
        return value

    def validate_taxComponents(self, value):
        if not isinstance(value, list) or len(value) > 12:
            raise serializers.ValidationError('taxComponents must be a list of at most 12 items.')
        for comp in value:
            if not isinstance(comp, dict) or not comp.get('id'):
                raise serializers.ValidationError('Tax component missing id.')
            if comp.get('taxBaseType') not in TAX_BASE_TYPES:
                raise serializers.ValidationError('Invalid taxBaseType.')
            if comp.get('roundingMethod') not in ROUNDING_METHODS:
                raise serializers.ValidationError('Invalid roundingMethod.')
            rate = comp.get('applicableRate', 0)
            if not isinstance(rate, (int, float)) or not 0 <= rate <= 1:
                raise serializers.ValidationError('applicableRate must be between 0 and 1.')
        return value

    def validate_verificationAuditTrail(self, value):
        if not isinstance(value, list) or len(value) > 50:
            raise serializers.ValidationError('verificationAuditTrail must be at most 50 events.')
        for evt in value:
            if not isinstance(evt, dict) or not evt.get('id') or not evt.get('reason'):
                raise serializers.ValidationError('Audit event missing id/reason.')
            if evt.get('category') not in AUDIT_CATEGORIES:
                raise serializers.ValidationError('Invalid audit category.')
        return value

    def validate(self, attrs):
        status_value = attrs.get('status') or (self.instance.status if self.instance else None)
        lines = attrs.get('journalLines')
        if lines is not None and len(lines) == 0 and status_value != 'draft':
            raise serializers.ValidationError('Empty journalLines only allowed for draft status.')
        for field, choices in (
            ('mathStatus', MATH_STATUSES),
            ('taxStatus', TAX_STATUSES),
            ('documentaryStatus', DOC_STATUSES),
            ('clerkReviewStatus', CLERK_STATUSES),
        ):
            value = attrs.get(field)
            if value not in (None, '') and value not in choices:
                raise serializers.ValidationError({field: 'Invalid value.'})
        for field in ('grossAmount', 'netAmount', 'taxWithheld', 'rciAmount', 'declaredJevGross'):
            value = attrs.get(field)
            if value is not None and value < 0:
                raise serializers.ValidationError({field: 'Must be >= 0.'})
        version = attrs.get('amountModelVersion')
        if version is not None and not 1 <= version <= 10:
            raise serializers.ValidationError({'amountModelVersion': 'Must be between 1 and 10.'})
        return attrs


class EntryTemplateSerializer(WorkspaceRecordSerializer):
    optional_empty_fields = ('autoMatchKeywords',)

    class Meta:
        model = EntryTemplate
        fields = [
            'id', 'workspaceId', 'name', 'shortcutKey', 'category', 'defaultNature',
            'taxMode', 'vatRate', 'ewtRate', 'requiresProcurement',
            'debitAccountCode', 'debitAccountTitle', 'creditCashAccountCode',
            'creditCashAccountTitle', 'autoMatchKeywords',
            'authorizedUids', 'createdByUid', 'createdAt', 'updatedAt',
        ]
        read_only_fields = ['createdAt', 'updatedAt']

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError('name must not be empty.')
        return value

    def validate_taxMode(self, value):
        if value not in TAX_MODES:
            raise serializers.ValidationError('Invalid taxMode.')
        return value

    def validate(self, attrs):
        for field in ('vatRate', 'ewtRate'):
            value = attrs.get(field)
            if value is not None and not 0 <= value <= 1:
                raise serializers.ValidationError({field: 'Must be between 0 and 1.'})
        return attrs


class PayeeSerializer(WorkspaceRecordSerializer):
    optional_empty_fields = ('tin', 'defaultTemplateId', 'defaultNature')

    class Meta:
        model = Payee
        fields = [
            'id', 'workspaceId', 'name', 'tin', 'defaultTemplateId', 'defaultNature',
            'authorizedUids', 'createdByUid', 'createdAt', 'updatedAt',
        ]
        read_only_fields = ['createdAt', 'updatedAt']

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError('name must not be empty.')
        return value


class CoaAccountSerializer(WorkspaceRecordSerializer):
    optional_empty_fields = ('accountClass',)

    class Meta:
        model = CoaAccount
        fields = [
            'id', 'workspaceId', 'code', 'title', 'normalSide', 'accountClass',
            'authorizedUids', 'createdByUid', 'createdAt', 'updatedAt',
        ]
        read_only_fields = ['createdAt', 'updatedAt']

    def validate_code(self, value):
        if not value.strip():
            raise serializers.ValidationError('code must not be empty.')
        return value

    def validate_title(self, value):
        if not value.strip():
            raise serializers.ValidationError('title must not be empty.')
        return value

    def validate_normalSide(self, value):
        if value not in ('debit', 'credit'):
            raise serializers.ValidationError('normalSide must be debit or credit.')
        return value

    def validate_accountClass(self, value):
        if value not in ('',) + tuple(ACCOUNT_ROLES):
            raise serializers.ValidationError('Invalid accountClass.')
        return value


class TaxPresetSerializer(WorkspaceRecordSerializer):
    optional_empty_fields = ('effectiveTo',)

    class Meta:
        model = TaxPreset
        fields = [
            'id', 'workspaceId', 'name', 'version', 'effectiveFrom', 'effectiveTo',
            'applicableClassification', 'birReference', 'defaultBirAccountCode',
            'defaultBirAccountTitle', 'rate', 'defaultTaxBaseType', 'roundingMethod',
            'computationRule', 'overrideHistory',
            'authorizedUids', 'createdByUid', 'createdAt', 'updatedAt',
        ]
        read_only_fields = ['createdAt', 'updatedAt']

    def validate_rate(self, value):
        if not 0 <= value <= 1:
            raise serializers.ValidationError('rate must be between 0 and 1.')
        return value

    def validate_defaultTaxBaseType(self, value):
        if value not in TAX_BASE_TYPES:
            raise serializers.ValidationError('Invalid defaultTaxBaseType.')
        return value

    def validate_roundingMethod(self, value):
        if value not in ROUNDING_METHODS:
            raise serializers.ValidationError('Invalid roundingMethod.')
        return value

    def validate_overrideHistory(self, value):
        if not isinstance(value, list) or len(value) > 20:
            raise serializers.ValidationError('overrideHistory must be at most 20 entries.')
        return value