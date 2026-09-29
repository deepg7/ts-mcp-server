import crypto from 'crypto';
import express, { NextFunction, Request, Response, Router } from 'express';

// Google scopes requested on the user's behalf. Extend as tools need more
// (e.g. 'https://www.googleapis.com/auth/calendar.events').
export const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

interface GoogleTokens {
  access_token: string;
  expires_at: number; // epoch ms
  refresh_token?: string;
}

// We act as the MCP authorization server ourselves (Google does not support
// the dynamic client registration MCP clients rely on), and proxy the real
// login to Google with a fixed, pre-registered client id/secret.

interface PendingAuth {
  // keyed by our own state: started at /oauth/authorize, consumed at /oauth/callback
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  state: string; // the MCP client's state, echoed back
}

interface IssuedCode {
  // one-time code the MCP client exchanges at /oauth/token
  google: GoogleTokens;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

const clients = new Map<string, { redirectUris: string[] }>(); // dynamic client registrations
const pendingAuths = new Map<string, PendingAuth>();
const issuedCodes = new Map<string, IssuedCode>();
const accessTokens = new Map<string, GoogleTokens>(); // MCP bearer token -> google tokens
const refreshTokens = new Map<string, { googleRefreshToken: string }>();

// Everything is in memory: a server restart requires re-authenticating. Fine for a dev server.

export function baseUrl(req: Request): string {
  // ngrok sets x-forwarded-proto/host; BASE_URL can pin it explicitly.
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost';
  return `${proto}://${host}`;
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function googleToken(params: Record<string, string>): Promise<any> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json: any = await res.json();
  if (!json.access_token) {
    throw new Error(json.error_description || json.error || 'google token endpoint failed');
  }
  return json;
}

function toGoogleTokens(json: any): GoogleTokens {
  return {
    access_token: json.access_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    refresh_token: json.refresh_token,
  };
}

// Live Google access token for an authenticated MCP request (auto-refreshes).
// Use this inside tools that call Google APIs on the user's behalf.
export async function getGoogleAccessToken(mcpToken: string): Promise<string> {
  const t = accessTokens.get(mcpToken);
  if (!t) throw new Error('invalid MCP token');
  if (t.expires_at > Date.now() + 60_000) return t.access_token;
  if (!t.refresh_token) throw new Error('no refresh token; re-authentication required');
  const fresh = toGoogleTokens(
    await googleToken({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
    })
  );
  fresh.refresh_token = t.refresh_token; // google keeps issuing the same one
  accessTokens.set(mcpToken, fresh);
  return fresh.access_token;
}

// 401 + WWW-Authenticate challenge. This header is what makes Claude Desktop
// open the browser and run the whole OAuth dance, then retry with a Bearer token.
export function requireBearer(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (token && accessTokens.has(token)) return next();

  const meta = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
  const challenge = token
    ? `Bearer error="invalid_token", error_description="token is unknown or expired", resource_metadata="${meta}"`
    : `Bearer resource_metadata="${meta}"`;
  res
    .set('WWW-Authenticate', challenge)
    .status(401)
    .json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: OAuth authentication required' },
      id: null,
    });
}

export function oauthRouter(): Router {
  const r = Router();

  // MCP spec: metadata endpoints must be CORS-accessible (browser-based clients).
  r.use((_req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
  });

  r.get('/.well-known/oauth-protected-resource', (req, res) => {
    const base = baseUrl(req);
    res.json({
      resource: `${base}/`,
      authorization_servers: [base],
      scopes_supported: GOOGLE_SCOPES,
      bearer_methods_supported: ['header'],
    });
  });

  r.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      code_challenge_methods: ['S256'],
      token_endpoint_auth_methods: ['none'],
      scopes_supported: GOOGLE_SCOPES,
    });
  });

  // Dynamic client registration stub: accept whatever the client offers.
  r.post('/oauth/register', (req, res) => {
    const redirectUris: string[] = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris
      : [];
    const clientId = crypto.randomUUID();
    clients.set(clientId, { redirectUris });
    res.status(201).json({
      client_id: clientId,
      client_name: req.body?.client_name || 'mcp-client',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // The MCP client's browser popup lands here first; bounce to Google consent.
  r.get('/oauth/authorize', (req, res) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } =
      req.query as Record<string, string>;
    const client = clients.get(client_id);
    if (response_type !== 'code' || !client || !redirect_uri || !client.redirectUris.includes(redirect_uri)) {
      res.status(400).send('invalid authorization request');
      return;
    }
    if (!code_challenge || code_challenge_method !== 'S256') {
      res.status(400).send('PKCE S256 code_challenge required');
      return;
    }
    const ourState = randomToken();
    pendingAuths.set(ourState, {
      codeChallenge: code_challenge,
      clientId: client_id,
      redirectUri: redirect_uri,
      state: state ?? '',
    });

    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    google.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID || 'MISSING_GOOGLE_CLIENT_ID');
    google.searchParams.set('redirect_uri', `${baseUrl(req)}/oauth/callback`);
    google.searchParams.set('response_type', 'code');
    google.searchParams.set('scope', (req.query.scope as string) || GOOGLE_SCOPES.join(' '));
    google.searchParams.set('access_type', 'offline'); // ask for a refresh token
    google.searchParams.set('prompt', 'consent'); // ...on every login, dev-friendly
    google.searchParams.set('state', ourState);
    res.redirect(google.toString());
  });

  // Google redirects here; swap its code for tokens, hand back our one-time code.
  r.get('/oauth/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query as Record<string, string>;
    const pending = state ? pendingAuths.get(state) : undefined;
    if (error || !code || !pending) {
      res.status(400).send(`Google auth failed: ${error_description || error || 'unknown state'}`);
      return;
    }
    pendingAuths.delete(state);
    const google = toGoogleTokens(
      await googleToken({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${baseUrl(req)}/oauth/callback`,
        grant_type: 'authorization_code',
      })
    );
    const mcpCode = randomToken();
    issuedCodes.set(mcpCode, { google, ...pending });

    const back = new URL(pending.redirectUri);
    back.searchParams.set('code', mcpCode);
    back.searchParams.set('state', pending.state);
    res.redirect(back.toString());
  });

  // OAuth 2.1 token endpoint: PKCE-verified code exchange + refresh grant.
  r.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res) => {
    const { grant_type, code, code_verifier, redirect_uri, client_id, refresh_token } =
      req.body as Record<string, string>;

    if (grant_type === 'authorization_code') {
      const issued = code ? issuedCodes.get(code) : undefined;
      if (
        !issued ||
        issued.redirectUri !== redirect_uri ||
        issued.clientId !== client_id ||
        !code_verifier ||
        s256(code_verifier) !== issued.codeChallenge
      ) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      issuedCodes.delete(code);

      const accessToken = randomToken();
      accessTokens.set(accessToken, issued.google);
      const body: Record<string, unknown> = {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.max(0, Math.floor((issued.google.expires_at - Date.now()) / 1000)),
      };
      if (issued.google.refresh_token) {
        const rt = randomToken();
        refreshTokens.set(rt, { googleRefreshToken: issued.google.refresh_token });
        body.refresh_token = rt;
      }
      res.json(body);
      return;
    }

    if (grant_type === 'refresh_token') {
      const stored = refresh_token ? refreshTokens.get(refresh_token) : undefined;
      if (!stored) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      const google = toGoogleTokens(
        await googleToken({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          grant_type: 'refresh_token',
          refresh_token: stored.googleRefreshToken,
        })
      );
      google.refresh_token = stored.googleRefreshToken;
      const accessToken = randomToken();
      accessTokens.set(accessToken, google);
      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.max(0, Math.floor((google.expires_at - Date.now()) / 1000)),
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  return r;
}