import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FacadeActor, FacadeIdentityIssuer, FacadeSnapshot, FacadeStore } from "./types.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function findIdentityByTokenHash(
  identities: FacadeSnapshot["identities"],
  tokenHash: string,
): FacadeSnapshot["identities"][string] | undefined {
  const presented = Buffer.from(tokenHash, "hex");
  let matched: FacadeSnapshot["identities"][string] | undefined;
  for (const identity of Object.values(identities)) {
    const candidate = Buffer.from(identity.tokenHash, "hex");
    if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) {
      matched = identity;
    }
  }
  return matched;
}

export function createFacadeIdentityIssuer(options: {
  store: FacadeStore;
  ttlMs?: number;
  now?: () => number;
}): FacadeIdentityIssuer {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1_000;

  return {
    async issue(actor: FacadeActor): Promise<string> {
      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashToken(token);
      const createdAt = new Date(now()).toISOString();
      const expiresAt = new Date(now() + ttlMs).toISOString();
      await options.store.update((snapshot) => {
        for (const identity of Object.values(snapshot.identities)) {
          if (identity.actor.agentId === actor.agentId) {
            identity.revoked = true;
          }
        }
        snapshot.identities[tokenHash] = {
          tokenHash,
          actor,
          revoked: false,
          createdAt,
          expiresAt,
        };
      });
      return token;
    },

    async authenticate(token: string): Promise<FacadeActor | undefined> {
      const tokenHash = hashToken(token);
      return await options.store.read((snapshot) => {
        const identity = findIdentityByTokenHash(snapshot.identities, tokenHash);
        if (!identity || identity.revoked || Date.parse(identity.expiresAt) <= now()) {
          return undefined;
        }
        return identity.actor;
      });
    },

    async revokeAgent(agentId: string): Promise<void> {
      await options.store.update((snapshot) => {
        for (const identity of Object.values(snapshot.identities)) {
          if (identity.actor.agentId === agentId) {
            identity.revoked = true;
          }
        }
      });
    },
  };
}
