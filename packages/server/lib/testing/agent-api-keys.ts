import type { AgentApiKeyRepository } from '../agents/key-repository';

/**
 * A repository no test path may reach. It lets a test construct a real
 * `AgentApiKeyService` to exercise its pure methods, such as
 * `authorizeCapability`, without re-implementing the grant check.
 */
export function unusedAgentApiKeyRepository(): AgentApiKeyRepository {
  return Object.freeze({
    persistIssuedKey: async () => {
      throw new Error('Unexpected key persistence.');
    },
    findVerifierByPrefix: async () => {
      throw new Error('Unexpected key lookup.');
    },
    appendRevocation: async () => {
      throw new Error('Unexpected key revocation.');
    },
    listSummaries: async () => {
      throw new Error('Unexpected key listing.');
    },
  });
}
