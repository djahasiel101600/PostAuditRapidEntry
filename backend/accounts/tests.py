"""Google sign-in tests with mocked token verification."""
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase

User = get_user_model()

CLAIMS = {
    'sub': 'google-sub-123',
    'email': 'clerk@example.com',
    'email_verified': True,
    'name': 'Test Clerk',
}


@override_settings(GOOGLE_CLIENT_ID='test-client-id.apps.googleusercontent.com')
class GoogleAuthTests(APITestCase):
    def test_login_creates_user_and_returns_jwt(self):
        with patch('accounts.views.google_id_token.verify_oauth2_token', return_value=CLAIMS):
            response = self.client.post('/api/auth/google/', {'id_token': 'fake'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn('access', response.data)
        self.assertIn('refresh', response.data)
        self.assertEqual(response.data['user']['uid'], 'google-sub-123')
        self.assertEqual(response.data['user']['email'], 'clerk@example.com')
        self.assertEqual(response.data['user']['displayName'], 'Test Clerk')
        self.assertTrue(User.objects.filter(username='google-sub-123').exists())

        # /me with the issued JWT
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        me = self.client.get('/api/me/')
        self.assertEqual(me.status_code, status.HTTP_200_OK)
        self.assertEqual(me.data['uid'], 'google-sub-123')

    def test_invalid_token_rejected(self):
        with patch(
            'accounts.views.google_id_token.verify_oauth2_token', side_effect=ValueError('bad token')
        ):
            response = self.client.post('/api/auth/google/', {'id_token': 'bad'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_unverified_email_rejected(self):
        with patch(
            'accounts.views.google_id_token.verify_oauth2_token',
            return_value=dict(CLAIMS, email_verified=False),
        ):
            response = self.client.post('/api/auth/google/', {'id_token': 'fake'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_missing_token_rejected(self):
        response = self.client.post('/api/auth/google/', {}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_refresh_flow(self):
        with patch('accounts.views.google_id_token.verify_oauth2_token', return_value=CLAIMS):
            login = self.client.post('/api/auth/google/', {'id_token': 'fake'}, format='json')
        response = self.client.post(
            '/api/auth/refresh/', {'refresh': login.data['refresh']}, format='json'
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn('access', response.data)