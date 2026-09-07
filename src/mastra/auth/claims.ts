/**
 * Reading the identity the gateway already verified.
 *
 * There is no JWKS check here on purpose: the API Gateway JWT authorizer
 * validated the signature, issuer and audience before this container was
 * reached. Cloud Functions get that in requestContext.authorizer.jwt.
 * A serverless container gets HTTP: the same payload arrives as
 * X-Yc-Apigateway-Authorization-Context (Base64), and the original
 * Authorization header is still on the request.
 *
 * The account is not in the token. Keycloak owns the identity, the product
 * owns tenancy, so `sub` is resolved through Edge.
 */

export type Role = 'client' | 'specialist' | 'operator' | 'admin';

export interface Caller {
  subject: string;
  accountId: string;
  role: Role;
  displayName: string;
  locale: string;
}

interface GatewayEvent {
  requestContext?: {
    authorizer?: {
      jwt?: {
        claims?: Record<string, unknown>;
        scopes?: string[];
      };
    };
  };
  headers?: Record<string, string>;
}

function headerOf(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return '';
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want && value) return value;
  }
  return '';
}

function decodeJsonB64(raw: string): unknown {
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function asClaims(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function claimsFromAuthorizer(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const root = value as Record<string, unknown>;
  return (
    asClaims(root.claims) ??
    asClaims((root.jwt as { claims?: unknown } | undefined)?.claims) ??
    asClaims((root.authorizer as { jwt?: { claims?: unknown } } | undefined)?.jwt?.claims) ??
    (typeof root.sub === 'string' ? root : {})
  );
}

function claimsFromBearer(authorization: string): Record<string, unknown> {
  const token = authorization.replace(/^Bearer\s+/i, '');
  const payload = token.split('.')[1];
  return payload ? claimsFromAuthorizer(decodeJsonB64(payload)) : {};
}

export function claimsOf(event: GatewayEvent): Record<string, unknown> {
  const fromRc = asClaims(event?.requestContext?.authorizer?.jwt?.claims);
  if (fromRc && Object.keys(fromRc).length) return fromRc;

  const contextHeader = headerOf(event.headers, 'x-yc-apigateway-authorization-context');
  if (contextHeader) {
    const fromHeader = claimsFromAuthorizer(decodeJsonB64(contextHeader));
    if (Object.keys(fromHeader).length) return fromHeader;
  }

  const authorization = headerOf(event.headers, 'authorization');
  if (authorization) return claimsFromBearer(authorization);
  return {};
}

export function subjectOf(event: GatewayEvent): string {
  const sub = claimsOf(event).sub;
  return typeof sub === 'string' ? sub : '';
}

export function rolesOf(event: GatewayEvent): Role[] {
  const raw = claimsOf(event).roles;
  const known: Role[] = ['client', 'specialist', 'operator', 'admin'];
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Role => known.includes(item as Role));
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[\s,]+/)
      .filter((item): item is Role => known.includes(item as Role));
  }
  return [];
}

/** The narrowest role wins: a specialist acting in the cabinet is still a user. */
export function primaryRole(event: GatewayEvent): Role {
  const roles = rolesOf(event);
  for (const candidate of ['admin', 'operator', 'specialist', 'client'] as const) {
    if (roles.includes(candidate)) return candidate;
  }
  return 'client';
}

export function displayNameOf(event: GatewayEvent): string {
  const claims = claimsOf(event);
  const name = claims.name ?? claims.preferred_username ?? claims.email;
  return typeof name === 'string' ? name : '';
}

/**
 * Dev fallback for local `mastra dev`, where no gateway sits in front.
 * Never reachable in the cloud: the authorizer rejects a request without a
 * token before the container is invoked.
 */
export function devCaller(): Caller | null {
  const accountId = process.env.AGENT_DEV_ACCOUNT_ID;
  if (!accountId) return null;
  return {
    subject: process.env.AGENT_DEV_SUBJECT ?? 'dev-subject',
    accountId,
    role: (process.env.AGENT_DEV_ROLE as Role) ?? 'client',
    displayName: process.env.AGENT_DEV_NAME ?? 'Dev user',
    locale: process.env.AGENT_DEV_LOCALE ?? 'zh',
  };
}

export function callerFrom(event: GatewayEvent, locale = 'zh'): Caller | null {
  const subject = subjectOf(event);
  if (!subject) {
    const fallback = devCaller();
    return fallback ? { ...fallback, locale } : null;
  }
  return {
    subject,
    accountId: '', // filled by the Edge lookup in runtime context
    role: primaryRole(event),
    displayName: displayNameOf(event),
    locale,
  };
}
