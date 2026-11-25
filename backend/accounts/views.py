from django.conf import settings
from django.contrib.auth import get_user_model
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken

User = get_user_model()


def user_payload(user):
    """Firebase-User-shaped adapter consumed by the frontend context."""
    return {
        'uid': user.username,
        'email': user.email,
        'displayName': user.first_name or (user.email.split('@')[0] if user.email else 'User'),
        'emailVerified': True,
    }


@api_view(['POST'])
@permission_classes([AllowAny])
def google_login(request):
    token = request.data.get('id_token')
    if not token:
        return Response({'detail': 'id_token is required.'}, status=status.HTTP_400_BAD_REQUEST)
    if not settings.GOOGLE_CLIENT_ID:
        return Response(
            {'detail': 'GOOGLE_CLIENT_ID is not configured on the server.'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    try:
        claims = google_id_token.verify_oauth2_token(
            token, google_requests.Request(), settings.GOOGLE_CLIENT_ID
        )
    except ValueError:
        return Response({'detail': 'Invalid Google ID token.'}, status=status.HTTP_401_UNAUTHORIZED)

    sub = claims.get('sub')
    email = (claims.get('email') or '').lower()
    if not sub or not email or not claims.get('email_verified'):
        return Response(
            {'detail': 'Google account email is missing or not verified.'},
            status=status.HTTP_401_UNAUTHORIZED,
        )

    display_name = (claims.get('name') or email.split('@')[0])[:150]
    user, _created = User.objects.get_or_create(
        username=sub, defaults={'email': email, 'first_name': display_name}
    )
    if user.email != email or user.first_name != display_name:
        user.email = email
        user.first_name = display_name
        user.save(update_fields=['email', 'first_name'])

    refresh = RefreshToken.for_user(user)
    return Response(
        {
            'access': str(refresh.access_token),
            'refresh': str(refresh),
            'user': user_payload(user),
        }
    )


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def me(request):
    return Response(user_payload(request.user))