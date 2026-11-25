from django.contrib import admin

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


@admin.register(Workspace)
class WorkspaceAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'agencyCode', 'fiscalYear', 'owner', 'createdAt')
    search_fields = ('id', 'name', 'agencyCode')


@admin.register(WorkspaceMember)
class WorkspaceMemberAdmin(admin.ModelAdmin):
    list_display = ('user', 'workspace', 'role', 'joinedAt')
    list_filter = ('role',)


@admin.register(WorkspaceInvite)
class WorkspaceInviteAdmin(admin.ModelAdmin):
    list_display = ('invitedEmail', 'workspace', 'role', 'status', 'createdAt')
    list_filter = ('status', 'role')


@admin.register(Transaction)
class TransactionAdmin(admin.ModelAdmin):
    list_display = ('id', 'workspace', 'sequenceNo', 'payeeName', 'status', 'grossAmount')
    list_filter = ('status', 'month')
    search_fields = ('payeeName', 'adaCheckNo', 'dvNo')


@admin.register(EntryTemplate)
class EntryTemplateAdmin(admin.ModelAdmin):
    list_display = ('name', 'workspace', 'shortcutKey', 'taxMode')


@admin.register(Payee)
class PayeeAdmin(admin.ModelAdmin):
    list_display = ('name', 'workspace', 'tin')
    search_fields = ('name',)


@admin.register(CoaAccount)
class CoaAccountAdmin(admin.ModelAdmin):
    list_display = ('code', 'title', 'workspace', 'normalSide', 'accountClass')


@admin.register(TaxPreset)
class TaxPresetAdmin(admin.ModelAdmin):
    list_display = ('name', 'workspace', 'version', 'rate', 'effectiveFrom')