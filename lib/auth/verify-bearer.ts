import { jwtVerify } from 'jose';

/**
 * Local verification for platform-minted access tokens (the Clerk exchange
 * signs HS256 with the project JWT secret). Returns the identity when the
 * token verifies, null when it doesn't — callers then fall back to GoTrue's
 * /user endpoint, which handles ordinary Supabase session tokens.
 */
export type BearerIdentity = {
  id: string;
  phone: string | null;
  email: string | null;
};

export async function verifyMintedBearer(token: string): Promise<BearerIdentity | null> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      audience: 'authenticated',
    });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      phone: (payload.phone as string | undefined) || null,
      email: (payload.email as string | undefined) || null,
    };
  } catch {
    return null;
  }
}
