from django.urls import path

from . import views

workspace_list = views.WorkspaceViewSet.as_view({'get': 'list', 'post': 'create'})
workspace_detail = views.WorkspaceViewSet.as_view(
    {'get': 'retrieve', 'patch': 'partial_update', 'put': 'update', 'delete': 'destroy'}
)


def nested_routes(segment, viewset, extra_batch=False, extra_detail=None):
    list_view = viewset.as_view({'get': 'list', 'post': 'create'})
    detail_actions = {'get': 'retrieve', 'patch': 'partial_update', 'put': 'update', 'delete': 'destroy'}
    detail_view = viewset.as_view(detail_actions)
    prefix = f'workspaces/<str:workspace_id>/{segment}/'
    routes = []
    if extra_batch:
        routes.append(path(prefix + 'batch/', viewset.as_view({'post': 'batch'})))
    if extra_detail:
        for suffix, actions in extra_detail.items():
            routes.append(path(prefix + f'<str:pk>/{suffix}/', viewset.as_view(actions)))
    routes.append(path(prefix, list_view))
    routes.append(path(prefix + '<str:pk>/', detail_view))
    return routes


urlpatterns = [
    path('me/workspaces/', views.MyWorkspacesView.as_view()),
    path('me/invites/', views.MyInvitesView.as_view()),
    path('philgeps/merchants/', views.PhilGepsLookupView.as_view()),
    path('invites/<str:pk>/accept/', views.accept_invite),
    path('workspaces/', workspace_list),
    path('workspaces/<str:pk>/', workspace_detail),
    path(
        'workspaces/<str:workspace_id>/members/',
        views.WorkspaceMemberViewSet.as_view({'get': 'list'}),
    ),
    path(
        'workspaces/<str:workspace_id>/members/<str:pk>/',
        views.WorkspaceMemberViewSet.as_view({'patch': 'partial_update', 'delete': 'destroy'}),
    ),
    path(
        'workspaces/<str:workspace_id>/invites/',
        views.WorkspaceInviteViewSet.as_view({'get': 'list', 'post': 'create'}),
    ),
    path(
        'workspaces/<str:workspace_id>/invites/<str:pk>/',
        views.WorkspaceInviteViewSet.as_view({'delete': 'destroy'}),
    ),
    *nested_routes(
        'transactions',
        views.TransactionViewSet,
        extra_batch=True,
        extra_detail={'upgrade-v2': {'post': 'upgrade_v2'}},
    ),
    *nested_routes('templates', views.EntryTemplateViewSet, extra_batch=True),
    *nested_routes('payees', views.PayeeViewSet, extra_batch=True),
    *nested_routes('coa-accounts', views.CoaAccountViewSet, extra_batch=True),
    *nested_routes('tax-presets', views.TaxPresetViewSet),
]