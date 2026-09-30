import type { DevClient } from './app';

/**
 * Statically registered clients (Alexa doesn't support dynamic client registration).
 * The Alexa redirect URIs are the documented account-linking hosts; the real ones come from the
 * Alexa developer console, which hackathon entrants can't reach.
 */
export function devClients(env: NodeJS.ProcessEnv): DevClient[] {
  const dashboard = (env.DASHBOARD_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  const simAgent = `http://localhost:${env.SIM_AGENT_PORT ?? 8790}`;
  return [
    {
      clientId: 'alexa',
      secret: env.DEV_ALEXA_CLIENT_SECRET ?? 'dev-alexa-secret',
      redirectUris: [
        'https://pitangui.amazon.com/api/skill/link/DEV',
        'https://layla.amazon.com/api/skill/link/DEV',
        'https://alexa.amazon.co.jp/api/skill/link/DEV',
      ],
    },
    { clientId: 'simulator', redirectUris: [`${simAgent}/link/callback`] },
    { clientId: 'dashboard', redirectUris: [`${dashboard}/callback`] },
    // Used by contract tests and scripts that complete the flow programmatically.
    { clientId: 'test-client', redirectUris: ['http://localhost/test-callback'] },
  ];
}
