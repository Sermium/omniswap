// apps/web/src/hooks/useWallet.ts
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { useWallet as useSolanaWallet } from '@solana/wallet-adapter-react';
import { useCurrentAccount, useDisconnectWallet, useConnectWallet } from '@mysten/dapp-kit';
import { ChainType } from '@omniswap/types';

interface WalletState {
  isConnected: boolean;
  isConnecting: boolean;
  address: string | null;
  chainId: number | string | null;
  chainType: ChainType | null;
  walletName: string | null;
  connect: (chainType?: ChainType) => Promise<void>;
  disconnect: () => Promise<void>;
  switchChain: (chainId: number) => Promise<void>;
}

export const useWallet = (preferredChainType?: ChainType): WalletState => {
  const [activeChainType, setActiveChainType] = useState<ChainType | null>(
    preferredChainType || null
  );

  // EVM (wagmi)
  const evmAccount = useAccount();
  const { connectAsync: evmConnect, connectors: evmConnectors } = useConnect();
  const { disconnectAsync: evmDisconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();

  // Solana
  const solanaWallet = useSolanaWallet();

  // Sui
  const suiAccount = useCurrentAccount();
  const { mutateAsync: suiConnect } = useConnectWallet();
  const { mutateAsync: suiDisconnect } = useDisconnectWallet();

  // Determine which wallet is connected
  const connectedWallet = useMemo(() => {
    if (evmAccount.isConnected && evmAccount.address) {
      return {
        type: 'EVM' as ChainType,
        address: evmAccount.address,
        chainId: evmAccount.chainId,
        walletName: evmAccount.connector?.name || 'EVM Wallet',
      };
    }
    
    if (solanaWallet.connected && solanaWallet.publicKey) {
      return {
        type: 'SOLANA' as ChainType,
        address: solanaWallet.publicKey.toBase58(),
        chainId: 'solana-mainnet',
        walletName: solanaWallet.wallet?.adapter.name || 'Solana Wallet',
      };
    }
    
    if (suiAccount?.address) {
      return {
        type: 'SUI' as ChainType,
        address: suiAccount.address,
        chainId: 'sui-mainnet',
        walletName: 'Sui Wallet',
      };
    }
    
    return null;
  }, [evmAccount, solanaWallet, suiAccount]);

  // Connection state
  const isConnecting = 
    evmAccount.isConnecting || 
    solanaWallet.connecting ||
    false; // Sui doesn't have connecting state

  // Connect function
  const connect = useCallback(async (chainType?: ChainType) => {
    const targetChainType = chainType || preferredChainType || 'EVM';
    setActiveChainType(targetChainType);

    try {
      switch (targetChainType) {
        case 'EVM': {
          // Find the injected connector (MetaMask, etc.)
          const injectedConnector = evmConnectors.find(
            (c) => c.id === 'injected' || c.id === 'metaMask'
          );
          if (injectedConnector) {
            await evmConnect({ connector: injectedConnector });
          }
          break;
        }

        case 'SOLANA':
          // Trigger Solana wallet modal
          if (solanaWallet.wallet) {
            await solanaWallet.connect();
          } else {
            // Open wallet selection modal - handled by WalletMultiButton
            solanaWallet.select(null as any); // This triggers the modal
          }
          break;

        case 'SUI':
          await suiConnect({ wallet: null as any }); // Opens Sui wallet modal
          break;

        default:
          throw new Error(`Unsupported chain type: ${targetChainType}`);
      }
    } catch (error) {
      console.error(`Failed to connect ${targetChainType} wallet:`, error);
      throw error;
    }
  }, [preferredChainType, evmConnect, evmConnectors, solanaWallet, suiConnect]);

  // Disconnect function
  const disconnect = useCallback(async () => {
    try {
      if (connectedWallet?.type === 'EVM') {
        await evmDisconnect();
      } else if (connectedWallet?.type === 'SOLANA') {
        await solanaWallet.disconnect();
      } else if (connectedWallet?.type === 'SUI') {
        await suiDisconnect();
      }
      setActiveChainType(null);
    } catch (error) {
      console.error('Failed to disconnect wallet:', error);
      throw error;
    }
  }, [connectedWallet, evmDisconnect, solanaWallet, suiDisconnect]);

  // Switch chain (EVM only)
  const switchChain = useCallback(async (chainId: number) => {
    if (connectedWallet?.type !== 'EVM') {
      throw new Error('Chain switching is only supported for EVM wallets');
    }
    
    try {
      await switchChainAsync({ chainId });
    } catch (error) {
      console.error('Failed to switch chain:', error);
      throw error;
    }
  }, [connectedWallet, switchChainAsync]);

  return {
    isConnected: !!connectedWallet,
    isConnecting,
    address: connectedWallet?.address || null,
    chainId: connectedWallet?.chainId || null,
    chainType: connectedWallet?.type || null,
    walletName: connectedWallet?.walletName || null,
    connect,
    disconnect,
    switchChain,
  };
};
