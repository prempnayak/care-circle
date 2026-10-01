/**
 * Auth lifecycle (handoff §16): link → use → token expiry → refresh → unlink → link a different account.
 * Pass bar: no data crosses accounts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { link, refresh, rpc, startHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness(18797, 18798);
});
afterAll(async () => h?.close());

const status = (token: string) => rpc(h, 'tools/call', { name: 'get_status', arguments: {} }, { token, protocol: '2025-11-25' });

describe('auth lifecycle', () => {
  it('link → use → expire → 401 → refresh → use → unlink → link another account', async () => {
    // Link as Sarah and use it.
    const sarah = await link(h, 'dev-sarah');
    const first = await status(sarah.access_token);
    expect(first.status).toBe(200);
    expect(first.body.result.content[0].text).toContain('Margaret');

    // A token minted two hours ago has expired: 401 so Alexa re-links or refreshes.
    h.authClockOffsetMs.value = -2 * 60 * 60 * 1000;
    const stale = await link(h, 'dev-sarah');
    h.authClockOffsetMs.value = 0;
    const expired = await status(stale.access_token);
    expect(expired.status).toBe(401);
    expect(expired.headers.get('www-authenticate')).toBeNull();

    // Refresh (rotating) and use again.
    const refreshed = await refresh(h, stale.refresh_token);
    expect(refreshed.refresh_token).not.toBe(stale.refresh_token);
    expect((await status(refreshed.access_token)).status).toBe(200);
    // The old refresh token no longer works.
    await expect(refresh(h, stale.refresh_token)).rejects.toThrow();

    // "Unlink" (the client forgets the tokens) and link a brand-new account on the same device.
    const stranger = await link(h, '__new__');
    const other = await status(stranger.access_token);
    expect(other.status).toBe(200);
    expect(other.body.result.isError).toBe(true);
    expect(other.body.result.content[0].text).toBe("You're not in a Care Circle yet. Ask your family for a join code.");
    expect(JSON.stringify(other.body)).not.toContain('Margaret');
  });

  it('the sign-in page form carries every authorize parameter (browser flow)', async () => {
    const q = {
      client_id: 'test-client',
      redirect_uri: 'http://localhost/test-callback',
      response_type: 'code',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      resource: h.mcp,
      state: 's1',
    };
    const html = await (await fetch(`${h.issuer}/authorize?${new URLSearchParams(q)}`)).text();
    for (const [k, v] of Object.entries(q)) expect(html, k).toContain(`name="${k}" value="${v}"`);
  });

  it('a tampered token is rejected', async () => {
    const tom = await link(h, 'dev-tom');
    const [head, payload, sig] = tom.access_token.split('.');
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    forged.sub = 'dev-margaret';
    const tampered = `${head}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    expect((await status(tampered)).status).toBe(401);
  });

  it('the dev authorization server enforces PKCE, redirect URIs and resource', async () => {
    const bad = await fetch(
      `${h.issuer}/authorize?${new URLSearchParams({
        client_id: 'test-client',
        redirect_uri: 'https://evil.example/cb',
        response_type: 'code',
        code_challenge: 'x',
        code_challenge_method: 'S256',
        resource: h.mcp,
      })}`,
    );
    expect(bad.status).toBe(400);
    const plain = await fetch(
      `${h.issuer}/authorize?${new URLSearchParams({
        client_id: 'test-client',
        redirect_uri: 'http://localhost/test-callback',
        response_type: 'code',
        code_challenge: 'x',
        code_challenge_method: 'plain',
        resource: h.mcp,
      })}`,
    );
    expect(plain.status).toBe(400);
    const noResource = await fetch(
      `${h.issuer}/authorize?${new URLSearchParams({
        client_id: 'test-client',
        redirect_uri: 'http://localhost/test-callback',
        response_type: 'code',
        code_challenge: 'x',
        code_challenge_method: 'S256',
      })}`,
    );
    expect(noResource.status).toBe(400);
  });

  it('the dashboard API needs its own resource token and enforces roles', async () => {
    const tomApi = (await link(h, 'dev-tom', `${h.api}/api`)).access_token;
    const sarahApi = (await link(h, 'dev-sarah', `${h.api}/api`)).access_token;
    const me = await (await fetch(`${h.api}/api/me`, { headers: { authorization: `Bearer ${tomApi}` } })).json();
    expect(me.membership.role).toBe('member');
    const circleId = me.membership.circleId;
    // A member can't create join codes; the admin can.
    const denied = await fetch(`${h.api}/api/circles/${circleId}/codes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tomApi}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(denied.status).toBe(403);
    const ok = await fetch(`${h.api}/api/circles/${circleId}/codes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sarahApi}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).code).toMatch(/^\d{6}$/);
    // The timeline shows note text to signed-in members only.
    const timeline = await (await fetch(`${h.api}/api/circles/${circleId}/timeline?days=14`, { headers: { authorization: `Bearer ${tomApi}` } })).json();
    expect(JSON.stringify(timeline)).toContain('The garden looks lovely this morning.');
    const outsider = (await link(h, '__new__', `${h.api}/api`)).access_token;
    expect((await fetch(`${h.api}/api/circles/${circleId}/timeline`, { headers: { authorization: `Bearer ${outsider}` } })).status).toBe(404);
    // An MCP token doesn't open the dashboard API.
    const mcpToken = (await link(h, 'dev-sarah')).access_token;
    expect((await fetch(`${h.api}/api/me`, { headers: { authorization: `Bearer ${mcpToken}` } })).status).toBe(401);
  });

  it('dev endpoints need the X-Dev-Key header', async () => {
    expect((await fetch(`${h.api}/dev/clock`)).status).toBe(404);
    const ok = await fetch(`${h.api}/dev/clock`, { headers: { 'x-dev-key': 'test-dev-key-0123456789' } });
    expect(ok.status).toBe(200);
  });
});
