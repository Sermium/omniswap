import { ethers } from 'ethers';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { SuiClient } from '@mysten/sui/client';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export type ChainType = 'evm' | 'solana' | 'sui';

export interface WalletConfig {
  evm: {
    rpcUrls: Record<number, string>;
  };
  solana: {
    rpcUrl: string;
  };
  sui: {
    rpcUrl: string;
  };
}

export interface ConnectedWallet {
  address: string;
  chainType: ChainType;
  chainId?: number;
  provider: any;
}

export interface SignedTransaction {
  chainType: ChainType;
  signedTx: string | Uint8Array;
  txHash?: string;
}

export interface TransactionRequest {
  chainType: ChainType;
  chainId?: number;
  to: string;
  data: string;
  value?: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface TokenApproval {
  chainType: ChainType;
  chainId: number;
  tokenAddress: string;
  spenderAddress: string;
  amount: string;
  ownerAddress: string;
}

// ============================================================================
// EVM Wallet Service
// ============================================================================

export class EVMWalletService {
  private providers: Map<number, ethers.JsonRpcProvider> = new Map();
  private rpcUrls: Record<number, string>;

  // Standard ERC20 ABI for approvals
  private readonly ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ];

  constructor(rpcUrls: Record<number, string>) {
    this.rpcUrls = rpcUrls;
  }

  getProvider(chainId: number): ethers.JsonRpcProvider {
    if (!this.providers.has(chainId)) {
      const rpcUrl = this.rpcUrls[chainId];
      if (!rpcUrl) {
        throw new Error(`No RPC URL configured for chain ${chainId}`);
      }
      this.providers.set(chainId, new ethers.JsonRpcProvider(rpcUrl));
    }
    return this.providers.get(chainId)!;
  }

  async getBalance(chainId: number, address: string): Promise<string> {
    const provider = this.getProvider(chainId);
    const balance = await provider.getBalance(address);
    return ethers.formatEther(balance);
  }

  async getTokenBalance(
    chainId: number,
    tokenAddress: string,
    walletAddress: string
  ): Promise<{ balance: string; decimals: number; symbol: string }> {
    const provider = this.getProvider(chainId);
    const contract = new ethers.Contract(tokenAddress, this.ERC20_ABI, provider);

    const [balance, decimals, symbol] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.decimals(),
      contract.symbol(),
    ]);

    return {
      balance: ethers.formatUnits(balance, decimals),
      decimals: Number(decimals),
      symbol,
    };
  }

  async checkAllowance(
    chainId: number,
    tokenAddress: string,
    ownerAddress: string,
    spenderAddress: string
  ): Promise<string> {
    const provider = this.getProvider(chainId);
    const contract = new ethers.Contract(tokenAddress, this.ERC20_ABI, provider);
    const allowance = await contract.allowance(ownerAddress, spenderAddress);
    const decimals = await contract.decimals();
    return ethers.formatUnits(allowance, decimals);
  }

  async buildApprovalTransaction(approval: TokenApproval): Promise<TransactionRequest> {
    const provider = this.getProvider(approval.chainId);
    const contract = new ethers.Contract(approval.tokenAddress, this.ERC20_ABI, provider);

    const decimals = await contract.decimals();
    const amount = ethers.parseUnits(approval.amount, decimals);

    const data = contract.interface.encodeFunctionData('approve', [
      approval.spenderAddress,
      amount,
    ]);

    const gasEstimate = await provider.estimateGas({
      from: approval.ownerAddress,
      to: approval.tokenAddress,
      data,
    });

    const feeData = await provider.getFeeData();

    return {
      chainType: 'evm',
      chainId: approval.chainId,
      to: approval.tokenAddress,
      data,
      gasLimit: (gasEstimate * 120n / 100n).toString(), // 20% buffer
      maxFeePerGas: feeData.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
    };
  }

  async buildSwapTransaction(
    chainId: number,
    fromAddress: string,
    toAddress: string,
    data: string,
    value: string = '0'
  ): Promise<TransactionRequest> {
    const provider = this.getProvider(chainId);

    const gasEstimate = await provider.estimateGas({
      from: fromAddress,
      to: toAddress,
      data,
      value: ethers.parseEther(value),
    });

    const feeData = await provider.getFeeData();
    const nonce = await provider.getTransactionCount(fromAddress);

    return {
      chainType: 'evm',
      chainId,
      to: toAddress,
      data,
      value: ethers.parseEther(value).toString(),
      gasLimit: (gasEstimate * 130n / 100n).toString(), // 30% buffer for swaps
      maxFeePerGas: feeData.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
    };
  }

  async sendTransaction(
    chainId: number,
    signedTransaction: string
  ): Promise<{ txHash: string; wait: () => Promise<ethers.TransactionReceipt | null> }> {
    const provider = this.getProvider(chainId);
    const txResponse = await provider.broadcastTransaction(signedTransaction);

    logger.info('EVM transaction broadcast', { chainId, txHash: txResponse.hash });

    return {
      txHash: txResponse.hash,
      wait: () => txResponse.wait(),
    };
  }

  async waitForTransaction(
    chainId: number,
    txHash: string,
    confirmations: number = 1
  ): Promise<ethers.TransactionReceipt | null> {
    const provider = this.getProvider(chainId);
    return provider.waitForTransaction(txHash, confirmations);
  }

  async getGasPrice(chainId: number): Promise<{
    gasPrice: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }> {
    const provider = this.getProvider(chainId);
    const feeData = await provider.getFeeData();

    return {
      gasPrice: feeData.gasPrice?.toString() || '0',
      maxFeePerGas: feeData.maxFeePerGas?.toString() || '0',
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString() || '0',
    };
  }
}

// ============================================================================
// Solana Wallet Service
// ============================================================================

export class SolanaWalletService {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  getConnection(): Connection {
    return this.connection;
  }

  async getBalance(address: string): Promise<string> {
    const publicKey = new PublicKey(address);
    const balance = await this.connection.getBalance(publicKey);
    return (balance / 1e9).toString(); // Convert lamports to SOL
  }

  async getTokenBalance(
    walletAddress: string,
    tokenMint: string
  ): Promise<{ balance: string; decimals: number }> {
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(tokenMint);

    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: mintPubkey }
    );

    if (tokenAccounts.value.length === 0) {
      return { balance: '0', decimals: 9 };
    }

    const accountInfo = tokenAccounts.value[0].account.data.parsed.info;
    return {
      balance: accountInfo.tokenAmount.uiAmountString,
      decimals: accountInfo.tokenAmount.decimals,
    };
  }

  async getRecentBlockhash(): Promise<string> {
    const { blockhash } = await this.connection.getLatestBlockhash();
    return blockhash;
  }

  async sendTransaction(
    signedTransaction: VersionedTransaction | Transaction
  ): Promise<string> {
    const signature = await this.connection.sendRawTransaction(
      signedTransaction.serialize(),
      {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      }
    );

    logger.info('Solana transaction sent', { signature });

    return signature;
  }

  async confirmTransaction(signature: string): Promise<boolean> {
    const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
    return !confirmation.value.err;
  }

  async waitForTransaction(
    signature: string,
    timeout: number = 60000
  ): Promise<{ success: boolean; error?: string }> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const status = await this.connection.getSignatureStatus(signature);

      if (status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized') {
        if (status.value.err) {
          return { success: false, error: JSON.stringify(status.value.err) };
        }
        return { success: true };
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return { success: false, error: 'Transaction confirmation timeout' };
  }

  async getTransactionFee(transaction: Transaction): Promise<number> {
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const fee = await transaction.getEstimatedFee(this.connection);
    return fee || 5000; // Default to 5000 lamports
  }
}

// ============================================================================
// Sui Wallet Service
// ============================================================================

export class SuiWalletService {
  private client: SuiClient;

  constructor(rpcUrl: string) {
    this.client = new SuiClient({ url: rpcUrl });
  }

  getClient(): SuiClient {
    return this.client;
  }

  async getBalance(address: string): Promise<string> {
    const balance = await this.client.getBalance({ owner: address });
    return (Number(balance.totalBalance) / 1e9).toString(); // Convert MIST to SUI
  }

  async getTokenBalance(
    address: string,
    coinType: string
  ): Promise<{ balance: string; decimals: number }> {
    const balance = await this.client.getBalance({
      owner: address,
      coinType,
    });

    // Get coin metadata for decimals
    const metadata = await this.client.getCoinMetadata({ coinType });
    const decimals = metadata?.decimals || 9;

    return {
      balance: (Number(balance.totalBalance) / Math.pow(10, decimals)).toString(),
      decimals,
    };
  }

  async executeTransaction(
    txBytes: Uint8Array,
    signature: string
  ): Promise<{ digest: string; effects: any }> {
    const result = await this.client.executeTransactionBlock({
      transactionBlock: txBytes,
      signature,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    logger.info('Sui transaction executed', { digest: result.digest });

    return {
      digest: result.digest,
      effects: result.effects,
    };
  }

  async waitForTransaction(digest: string): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await this.client.waitForTransactionBlock({
        digest,
        options: { showEffects: true },
      });

      const status = result.effects?.status?.status;
      if (status === 'success') {
        return { success: true };
      }
      return { success: false, error: result.effects?.status?.error };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async getGasPrice(): Promise<string> {
    const gasPrice = await this.client.getReferenceGasPrice();
    return gasPrice.toString();
  }
}

// ============================================================================
// Unified Wallet Service
// ============================================================================

export class WalletService {
  private evmService: EVMWalletService;
  private solanaService: SolanaWalletService;
  private suiService: SuiWalletService;

  constructor(config: WalletConfig) {
    this.evmService = new EVMWalletService(config.evm.rpcUrls);
    this.solanaService = new SolanaWalletService(config.solana.rpcUrl);
    this.suiService = new SuiWalletService(config.sui.rpcUrl);
  }

  getEVMService(): EVMWalletService {
    return this.evmService;
  }

  getSolanaService(): SolanaWalletService {
    return this.solanaService;
  }

  getSuiService(): SuiWalletService {
    return this.suiService;
  }

  getChainType(chainId: number): ChainType {
    if (chainId === 101) return 'solana';
    if (chainId === 784) return 'sui';
    return 'evm';
  }

  async getBalance(chainId: number, address: string): Promise<string> {
    const chainType = this.getChainType(chainId);

    switch (chainType) {
      case 'evm':
        return this.evmService.getBalance(chainId, address);
      case 'solana':
        return this.solanaService.getBalance(address);
      case 'sui':
        return this.suiService.getBalance(address);
    }
  }

  async getTokenBalance(
    chainId: number,
    tokenAddress: string,
    walletAddress: string
  ): Promise<{ balance: string; decimals: number }> {
    const chainType = this.getChainType(chainId);

    switch (chainType) {
      case 'evm': {
        const evmResult = await this.evmService.getTokenBalance(chainId, tokenAddress, walletAddress);
        return { balance: evmResult.balance, decimals: evmResult.decimals };
      }
      case 'solana':
        return this.solanaService.getTokenBalance(walletAddress, tokenAddress);
      case 'sui':
        return this.suiService.getTokenBalance(walletAddress, tokenAddress);
    }
  }
}
