"""Live E2E check against the running dev server (http://127.0.0.1:8000).

Simulates the full app flow with two synthetic users (no Google needed):
sign-in identity -> workspace create -> default seeding -> rapid entry ->
invite -> accept -> membership access. Cleans up all created data afterwards.

Run:  .venv\\Scripts\\python.exe e2e_live_check.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from rest_framework_simplejwt.tokens import RefreshToken  # noqa: E402

from ledger.models import Workspace  # noqa: E402

BASE = 'http://127.0.0.1:8000/api'
WS_ID = 'e2e-ws-check-001'
INVITE_ID = 'e2e-inv-check-001'
OWNER_EMAIL = 'e2e.owner@example.com'
INVITEE_EMAIL = 'e2e.invitee@example.com'

User = get_user_model()
failures = []


def check(label, ok, detail=''):
    mark = 'PASS' if ok else 'FAIL'
    print(f'[{mark}] {label}' + (f' -- {detail}' if detail and not ok else ''))
    if not ok:
        failures.append(label)


def req(method, path, token=None, body=None):
    request = urllib.request.Request(BASE + path, method=method)
    request.add_header('Content-Type', 'application/json')
    if token:
        request.add_header('Authorization', f'Bearer {token}')
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(request, data=data, timeout=15) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, raw


def main():
    owner, _ = User.objects.get_or_create(
        username='e2e-owner-sub', defaults={'email': OWNER_EMAIL, 'first_name': 'E2E Owner'}
    )
    invitee, _ = User.objects.get_or_create(
        username='e2e-invitee-sub', defaults={'email': INVITEE_EMAIL, 'first_name': 'E2E Invitee'}
    )
    owner.email, invitee.email = OWNER_EMAIL, INVITEE_EMAIL
    owner.save(), invitee.save()
    owner_token = str(RefreshToken.for_user(owner).access_token)
    invitee_token = str(RefreshToken.for_user(invitee).access_token)

    try:
        # 1. Identity (what /api/auth/google/ + /api/me/ provide after GIS sign-in)
        code, me = req('GET', '/me/', owner_token)
        check('GET /me/ returns identity', code == 200 and me['uid'] == 'e2e-owner-sub', str(me))

        # 2. Workspace creation (auto admin membership)
        code, ws = req('POST', '/workspaces/', owner_token, {
            'id': WS_ID, 'name': 'E2E Check Workspace', 'agencyCode': 'E2E', 'fiscalYear': 2026,
        })
        check('POST /workspaces/ creates workspace', code == 201, str(ws))
        check('owner auto-member (admin)', 'e2e-owner-sub' in ws.get('memberUids', []), str(ws))

        # 3. Default seeding via batch endpoints (what seedWorkspaceDefaults does)
        code, coa = req('POST', f'/workspaces/{WS_ID}/coa-accounts/batch/', owner_token, {'items': [
            {'id': 'e2e-coa-1', 'code': '10101010', 'title': 'Cash - Treasury/Agency Check',
             'normalSide': 'debit', 'accountClass': 'cash_bank_payment'},
            {'id': 'e2e-coa-2', 'code': '50203010', 'title': 'Office Supplies Expense',
             'normalSide': 'debit', 'accountClass': 'settlement_debit'},
        ]})
        check('COA batch seed', code == 201 and coa['count'] == 2, str(coa))
        code, tpl = req('POST', f'/workspaces/{WS_ID}/templates/batch/', owner_token, {'items': [
            {'id': 'e2e-tpl-1', 'name': 'Office Supplies', 'shortcutKey': 'OS', 'taxMode': 'vat5_ewt2',
             'vatRate': 0.12, 'ewtRate': 0.02, 'debitAccountCode': '50203010',
             'debitAccountTitle': 'Office Supplies Expense', 'creditCashAccountCode': '10101010',
             'creditCashAccountTitle': 'Cash - Treasury/Agency Check'},
        ]})
        check('template batch seed', code == 201 and tpl['count'] == 1, str(tpl))
        code, pay = req('POST', f'/workspaces/{WS_ID}/payees/batch/', owner_token, {
            'ensureOnly': True, 'items': [{'id': 'e2e-payee-1', 'name': 'E2E Supplies Co.'}],
        })
        check('payee batch seed (ensureOnly)', code == 201 and pay['count'] == 1, str(pay))
        code, preset = req('POST', f'/workspaces/{WS_ID}/tax-presets/', owner_token, {
            'id': 'e2e-tax-1', 'name': 'EWT 2% Goods', 'version': '2026', 'effectiveFrom': '2026-01-01',
            'applicableClassification': 'Goods', 'birReference': 'RR 11-2018', 'rate': 0.02,
            'defaultTaxBaseType': 'vatable_sales', 'roundingMethod': 'half_up_2dp',
            'computationRule': 'rate * vatable_sales',
        })
        check('tax preset create (admin)', code == 201, str(preset))
        code, ws = req('PATCH', f'/workspaces/{WS_ID}/', owner_token, {'coaInitialized': True})
        check('mark coaInitialized', code == 200 and ws['coaInitialized'] is True, str(ws))

        # 4. Rapid entry (posted transaction with balanced journal lines)
        code, tx = req('POST', f'/workspaces/{WS_ID}/transactions/', owner_token, {
            'id': 'e2e-tx-1', 'month': 'January', 'sequenceNo': 1, 'payeeName': 'E2E Supplies Co.',
            'natureOfTransaction': 'Office supplies purchase', 'grossAmount': 1120.0,
            'netAmount': 1097.6, 'taxWithheld': 22.4, 'status': 'posted', 'isBalanced': True,
            'templateId': 'e2e-tpl-1', 'amountModelVersion': 2,
            'journalLines': [
                {'accountCode': '50203010', 'accountTitle': 'Office Supplies Expense',
                 'debit': 1097.6, 'credit': 0},
                {'accountCode': '10101010', 'accountTitle': 'Cash - Treasury/Agency Check',
                 'debit': 0, 'credit': 1097.6},
            ],
            'attributes': {f'a{i}': 'ok' for i in range(1, 8)},
            'taxComponents': [], 'verificationAuditTrail': [],
        })
        check('rapid entry POST transaction', code == 201, str(tx))
        code, txs = req('GET', f'/workspaces/{WS_ID}/transactions/', owner_token)
        check('transaction list reflects entry', code == 200 and len(txs) == 1, str(txs))

        # 5. Non-member is denied
        code, denied = req('GET', f'/workspaces/{WS_ID}/transactions/', invitee_token)
        check('non-member denied (403/404)', code in (403, 404), f'{code} {denied}')

        # 6. Invite flow
        code, invite = req('POST', f'/workspaces/{WS_ID}/invites/', owner_token, {
            'id': INVITE_ID, 'invitedEmail': INVITEE_EMAIL, 'role': 'encoder',
        })
        check('admin creates invite', code == 201 and invite['status'] == 'pending', str(invite))
        code, mine = req('GET', '/me/invites/', invitee_token)
        check('invitee sees pending invite', code == 200 and any(
            i['id'] == INVITE_ID for i in mine), str(mine))
        code, accepted = req('POST', f'/invites/{INVITE_ID}/accept/', invitee_token)
        check('invitee accepts invite', code == 200, str(accepted))
        code, links = req('GET', '/me/workspaces/', invitee_token)
        check('invitee workspace link exists', code == 200 and WS_ID in json.dumps(links), str(links))
        code, txs = req('GET', f'/workspaces/{WS_ID}/transactions/', invitee_token)
        check('invitee can now read transactions', code == 200 and len(txs) == 1, str(txs))
        check('authorizedUids server-synced to new member',
              'e2e-invitee-sub' in txs[0].get('authorizedUids', []), str(txs[0].get('authorizedUids')))
        code, members = req('GET', f'/workspaces/{WS_ID}/members/', owner_token)
        check('member list shows encoder', code == 200 and any(
            m['uid'] == 'e2e-invitee-sub' and m['role'] == 'encoder' for m in members), str(members))

        # 7. Encoder cannot create tax presets (auditor/admin rule)
        code, denied = req('POST', f'/workspaces/{WS_ID}/tax-presets/', invitee_token, {
            'id': 'e2e-tax-2', 'name': 'X', 'version': '2026', 'effectiveFrom': '2026-01-01',
            'applicableClassification': 'Goods', 'birReference': 'x', 'rate': 0.01,
            'defaultTaxBaseType': 'vatable_sales', 'roundingMethod': 'half_up_2dp',
            'computationRule': 'x',
        })
        check('encoder denied tax preset create', code == 403, f'{code} {denied}')
    finally:
        Workspace.objects.filter(pk=WS_ID).delete()  # cascades all records
        User.objects.filter(username__in=['e2e-owner-sub', 'e2e-invitee-sub']).delete()
        print('Cleanup: workspace + synthetic users removed.')

    print()
    if failures:
        print(f'{len(failures)} FAILED: {failures}')
        sys.exit(1)
    print('ALL LIVE E2E CHECKS PASSED')


if __name__ == '__main__':
    main()