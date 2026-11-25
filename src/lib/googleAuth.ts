/**
 * Google Identity Services sign-in (replaces Firebase Auth popup).
 * The GIS credential (a Google ID token) is exchanged with the Django
 * backend for the app's JWT pair.
 */
import { apiPost, setTokens, type AuthUser } from './api';

interface GsiCredentialResponse {
  credential: string;
}

interface GsiNotification {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  isDismissedMoment(): boolean;
}

interface GsiId {
  initialize(config: {
    client_id: string;
    callback: (response: GsiCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }): void;
  prompt(listener?: (notification: GsiNotification) => void): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GsiId } };
  }
}

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const GSI_SRC = 'https://accounts.google.com/gsi/client';

function waitForGsi(timeoutMs = 10000): Promise<GsiId> {
  return new Promise((resolve, reject) => {
    const existing = window.google?.accounts?.id;
    if (existing) {
      resolve(existing);
      return;
    }
    if (!document.querySelector(`script[src="${GSI_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    const started = Date.now();
    const timer = setInterval(() => {
      const gsi = window.google?.accounts?.id;
      if (gsi) {
        clearInterval(timer);
        resolve(gsi);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Failed to load Google Identity Services.'));
      }
    }, 100);
  });
}

export async function signInWithGooglePopup(): Promise<AuthUser> {
  if (!CLIENT_ID) {
    throw new Error('VITE_GOOGLE_CLIENT_ID is not configured. Set it in .env.local.');
  }
  const gsi = await waitForGsi();

  return new Promise<AuthUser>((resolve, reject) => {
    let settled = false;
    let fallbackHolder: HTMLDivElement | null = null;

    const cleanup = () => {
      clearTimeout(timeout);
      if (fallbackHolder) {
        fallbackHolder.remove();
        fallbackHolder = null;
      }
    };
    const succeed = (user: AuthUser) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(user);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const timeout = setTimeout(
      () => fail(new Error('Google sign-in was cancelled or timed out.')),
      120000,
    );

    const handleCredential = (response: GsiCredentialResponse) => {
      void (async () => {
        try {
          const data = await apiPost<{ access: string; refresh: string; user: AuthUser }>(
            '/auth/google/',
            { id_token: response.credential },
          );
          setTokens(data.access, data.refresh);
          succeed(data.user);
        } catch (error) {
          fail(error);
        }
      })();
    };

    gsi.initialize({
      client_id: CLIENT_ID,
      callback: handleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });

    const renderButtonFallback = () => {
      if (settled || fallbackHolder) return;
      // One Tap could not show (no Google session / FedCM cooldown). Render a
      // VISIBLE GIS button: popup opens only on a trusted user click, so a
      // programmatic .click() on a hidden button would be popup-blocked.
      fallbackHolder = document.createElement('div');
      fallbackHolder.style.position = 'fixed';
      fallbackHolder.style.inset = '0';
      fallbackHolder.style.zIndex = '9999';
      fallbackHolder.style.display = 'flex';
      fallbackHolder.style.alignItems = 'center';
      fallbackHolder.style.justifyContent = 'center';
      fallbackHolder.style.background = 'rgba(15, 23, 42, 0.55)';

      const card = document.createElement('div');
      card.style.background = '#ffffff';
      card.style.borderRadius = '16px';
      card.style.padding = '24px 28px';
      card.style.boxShadow = '0 20px 50px rgba(0,0,0,0.3)';
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.alignItems = 'center';
      card.style.gap = '14px';

      const label = document.createElement('p');
      label.textContent = 'Continue with your Google account';
      label.style.margin = '0';
      label.style.font = '500 14px system-ui, sans-serif';
      label.style.color = '#334155';
      card.appendChild(label);

      const buttonHost = document.createElement('div');
      card.appendChild(buttonHost);
      gsi.renderButton(buttonHost, { type: 'standard', size: 'large', theme: 'outline' });

      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.style.border = 'none';
      cancel.style.background = 'transparent';
      cancel.style.color = '#64748b';
      cancel.style.cursor = 'pointer';
      cancel.style.font = '500 13px system-ui, sans-serif';
      cancel.addEventListener('click', () =>
        fail(new Error('Google sign-in was cancelled.')),
      );
      card.appendChild(cancel);

      fallbackHolder.appendChild(card);
      document.body.appendChild(fallbackHolder);
    };

    gsi.prompt((notification) => {
      if (
        notification.isNotDisplayed() ||
        notification.isSkippedMoment() ||
        notification.isDismissedMoment()
      ) {
        renderButtonFallback();
      }
    });
  });
}

export function disableGoogleAutoSelect(): void {
  window.google?.accounts?.id?.disableAutoSelect();
}