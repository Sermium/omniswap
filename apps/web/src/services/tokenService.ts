// apps/web/src/services/tokenService.ts

import type { Token } from '@/types';
import tokensData from '@/config/tokens.json';
import { 
  setTokenLogo, 
  deleteTokenLogo, 
  uploadAndSetTokenLogo,
  autoDetectTokenLogo 
} from './logoService';

// ============================================
// Constants
// ============================================

const CUSTOM_TOKENS_KEY = 'omniswap_custom_tokens';
const ADMIN_ADDRESSES_KEY = 'omniswap_admin_addresses';

// ============================================
// Token Registry
// ============================================

// const, not let: the registry is mutated in place (push/splice below) but the
// binding itself is never reassigned, and must not be - other modules hold a
// reference to this exact array.
const tokens: Token[] = [...(tokensData.tokens as Token[])];

// Load custom tokens
const loadCustomTokens = (): void => {
  if (typeof window === 'undefined') return;
  
  try {
    const saved = localStorage.getItem(CUSTOM_TOKENS_KEY);
    if (saved) {
      const customTokens = JSON.parse(saved) as Token[];
      customTokens.forEach(token => {
        const exists = tokens.some(
          t => t.chainId === token.chainId && 
               t.address.toLowerCase() === token.address.toLowerCase()
        );
        if (!exists) {
          tokens.push({ ...token, isCustom: true });
        }
      });
    }
  } catch (e) {
    console.warn('Failed to load custom tokens:', e);
  }
};

// Save custom tokens
const saveCustomTokens = (): void => {
  if (typeof window === 'undefined') return;
  
  try {
    const customTokens = tokens.filter(t => t.isCustom);
    localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(customTokens));
  } catch (e) {
    console.warn('Failed to save custom tokens:', e);
  }
};

// Initialize
if (typeof window !== 'undefined') {
  loadCustomTokens();
}

// ============================================
// Token Getters
// ============================================

export const getAllTokens = (): Token[] => [...tokens];

export const getTokensByChainId = (chainId: number | string): Token[] => {
  return tokens.filter(token => token.chainId === chainId);
};

export const getTokenByAddress = (chainId: number | string, address: string): Token | undefined => {
  return tokens.find(
    token => token.chainId === chainId && 
             token.address.toLowerCase() === address.toLowerCase()
  );
};

export const getNativeToken = (chainId: number | string): Token | undefined => {
  return tokens.find(token => token.chainId === chainId && token.address === 'native');
};

export const searchTokens = (query: string, chainId?: number | string): Token[] => {
  const q = query.toLowerCase();
  return tokens.filter(token => {
    if (chainId && token.chainId !== chainId) return false;
    return (
      token.symbol.toLowerCase().includes(q) ||
      token.name.toLowerCase().includes(q) ||
      token.address.toLowerCase().includes(q)
    );
  });
};

// ============================================
// Admin Check
// ============================================

const getAdminAddresses = (): string[] => {
  if (typeof window === 'undefined') return [];
  
  try {
    const envAdmins = process.env.NEXT_PUBLIC_ADMIN_ADDRESSES?.split(',') || [];
    const saved = localStorage.getItem(ADMIN_ADDRESSES_KEY);
    const customAdmins = saved ? JSON.parse(saved) : [];
    return [...new Set([...envAdmins, ...customAdmins])].map(a => a.toLowerCase().trim());
  } catch {
    return [];
  }
};

export const isAdmin = (address: string): boolean => {
  if (!address) return false;
  return getAdminAddresses().includes(address.toLowerCase());
};

// ============================================
// Token CRUD (Admin Only)
// ============================================

// ADD THIS - Export the type with the name expected by TokenManager
export interface AddTokenParams {
  chainId: number | string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  tags?: string[];
  logoUrl?: string;
  logoFile?: File;
}

// Keep the old name for backwards compatibility
export type AddTokenInput = AddTokenParams;

export const addToken = async (
  input: AddTokenParams,
  adminAddress: string
): Promise<Token> => {
  if (!isAdmin(adminAddress)) {
    throw new Error('Admin access required');
  }
  
  // Check duplicate
  const existing = getTokenByAddress(input.chainId, input.address);
  if (existing) {
    throw new Error('Token already exists');
  }
  
  // Create token
  const token: Token = {
    chainId: input.chainId,
    address: input.address,
    symbol: input.symbol.toUpperCase(),
    name: input.name,
    decimals: input.decimals,
    logoURI: null,
    tags: input.tags || [],
    popularity: 0,
    isCustom: true,
    addedAt: Date.now(),
    addedBy: adminAddress,
  };
  
  // Handle logo
  if (input.logoFile) {
    const logoUrl = await uploadAndSetTokenLogo(input.logoFile, input.chainId, input.address);
    token.logoURI = logoUrl;
  } else if (input.logoUrl) {
    setTokenLogo(input.chainId, input.address, input.logoUrl);
    token.logoURI = input.logoUrl;
  } else {
    // Auto-detect
    const detected = await autoDetectTokenLogo(input.chainId, input.address, input.symbol);
    if (detected) {
      setTokenLogo(input.chainId, input.address, detected);
      token.logoURI = detected;
    }
  }
  
  tokens.push(token);
  saveCustomTokens();
  
  return token;
};

export const updateToken = (
  chainId: number | string,
  address: string,
  updates: Partial<Pick<Token, 'symbol' | 'name' | 'decimals' | 'tags'>>,
  adminAddress: string
): Token => {
  if (!isAdmin(adminAddress)) {
    throw new Error('Admin access required');
  }
  
  const index = tokens.findIndex(
    t => t.chainId === chainId && t.address.toLowerCase() === address.toLowerCase()
  );
  
  if (index === -1) {
    throw new Error('Token not found');
  }
  
  tokens[index] = { ...tokens[index], ...updates };
  saveCustomTokens();
  
  return tokens[index];
};

// ADD THIS - Function expected by TokenManager
export const updateTokenLogo = async (
  chainId: number | string,
  address: string,
  logo: { url?: string; file?: File },
  adminAddress: string
): Promise<void> => {
  if (!isAdmin(adminAddress)) {
    throw new Error('Admin access required');
  }
  
  const token = getTokenByAddress(chainId, address);
  if (!token) {
    throw new Error('Token not found');
  }
  
  if (logo.file) {
    const logoUrl = await uploadAndSetTokenLogo(logo.file, chainId, address);
    token.logoURI = logoUrl;
  } else if (logo.url) {
    setTokenLogo(chainId, address, logo.url);
    token.logoURI = logo.url;
  }
  
  saveCustomTokens();
};

export const updateTokenLogoByUrl = (
  chainId: number | string,
  address: string,
  logoUrl: string,
  adminAddress: string
): void => {
  if (!isAdmin(adminAddress)) {
    throw new Error('Admin access required');
  }
  
  const token = getTokenByAddress(chainId, address);
  if (!token) {
    throw new Error('Token not found');
  }
  
  setTokenLogo(chainId, address, logoUrl);
  token.logoURI = logoUrl;
  saveCustomTokens();
};

export const updateTokenLogoByFile = async (
  chainId: number | string,
  address: string,
  file: File,
  adminAddress: string
): Promise<string> => {
  if (!isAdmin(adminAddress)) {
    throw new Error('Admin access required');
  }
  
  const token = getTokenByAddress(chainId, address);
  if (!token) {
    throw new Error('Token not found');
  }
  
  const logoUrl = await uploadAndSetTokenLogo(file, chainId, address);
  token.logoURI = logoUrl;
  saveCustomTokens();
  
  return logoUrl;
};

export const removeToken = (
  chainId: number | string,
  address: string,
  adminAddress: string
): void => {
  if (!isAdmin(adminAddress)) {
    throw new Error('Admin access required');
  }
  
  const index = tokens.findIndex(
    t => t.chainId === chainId && t.address.toLowerCase() === address.toLowerCase()
  );
  
  if (index === -1) {
    throw new Error('Token not found');
  }
  
  if (!tokens[index].isCustom) {
    throw new Error('Cannot remove built-in tokens');
  }
  
  // Remove logo
  deleteTokenLogo(chainId, address);
  
  // Remove token
  tokens.splice(index, 1);
  saveCustomTokens();
};

// ============================================
// Export
// ============================================

// ADD THIS - Function name expected by TokenManager
export const exportTokens = (): string => {
  return JSON.stringify({ tokens }, null, 2);
};

// ADD THIS - Function name expected by TokenManager
export const exportCustomTokens = (): string => {
  const customTokens = tokens.filter(t => t.isCustom);
  return JSON.stringify({ tokens: customTokens }, null, 2);
};

// Keep old names for backwards compatibility
export const exportTokensAsJson = exportTokens;
export const exportCustomTokensAsJson = exportCustomTokens;