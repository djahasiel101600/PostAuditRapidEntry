from django.conf import settings
from django.db import models


class TimestampedModel(models.Model):
    createdAt = models.DateTimeField(auto_now_add=True)
    updatedAt = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Workspace(TimestampedModel):
    id = models.CharField(max_length=128, primary_key=True)
    name = models.CharField(max_length=120)
    agencyCode = models.CharField(max_length=60)
    fiscalYear = models.IntegerField()
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='owned_workspaces',
    )
    defaultCheckPrefix = models.CharField(max_length=20, blank=True, default='')
    defaultDvPrefix = models.CharField(max_length=20, blank=True, default='')
    coaInitialized = models.BooleanField(default=False)

    @property
    def ownerUid(self):
        return self.owner.username

    @property
    def memberUids(self):
        return list(self.members.values_list('user__username', flat=True))

    def __str__(self):
        return f'{self.name} ({self.fiscalYear})'


class WorkspaceMember(TimestampedModel):
    ROLE_CHOICES = [('admin', 'admin'), ('auditor', 'auditor'), ('encoder', 'encoder')]

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name='members')
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='workspace_memberships'
    )
    displayName = models.CharField(max_length=120)
    role = models.CharField(max_length=10, choices=ROLE_CHOICES)
    inviteId = models.CharField(max_length=128, blank=True, default='')
    joinedAt = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['workspace', 'user'], name='unique_workspace_member'),
        ]

    @property
    def uid(self):
        return self.user.username

    @property
    def workspaceOwnerUid(self):
        return self.workspace.owner.username

    def __str__(self):
        return f'{self.displayName} -> {self.workspace_id} ({self.role})'


class WorkspaceInvite(TimestampedModel):
    ROLE_CHOICES = [('auditor', 'auditor'), ('encoder', 'encoder')]
    STATUS_CHOICES = [('pending', 'pending'), ('accepted', 'accepted')]

    id = models.CharField(max_length=128, primary_key=True)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name='invites')
    workspaceName = models.CharField(max_length=120)
    workspaceOwnerUid = models.CharField(max_length=128)
    invitedEmail = models.EmailField(max_length=254)
    role = models.CharField(max_length=10, choices=ROLE_CHOICES)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='pending')
    createdByUid = models.CharField(max_length=128)

    def __str__(self):
        return f'{self.invitedEmail} -> {self.workspace_id} ({self.status})'


class WorkspaceRecord(TimestampedModel):
    """Common base for workspace-scoped records (Firestore subcollection equivalents)."""

    id = models.CharField(max_length=128, primary_key=True)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE)
    authorizedUids = models.JSONField(default=list)
    createdByUid = models.CharField(max_length=128)

    class Meta:
        abstract = True


PAYMENT_MODE_CHOICES = (('check', 'Check'), ('ada', 'ADA'))
CANCELLED_CHECK_ATTACHMENT_CHOICES = (
    ('attached', 'Attached'),
    ('missing', 'Missing'),
    ('na', 'N/A'),
)


class Transaction(WorkspaceRecord):
    month = models.CharField(max_length=10)
    sequenceNo = models.IntegerField()
    adaCheckDate = models.CharField(max_length=20, blank=True, default='')
    adaCheckNo = models.CharField(max_length=40, blank=True, default='')
    dvNo = models.CharField(max_length=40, blank=True, default='')
    dateReceived = models.CharField(max_length=20, blank=True, default='')
    orNoDate = models.CharField(max_length=40, blank=True, default='')
    # OR "No / Date" split pair; orNoDate stays as a legacy combined fallback.
    orNo = models.CharField(max_length=60, blank=True, default='')
    orDate = models.CharField(max_length=20, blank=True, default='')
    asaNo = models.CharField(max_length=40, blank=True, default='')
    jevNoDate = models.CharField(max_length=50, blank=True, default='')
    # JEV "No / Date" split pair; jevNoDate stays as a legacy combined fallback.
    jevNo = models.CharField(max_length=60, blank=True, default='')
    jevDate = models.CharField(max_length=20, blank=True, default='')
    # Cancelled checks may be recorded with only date + serial; blank payee is
    # rejected for active rows in TransactionSerializer.validate().
    payeeName = models.CharField(max_length=180, blank=True, default='')
    natureOfTransaction = models.CharField(max_length=500, blank=True, default='')
    grossAmount = models.FloatField()
    netAmount = models.FloatField()
    taxWithheld = models.FloatField()
    rciAmount = models.FloatField(null=True, blank=True)
    declaredJevGross = models.FloatField(null=True, blank=True)
    grossBasisOverride = models.JSONField(null=True, blank=True)
    taxComponents = models.JSONField(default=list, blank=True)
    mathStatus = models.CharField(max_length=20, blank=True, default='')
    taxStatus = models.CharField(max_length=25, blank=True, default='')
    documentaryStatus = models.CharField(max_length=15, blank=True, default='')
    clerkReviewStatus = models.CharField(max_length=20, blank=True, default='')
    verificationAuditTrail = models.JSONField(default=list, blank=True)
    amountModelVersion = models.IntegerField(null=True, blank=True)
    legacySnapshot = models.JSONField(null=True, blank=True)
    templateId = models.CharField(max_length=128, blank=True, default='')
    journalLines = models.JSONField(default=list)
    isBalanced = models.BooleanField(default=False)
    attributes = models.JSONField(default=dict)
    dvSignatories = models.JSONField(null=True, blank=True)
    procurement = models.JSONField(null=True, blank=True)
    testOfControls = models.JSONField(null=True, blank=True)
    # db_default keeps legacy/offline clients that omit the key from failing the
    # NOT NULL constraint (batch upsert writes every column explicitly).
    paymentMode = models.CharField(
        max_length=8, choices=PAYMENT_MODE_CHOICES, default='check', db_default='check'
    )
    isCancelled = models.BooleanField(default=False)
    cancellationReason = models.CharField(max_length=200, blank=True, default='')
    cancelledCheckAttachment = models.CharField(
        max_length=10, choices=CANCELLED_CHECK_ATTACHMENT_CHOICES, blank=True, default=''
    )
    remarks = models.CharField(max_length=800, blank=True, default='')
    status = models.CharField(max_length=10)
    submittedToCoaDate = models.CharField(max_length=20, blank=True, default='')

    class Meta:
        ordering = ['sequenceNo']

    def __str__(self):
        return f'{self.workspace_id} #{self.sequenceNo} {self.payeeName}'


class EntryTemplate(WorkspaceRecord):
    name = models.CharField(max_length=100)
    shortcutKey = models.CharField(max_length=16, blank=True, default='')
    category = models.CharField(max_length=60, blank=True, default='')
    defaultNature = models.CharField(max_length=300, blank=True, default='')
    taxMode = models.CharField(max_length=16)
    vatRate = models.FloatField(default=0)
    ewtRate = models.FloatField(default=0)
    requiresProcurement = models.BooleanField(default=False)
    debitAccountCode = models.CharField(max_length=30, blank=True, default='')
    debitAccountTitle = models.CharField(max_length=140, blank=True, default='')
    creditCashAccountCode = models.CharField(max_length=30, blank=True, default='')
    creditCashAccountTitle = models.CharField(max_length=140, blank=True, default='')
    autoMatchKeywords = models.CharField(max_length=300, blank=True, default='')

    class Meta:
        ordering = ['shortcutKey']

    def __str__(self):
        return self.name


class Payee(WorkspaceRecord):
    name = models.CharField(max_length=180)
    tin = models.CharField(max_length=30, blank=True, default='')
    defaultTemplateId = models.CharField(max_length=128, blank=True, default='')
    defaultNature = models.CharField(max_length=300, blank=True, default='')

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name


class CoaAccount(WorkspaceRecord):
    code = models.CharField(max_length=30)
    title = models.CharField(max_length=140)
    normalSide = models.CharField(max_length=6)
    accountClass = models.CharField(max_length=30, blank=True, default='')

    class Meta:
        ordering = ['code', 'title']

    def __str__(self):
        return f'{self.code} {self.title}'


class TaxPreset(WorkspaceRecord):
    name = models.CharField(max_length=120)
    version = models.CharField(max_length=30)
    effectiveFrom = models.CharField(max_length=30)
    effectiveTo = models.CharField(max_length=30, blank=True, default='')
    applicableClassification = models.CharField(max_length=160)
    birReference = models.CharField(max_length=120)
    defaultBirAccountCode = models.CharField(max_length=30, blank=True, default='')
    defaultBirAccountTitle = models.CharField(max_length=140, blank=True, default='')
    rate = models.FloatField()
    defaultTaxBaseType = models.CharField(max_length=25)
    roundingMethod = models.CharField(max_length=16)
    computationRule = models.CharField(max_length=200)
    overrideHistory = models.JSONField(default=list, blank=True)

    def __str__(self):
        return f'{self.name} v{self.version}'