import { createChainModule, type ChainConfig } from '@vaipakam/defi-client';

export type { ChainConfig };

const getEnv = (key: string) => import.meta.env[key as keyof ImportMetaEnv] as string | undefined;

export const chainModule = createChainModule(getEnv);
export const { CHAIN_REGISTRY, DEFAULT_CHAIN, getChainByChainId, isChainSupported } = chainModule;