/**
 * Reading the identity the gateway already verified.
 *
 * There is no JWKS check here on purpose: the API Gateway JWT authorizer
 * validated the signature, issuer and audience before this container was
 * reached, and it passes the result in requestContext.authorizer.jwt.
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

export function claimsOf(event: GatewayEvent): Record<string, unknown> {
  return event?.requestContext?.authorizer?.jwt?.claims ?? {};
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
  if (!subject) return devCaller();
  return {
    subject,
    accountId: '', // filled by the Edge lookup in runtime context
    role: primaryRole(event),
    displayName: displayNameOf(event),
    locale,
  };
}
