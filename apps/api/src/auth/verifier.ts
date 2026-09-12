import { jwtVerify, type JWTVerifyOptions } from "jose";
import type { JwtConfig } from "../config.js";
import { apiErrors } from "../errors.js";
import { JwtClaimsSchema, principalFromClaims, type Principal } from "./principal.js";

export type TokenVerifier = (token: string) => Promise<Principal>;

/**
 * Verifies HS256 bearer tokens against locally configured issuer and audience.
 * Verifier failures are collapsed into one authentication error: token or
 * signature detail is never echoed to the caller or logged.
 */
export function createTokenVerifier(config: JwtConfig): TokenVerifier {
  const key = new TextEncoder().encode(config.secret);
  const options: JWTVerifyOptions = {
    algorithms: ["HS256"],
    issuer: config.issuer,
    audience: config.audience,
    clockTolerance: 5,
  };

  return async (token: string): Promise<Principal> => {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, key, options));
    } catch {
      throw apiErrors.unauthenticated();
    }

    const claims = JwtClaimsSchema.safeParse(payload);
    if (!claims.success) {
      throw apiErrors.unauthenticated();
    }
    return principalFromClaims(claims.data);
  };
}
