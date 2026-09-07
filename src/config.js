import { clusterApiUrl } from '@solana/web3.js';

export const NETWORK = (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_SOLANA_NETWORK) || 'devnet';
export const DEVNET_RPC_URL = (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_DEVNET_RPC_URL) || 'https://devnet.helius-rpc.com/?api-key=ec93aeac-1895-4773-9d6d-e0f49512691e';
export const MAINNET_RPC_URL = (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_MAINNET_RPC_URL) || clusterApiUrl('mainnet-beta');

export const RPC_URL = NETWORK === 'mainnet-beta' ? MAINNET_RPC_URL : DEVNET_RPC_URL;
