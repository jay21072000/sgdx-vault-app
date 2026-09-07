/**
 * SgdxVault.jsx
 * ──────────────────────────────────────────────────────────────────────────
 * Standalone SGDX Vault UI — Devnet Platform
 */

import React, { useState, useCallback, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, Connection, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  buildCreateSgdxMintTransaction,
  buildCreateDevUsdtMintTransaction,
  buildFaucetTransaction,
  buildInitializeVaultTransaction,
  buildDepositTransaction,
  buildRedeemTransaction,
  buildUpdateMockPriceTransaction,
  fetchVaultState,
  getVaultStatePDA,
  getVaultAuthorityPDA,
  calcSgdxOut,
  calcCollateralOut,
  formatTokenAmount,
  parseTokenAmount,
  SGDX_TRANSFER_FEE_BASIS_POINTS,
  SGDX_DECIMALS,
} from "../utils/sgdxVaultProgram";
import {
  fetchPythUsdSgdPrice,
  convertPriceToNumeratorDenominator,
  PYTH_USD_SGD_FEED_ID,
} from "../utils/SgdxVaultOracle";
import { RPC_URL } from "../config";

const DEVNET_RPCS = [
  RPC_URL,
  "https://rpc.ankr.com/solana_devnet",
];

async function fetchDevnetBalanceDirect(pubkey, customEndpoint) {
  const rpcs = customEndpoint ? [customEndpoint, ...DEVNET_RPCS] : DEVNET_RPCS;
  for (const endpoint of rpcs) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBalance",
          params: [pubkey.toString()],
        }),
      });
      const json = await res.json();
      if (json && json.result && typeof json.result.value === "number") {
        return json.result.value;
      }
    } catch (e) {
      console.warn(`Direct JSON-RPC fetch error on ${endpoint}:`, e.message);
    }
  }
  throw new Error("getBalance failed across endpoints");
}

async function executeWithRpcFailover(primaryConn, actionFn) {
  try {
    return await actionFn(primaryConn);
  } catch (e) {
    console.warn("Primary Connection failed, retrying with fallback Connection:", e.message);
    const endpoint = primaryConn?.rpcEndpoint || RPC_URL;
    const fallbackConn = new Connection(endpoint, "confirmed");
    return await actionFn(fallbackConn);
  }
}

const LS_SGDX_MINT = "sgdx_vault_sgdx_mint";
const LS_COLLATERAL_MINT = "sgdx_vault_collateral_mint";
const STATUS = { IDLE: "idle", LOADING: "loading", SUCCESS: "success", ERROR: "error" };

function useStatusState() {
  const [status, setStatus] = useState(STATUS.IDLE);
  const [message, setMessage] = useState("");
  const set = useCallback((s, m = "") => { setStatus(s); setMessage(m); }, []);
  return { status, message, set };
}

function StatusMessage({ state, sig }) {
  if (state.status === STATUS.IDLE) return null;
  return (
    <div className={`status-box ${state.status}`}>
      <span>{state.message}</span>
      {sig && (
        <a
          href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="explorer-link"
        >
          View on Solana Explorer ↗
        </a>
      )}
    </div>
  );
}

function SetupStep({ number, title, description, done, value, label, children }) {
  return (
    <div className={`setup-step-card ${done ? "completed" : ""}`}>
      <div className="step-header">
        <span className="step-number">{done ? "✓" : number}</span>
        <div className="step-title">
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
        {done && <span className="step-badge success">Ready</span>}
      </div>

      {value && (
        <div className="step-output">
          <span className="output-label">{label}:</span>
          <code className="output-value">{value}</code>
        </div>
      )}

      {!done && <div className="step-actions">{children}</div>}
    </div>
  );
}

class VaultErrorBoundary extends React.Component {
  state = { hasError: false, error: null };
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="vault-error-boundary">
          <span className="vault-error-icon">⚠️</span>
          <h3>Vault component error</h3>
          <p>{this.state.error?.message}</p>
          <button onClick={() => this.setState({ hasError: false, error: null })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function SgdxVault() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction, connected } = useWallet();

  const DEFAULT_DEV_USDT = "B13ghd5HQkK5MB6obAj2hn8fuoQSFdCu1YjNz5Z9tYMb";
  const DEFAULT_SGDX = "82wKW7CqE9GVgjyq8GpP2WGqitWbcb3mPb8x4xG5oYSh";

  const [sgdxMint, setSgdxMint] = useState(() => {
    const saved = localStorage.getItem(LS_SGDX_MINT);
    try { return saved ? new PublicKey(saved) : new PublicKey(DEFAULT_SGDX); } catch { return new PublicKey(DEFAULT_SGDX); }
  });
  const [collateralMint, setCollateralMint] = useState(() => {
    const saved = localStorage.getItem(LS_COLLATERAL_MINT);
    try { return saved ? new PublicKey(saved) : new PublicKey(DEFAULT_DEV_USDT); } catch { return new PublicKey(DEFAULT_DEV_USDT); }
  });

  const [vaultState, setVaultState] = useState(null);
  const [vaultInitialized, setVaultInitialized] = useState(false);

  const [collateralBalance, setCollateralBalance] = useState("0");
  const [sgdxBalance, setSgdxBalance] = useState("0");
  const [vaultCollateralBalance, setVaultCollateralBalance] = useState("0");

  const [solBalanceState, setSolBalanceState] = useState({
    balance: null,
    isError: false,
    isLoading: false,
    errorMessage: "",
  });
  const [isRequestingAirdrop, setIsRequestingAirdrop] = useState(false);

  const [activeTab, setActiveTab] = useState("deposit");

  const [depositAmount, setDepositAmount] = useState("");
  const [redeemAmount, setRedeemAmount] = useState("");
  const [faucetAmount, setFaucetAmount] = useState("5");

  const setupStatus = useStatusState();
  const depositStatus = useStatusState();
  const redeemStatus = useStatusState();
  const faucetStatus = useStatusState();
  const pythStatus = useStatusState();

  const [pythOracleInfo, setPythOracleInfo] = useState(null);
  const [lastTxSig, setLastTxSig] = useState(null);

  const loadDevnetSolBalance = useCallback(async () => {
    if (!publicKey) return;
    setSolBalanceState((prev) => ({ ...prev, isLoading: true, isError: false }));

    try {
      const activeEndpoint = connection?.rpcEndpoint || RPC_URL;
      const balLamports = await fetchDevnetBalanceDirect(publicKey, activeEndpoint);
      const sol = balLamports / 1e9;
      setSolBalanceState({ balance: sol, isError: false, isLoading: false, errorMessage: "" });
    } catch (e) {
      try {
        const conn = connection || new Connection(RPC_URL, "confirmed");
        const balLamports = await conn.getBalance(publicKey);
        const sol = balLamports / 1e9;
        setSolBalanceState({ balance: sol, isError: false, isLoading: false, errorMessage: "" });
      } catch (err) {
        console.warn("SOL balance load error:", err.message);
        setSolBalanceState({
          balance: null,
          isError: true,
          isLoading: false,
          errorMessage: "⚠️ Unable to fetch Devnet SOL balance.",
        });
      }
    }
  }, [connection, publicKey]);

  const checkSolPreflight = useCallback(async () => {
    if (!connected || !publicKey) {
      throw new Error("Wallet not connected to Solana Devnet.");
    }

    if (solBalanceState.balance && solBalanceState.balance >= 0.002) {
      return solBalanceState.balance;
    }

    let solBal = null;
    try {
      const activeEndpoint = connection?.rpcEndpoint || RPC_URL;
      const balLamports = await fetchDevnetBalanceDirect(publicKey, activeEndpoint);
      solBal = balLamports / 1e9;
      setSolBalanceState({
        balance: solBal,
        isError: false,
        isLoading: false,
        errorMessage: "",
      });
    } catch (e) {
      try {
        const conn = connection || new Connection(RPC_URL, "confirmed");
        const balLamports = await conn.getBalance(publicKey);
        solBal = balLamports / 1e9;
      } catch (err) {
        console.warn("Pre-flight SOL check fetch failed, allowing transaction:", err.message);
        return solBalanceState.balance || null;
      }
    }

    if (solBal !== null && solBal < 0.002) {
      if (solBalanceState.balance && solBalanceState.balance >= 0.002) {
        return solBalanceState.balance;
      }
      throw new Error(
        `Wallet genuinely has ${solBal.toFixed(4)} SOL on Solana Devnet. Gas fees require at least 0.005 SOL. Please click "Request 1 Devnet SOL" below or use https://faucet.solana.com.`
      );
    }
    return solBal;
  }, [connected, publicKey, connection, solBalanceState.balance]);

  const handleRequestAirdrop = useCallback(async () => {
    if (!connected || !publicKey) return;
    setIsRequestingAirdrop(true);
    setupStatus.set(STATUS.LOADING, "Requesting Devnet SOL from local faucet...");

    try {
      const res = await fetch(`/api/airdrop-devnet-sol?address=${publicKey.toString()}`);
      const data = await res.json();
      if (data.success) {
        await loadDevnetSolBalance();
        setupStatus.set(
          STATUS.SUCCESS,
          `🎉 Received ${data.amount} Devnet SOL instantly! You can now execute transactions.`
        );
      } else {
        throw new Error(data.error || "Local faucet failed");
      }
    } catch (err) {
      console.warn("Local faucet fallback failed:", err.message);
      setupStatus.set(
        STATUS.ERROR,
        `Devnet RPC Faucet is rate-limited. Please copy your wallet address (${publicKey.toString()}) and open https://faucet.solana.com manually.`
      );
    }
    setIsRequestingAirdrop(false);
  }, [connected, publicKey, loadDevnetSolBalance, setupStatus]);

  const loadState = useCallback(async () => {
    try {
      const vs = await executeWithRpcFailover(connection, (conn) => fetchVaultState(conn));
      if (vs) {
        setVaultState(vs);
        setVaultInitialized(true);
        setSgdxMint(vs.sgdx_mint);
        setCollateralMint(vs.collateral_mint);
        localStorage.setItem(LS_SGDX_MINT, vs.sgdx_mint.toString());
        localStorage.setItem(LS_COLLATERAL_MINT, vs.collateral_mint.toString());
      }
    } catch (e) {
      console.warn("Vault load state error:", e.message);
    }
  }, [connection]);

  const loadBalances = useCallback(async () => {
    if (!publicKey) return;
    await loadDevnetSolBalance();
    if (!collateralMint || !sgdxMint) return;
    try {
      const colATA = getAssociatedTokenAddressSync(collateralMint, publicKey, false, TOKEN_PROGRAM_ID);
      const colInfo = await executeWithRpcFailover(connection, (conn) => conn.getTokenAccountBalance(colATA)).catch(() => null);
      setCollateralBalance(colInfo?.value?.uiAmountString ?? "0");

      const sgdxATA = getAssociatedTokenAddressSync(sgdxMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
      const sgdxInfo = await executeWithRpcFailover(connection, (conn) => conn.getTokenAccountBalance(sgdxATA)).catch(() => null);
      setSgdxBalance(sgdxInfo?.value?.uiAmountString ?? "0");

      const [vaultAuthority] = getVaultAuthorityPDA();
      const vaultColATA = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true, TOKEN_PROGRAM_ID);
      const vaultColInfo = await executeWithRpcFailover(connection, (conn) => conn.getTokenAccountBalance(vaultColATA)).catch(() => null);
      setVaultCollateralBalance(vaultColInfo?.value?.uiAmountString ?? "0");
    } catch (e) {
      console.warn("Balance load error:", e.message);
    }
  }, [connection, publicKey, collateralMint, sgdxMint, loadDevnetSolBalance]);

  useEffect(() => { loadState(); }, [loadState]);
  useEffect(() => { loadBalances(); }, [loadBalances]);

  const onChainPriceRatio = vaultState
    ? (Number(vaultState.price_numerator) / Number(vaultState.price_denominator)).toFixed(4)
    : null;

  const priceDisplay = onChainPriceRatio
    ? `1 devUSDT = ${onChainPriceRatio} SGDX`
    : "Loading...";

  const depositPreview = (() => {
    if (!vaultState || !depositAmount || isNaN(depositAmount)) return null;
    const baseUnits = parseTokenAmount(depositAmount);
    const out = calcSgdxOut(baseUnits, vaultState.price_numerator, vaultState.price_denominator);
    return formatTokenAmount(out);
  })();

  const redeemPreview = (() => {
    if (!vaultState || !redeemAmount || isNaN(redeemAmount)) return null;
    const baseUnits = parseTokenAmount(redeemAmount);
    const out = calcCollateralOut(baseUnits, vaultState.price_numerator, vaultState.price_denominator);
    return formatTokenAmount(out);
  })();

  const sendAndConfirm = useCallback(
    async (txInput, extraSigners = []) => {
      if (!publicKey) throw new Error("Wallet not connected");

      const { blockhash, lastValidBlockHeight } = await executeWithRpcFailover(
        connection,
        (conn) => conn.getLatestBlockhash("confirmed")
      );

      let tx;
      if (typeof txInput === "function") {
        tx = await txInput(blockhash);
      } else {
        tx = txInput;
      }

      const instructions = tx.instructions || (Array.isArray(tx) ? tx : [tx]);
      const messageV0 = new TransactionMessage({
        payerKey: publicKey,
        recentBlockhash: blockhash,
        instructions: instructions,
      }).compileToV0Message();

      const versionedTx = new VersionedTransaction(messageV0);

      if (extraSigners.length > 0) {
        versionedTx.sign(extraSigners);
      }

      let sig;
      let rawTx;

      if (signTransaction) {
        const signed = await signTransaction(versionedTx);
        rawTx = signed.serialize();
        sig = await executeWithRpcFailover(connection, (conn) =>
          conn.sendRawTransaction(rawTx, {
            skipPreflight: true,
            preflightCommitment: "confirmed",
          })
        );
      } else {
        sig = await sendTransaction(versionedTx, connection, {
          skipPreflight: true,
          preflightCommitment: "confirmed",
        });
        try {
          rawTx = versionedTx.serialize();
        } catch {
          rawTx = null;
        }
      }

      setLastTxSig(sig);

      let retransmitInterval = null;
      if (rawTx) {
        retransmitInterval = setInterval(() => {
          executeWithRpcFailover(connection, (conn) =>
            conn.sendRawTransaction(rawTx, {
              skipPreflight: true,
              preflightCommitment: "confirmed",
            })
          ).catch(() => {});
        }, 2000);
      }

      const confirmationStrategy = {
        signature: sig,
        blockhash,
        lastValidBlockHeight,
      };

      let confirmed = false;
      let confirmError = null;

      const confirmPromise = executeWithRpcFailover(connection, (conn) =>
        conn.confirmTransaction(confirmationStrategy, "confirmed")
      )
        .then((res) => {
          if (res?.value?.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(res.value.err)}`);
          }
          return true;
        })
        .catch((err) => {
          confirmError = err;
          return false;
        });

      const startTime = Date.now();
      const maxLoopMs = 70000;

      while (!confirmed && Date.now() - startTime < maxLoopMs) {
        try {
          const statusRes = await executeWithRpcFailover(connection, (conn) =>
            conn.getSignatureStatus(sig, { searchTransactionHistory: true })
          );

          const status = statusRes?.value;
          if (status) {
            if (status.err) {
              throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
            }
            if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
              confirmed = true;
              break;
            }
          }
        } catch (e) {
          if (e.message?.includes("Transaction failed on-chain")) {
            if (retransmitInterval) clearInterval(retransmitInterval);
            throw e;
          }
        }

        try {
          const currentBlockHeight = await executeWithRpcFailover(connection, (conn) =>
            conn.getBlockHeight("confirmed")
          );
          if (currentBlockHeight > lastValidBlockHeight) {
            console.warn(`Blockhash expired on-chain (block ${currentBlockHeight} > lastValid ${lastValidBlockHeight})`);
            break;
          }
        } catch (e) {
          console.warn("Blockheight check warning:", e.message);
        }

        const fastRes = await Promise.race([
          confirmPromise,
          new Promise((r) => setTimeout(() => r(null), 1200)),
        ]);
        if (fastRes === true) {
          confirmed = true;
          break;
        }
      }

      if (retransmitInterval) clearInterval(retransmitInterval);

      if (!confirmed) {
        try {
          const finalStatusRes = await executeWithRpcFailover(connection, (conn) =>
            conn.getSignatureStatus(sig, { searchTransactionHistory: true })
          );
          const finalStatus = finalStatusRes?.value;
          if (finalStatus) {
            if (finalStatus.err) {
              throw new Error(`Transaction failed on-chain: ${JSON.stringify(finalStatus.err)}`);
            }
            if (finalStatus.confirmationStatus === "confirmed" || finalStatus.confirmationStatus === "finalized") {
              confirmed = true;
            }
          }
        } catch (e) {
          if (e.message?.includes("Transaction failed on-chain")) {
            throw e;
          }
        }
      }

      if (confirmed) {
        await loadDevnetSolBalance();
        return sig;
      }

      if (confirmError && confirmError.message?.includes("Transaction failed on-chain")) {
        throw confirmError;
      }

      throw new Error(
        `Transaction submitted (${sig.slice(0, 8)}...) but confirmation timed out client-side. Check Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`
      );
    },
    [connection, sendTransaction, signTransaction, publicKey, loadDevnetSolBalance]
  );

  const handleCreateSgdxMint = useCallback(async () => {
    if (!connected || !publicKey) return;
    setupStatus.set(STATUS.LOADING, "Checking devnet SOL balance & creating SGDX mint...");
    try {
      await checkSolPreflight();
      const mintKeypair = Keypair.generate();
      const sig = await sendAndConfirm(
        () => buildCreateSgdxMintTransaction(connection, publicKey, mintKeypair),
        [mintKeypair]
      );
      setSgdxMint(mintKeypair.publicKey);
      localStorage.setItem(LS_SGDX_MINT, mintKeypair.publicKey.toString());
      setLastTxSig(sig);
      setupStatus.set(STATUS.SUCCESS, `SGDX mint created: ${mintKeypair.publicKey.toString()}`);
    } catch (e) {
      setupStatus.set(STATUS.ERROR, `SGDX mint failed: ${e.message}`);
    }
  }, [connected, publicKey, connection, sendAndConfirm, setupStatus, checkSolPreflight]);

  const handleCreateCollateralMint = useCallback(async () => {
    if (!connected || !publicKey) return;
    setupStatus.set(STATUS.LOADING, "Checking devnet SOL balance & creating devUSDT mint...");
    try {
      await checkSolPreflight();
      const mintKeypair = Keypair.generate();
      const sig = await sendAndConfirm(
        () => buildCreateDevUsdtMintTransaction(connection, publicKey, mintKeypair),
        [mintKeypair]
      );
      setCollateralMint(mintKeypair.publicKey);
      localStorage.setItem(LS_COLLATERAL_MINT, mintKeypair.publicKey.toString());
      setLastTxSig(sig);
      setupStatus.set(STATUS.SUCCESS, `devUSDT mint created: ${mintKeypair.publicKey.toString()}`);
    } catch (e) {
      setupStatus.set(STATUS.ERROR, `devUSDT mint failed: ${e.message}`);
    }
  }, [connected, publicKey, connection, sendAndConfirm, setupStatus, checkSolPreflight]);

  const handleInitializeVault = useCallback(async () => {
    if (!connected || !publicKey || !sgdxMint || !collateralMint) {
      setupStatus.set(STATUS.ERROR, "Create both mints first.");
      return;
    }
    setupStatus.set(STATUS.LOADING, "Initializing vault on-chain...");
    try {
      await checkSolPreflight();
      const sig = await sendAndConfirm(
        () => buildInitializeVaultTransaction(
          connection, publicKey, collateralMint, sgdxMint,
          135n,
          100n
        )
      );
      setLastTxSig(sig);
      setupStatus.set(STATUS.SUCCESS, "Vault initialized! Price: 1 devUSDT = 1.35 SGDX");
      await loadState();
    } catch (e) {
      setupStatus.set(STATUS.ERROR, `Initialize failed: ${e.message}`);
    }
  }, [connected, publicKey, connection, sgdxMint, collateralMint, sendAndConfirm, loadState, setupStatus, checkSolPreflight]);

  const handlePushPythPrice = useCallback(async () => {
    if (!connected || !publicKey || !vaultInitialized) {
      pythStatus.set(STATUS.ERROR, "Connect wallet and initialize vault first.");
      return;
    }
    pythStatus.set(STATUS.LOADING, "Fetching live USD/SGD price from Pyth Hermes API...");
    try {
      await checkSolPreflight();
      const oracleData = await fetchPythUsdSgdPrice(60);
      setPythOracleInfo(oracleData);

      const { priceNumerator, priceDenominator } = convertPriceToNumeratorDenominator(oracleData.price);

      pythStatus.set(
        STATUS.LOADING,
        `Pushing live Pyth rate (${oracleData.price.toFixed(4)} USD/SGD) on-chain...`
      );

      const sig = await sendAndConfirm(
        () => buildUpdateMockPriceTransaction(connection, publicKey, priceNumerator, priceDenominator)
      );

      setLastTxSig(sig);
      pythStatus.set(
        STATUS.SUCCESS,
        `🎉 Live Pyth price (${oracleData.price.toFixed(4)} USD/SGD) successfully pushed on-chain!`
      );
      await loadState();
    } catch (e) {
      pythStatus.set(STATUS.ERROR, `Pyth Price Push failed: ${e.message}`);
    }
  }, [connected, publicKey, vaultInitialized, connection, sendAndConfirm, loadState, pythStatus, checkSolPreflight]);

  const refreshPythOracleDisplay = useCallback(async () => {
    try {
      const data = await fetchPythUsdSgdPrice(120);
      setPythOracleInfo(data);
    } catch (e) {
      console.warn("Pyth oracle initial fetch warning:", e.message);
    }
  }, []);

  useEffect(() => {
    refreshPythOracleDisplay();
  }, [refreshPythOracleDisplay]);

  const handleFaucet = useCallback(async () => {
    if (!connected || !publicKey) {
      faucetStatus.set(STATUS.ERROR, "Connect wallet first.");
      return;
    }
    faucetStatus.set(STATUS.LOADING, `Minting ${faucetAmount} devUSDT via devnet faucet...`);
    try {
      const res = await fetch(`/api/mint-devusdt?address=${publicKey.toString()}&amount=${faucetAmount}`);
      const data = await res.json();
      if (data.success) {
        setLastTxSig(data.txHash);
        faucetStatus.set(STATUS.SUCCESS, `🎉 Minted ${faucetAmount} devUSDT to your wallet!`);
        await loadBalances();
        return;
      }
      throw new Error(data.error || "Faucet mint failed");
    } catch (e) {
      console.warn("Server faucet mint error, attempting client transaction fallback:", e.message);
      try {
        const baseUnits = Math.floor(parseFloat(faucetAmount) * 1e6);
        const sig = await sendAndConfirm(
          () => buildFaucetTransaction(connection, publicKey, collateralMint, baseUnits)
        );
        setLastTxSig(sig);
        faucetStatus.set(STATUS.SUCCESS, `🎉 Minted ${faucetAmount} devUSDT to your wallet!`);
        await loadBalances();
      } catch (clientErr) {
        faucetStatus.set(STATUS.ERROR, `Faucet failed: ${clientErr.message}`);
      }
    }
  }, [connected, publicKey, faucetAmount, connection, collateralMint, sendAndConfirm, loadBalances, faucetStatus]);

  const handleDeposit = useCallback(async () => {
    if (!connected || !publicKey || !vaultInitialized) {
      depositStatus.set(STATUS.ERROR, "Connect wallet and initialize vault first.");
      return;
    }
    if (!depositAmount || parseFloat(depositAmount) <= 0) {
      depositStatus.set(STATUS.ERROR, "Enter a valid deposit amount.");
      return;
    }
    if (parseFloat(depositAmount) > parseFloat(collateralBalance || "0")) {
      depositStatus.set(STATUS.ERROR, `⚠️ Insufficient devUSDT balance! You have ${collateralBalance} devUSDT. Click 'devUSDT Faucet' above to get more.`);
      return;
    }
    depositStatus.set(STATUS.LOADING, `Depositing ${depositAmount} devUSDT...`);
    try {
      await checkSolPreflight();
      const baseUnits = parseTokenAmount(depositAmount);
      const sig = await sendAndConfirm(
        () => buildDepositTransaction(connection, publicKey, collateralMint, sgdxMint, baseUnits)
      );
      setLastTxSig(sig);
      depositStatus.set(STATUS.SUCCESS, `🎉 Deposited ${depositAmount} devUSDT! You received ~${depositPreview} SGDX.`);
      setDepositAmount("");
      await loadBalances();
    } catch (e) {
      depositStatus.set(STATUS.ERROR, `Deposit failed: ${e.message}`);
    }
  }, [connected, publicKey, vaultInitialized, depositAmount, collateralBalance, connection, collateralMint, sgdxMint, sendAndConfirm, loadBalances, depositPreview, depositStatus, checkSolPreflight]);

  const handleRedeem = useCallback(async () => {
    if (!connected || !publicKey || !vaultInitialized) {
      redeemStatus.set(STATUS.ERROR, "Connect wallet and initialize vault first.");
      return;
    }
    if (!redeemAmount || parseFloat(redeemAmount) <= 0) {
      redeemStatus.set(STATUS.ERROR, "Enter a valid SGDX amount to redeem.");
      return;
    }
    if (parseFloat(sgdxBalance || "0") <= 0 || parseFloat(redeemAmount) > parseFloat(sgdxBalance || "0")) {
      redeemStatus.set(
        STATUS.ERROR,
        `⚠️ Cannot redeem! Your SGDX balance is ${sgdxBalance} SGDX. Please click the '💰 Deposit' tab first and deposit devUSDT to receive SGDX before redeeming!`
      );
      return;
    }
    redeemStatus.set(STATUS.LOADING, `Redeeming ${redeemAmount} SGDX...`);
    try {
      await checkSolPreflight();
      const baseUnits = parseTokenAmount(redeemAmount);
      const sig = await sendAndConfirm(
        () => buildRedeemTransaction(connection, publicKey, collateralMint, sgdxMint, baseUnits)
      );
      setLastTxSig(sig);
      redeemStatus.set(STATUS.SUCCESS, `🎉 Redeemed ${redeemAmount} SGDX! Received ~${redeemPreview} devUSDT.`);
      setRedeemAmount("");
      await loadBalances();
    } catch (e) {
      redeemStatus.set(STATUS.ERROR, `Redeem failed: ${e.message}`);
    }
  }, [connected, publicKey, vaultInitialized, redeemAmount, sgdxBalance, connection, collateralMint, sgdxMint, sendAndConfirm, loadBalances, redeemPreview, redeemStatus, checkSolPreflight]);

  if (!connected) {
    return (
      <div className="vault-connect-prompt">
        <div className="vault-connect-icon">🔐</div>
        <h2>Connect your wallet</h2>
        <p>Connect a Solana devnet wallet to use the SGDX Vault</p>
      </div>
    );
  }

  return (
    <VaultErrorBoundary>
      <div className="sgdx-vault-container">

        {/* ── Header ── */}
        <div className="vault-header">
          <div className="vault-title-row">
            <div className="vault-logo">
              <span className="vault-logo-text">SGDX</span>
              <span className="vault-logo-badge">DEVNET</span>
            </div>
            <div
              className="vault-oracle-chip"
              style={{
                background: pythOracleInfo ? "rgba(16, 185, 129, 0.12)" : undefined,
                borderColor: pythOracleInfo ? "rgba(16, 185, 129, 0.3)" : undefined,
              }}
            >
              <span
                className="oracle-dot"
                style={{ background: pythOracleInfo ? "#10b981" : "#f59e0b" }}
              />
              <span
                className="oracle-label"
                style={{ color: pythOracleInfo ? "#34d399" : "#fbbf24" }}
              >
                {pythOracleInfo ? "Live Pyth Oracle (Admin-Updated)" : "Mock Oracle"}
              </span>
              <span className="oracle-price">{priceDisplay}</span>
            </div>
          </div>
          <p className="vault-subtitle">
            Mint SGDX stablecoin by depositing devUSDT collateral · Transfer fee: {SGDX_TRANSFER_FEE_BASIS_POINTS} bps (0.0{SGDX_TRANSFER_FEE_BASIS_POINTS}%) ·{" "}
            <span style={{ color: pythOracleInfo ? "#34d399" : "#00d4aa", fontWeight: 600 }}>
              {pythOracleInfo ? `🟢 Live Pyth USD/SGD Rate (Phase 1.5)` : `🟢 Solana Devnet RPC`}
            </span>
          </p>
        </div>

        {/* ── Low SOL Warning Banner ── */}
        {solBalanceState.balance !== null && solBalanceState.balance < 0.002 && (
          <div className="vault-warning-banner">
            <div className="warning-content">
              <span className="warning-icon">⚠️</span>
              <div>
                <strong>Devnet SOL Required (0.0000 SOL on Devnet)</strong>
                <p>
                  Phantom is currently in <strong>Testnet Mode</strong>. Please switch Phantom to <strong>Devnet Mode</strong> in Phantom Settings, or click below for Devnet SOL.
                </p>
              </div>
            </div>
            <button className="btn-airdrop" onClick={handleRequestAirdrop} disabled={isRequestingAirdrop}>
              {isRequestingAirdrop ? "Requesting..." : "🚰 Request 1 Devnet SOL"}
            </button>
          </div>
        )}

        {/* ── RPC Warning Banner ── */}
        {solBalanceState.isError && (
          <div className="vault-warning-banner" style={{ background: "rgba(124, 58, 237, 0.1)", borderColor: "rgba(124, 58, 237, 0.35)" }}>
            <div className="warning-content">
              <span className="warning-icon">🌐</span>
              <div>
                <strong style={{ color: "#a78bfa" }}>Public Devnet RPC Rate-Limited</strong>
                <p>
                  {solBalanceState.errorMessage || "Primary Devnet RPC is rate-limited. Transactions automatically failover across RPC endpoints."}
                </p>
              </div>
            </div>
            <button
              className="btn-airdrop"
              style={{ background: "rgba(124, 58, 237, 0.25)", color: "#a78bfa", border: "1px solid rgba(124, 58, 237, 0.5)" }}
              onClick={loadDevnetSolBalance}
              disabled={solBalanceState.isLoading}
            >
              {solBalanceState.isLoading ? "Retrying..." : "🔄 Retry Balance"}
            </button>
          </div>
        )}

        {/* ── Stats Row ── */}
        <div className="vault-stats-row">
          <div className="vault-stat-card">
            <div className="stat-label">Devnet SOL</div>
            <div className={`stat-value ${solBalanceState.isError ? "status-pending" : solBalanceState.balance !== null && solBalanceState.balance < 0.002 ? "status-pending" : "status-ok"}`}>
              {solBalanceState.isLoading ? (
                <span style={{ fontSize: "0.82rem", color: "#a78bfa" }}>⌛ Retrying...</span>
              ) : solBalanceState.isError ? (
                <span style={{ fontSize: "0.8rem", color: "#f59e0b", cursor: "pointer" }} onClick={loadDevnetSolBalance} title="Click to retry balance fetch">
                  ⚠️ RPC Error 🔄
                </span>
              ) : solBalanceState.balance !== null ? (
                `${solBalanceState.balance.toFixed(4)} SOL`
              ) : (
                "0.0000 SOL"
              )}
            </div>
          </div>
          <div className="vault-stat-card">
            <div className="stat-label">Your devUSDT</div>
            <div className="stat-value">{collateralBalance}</div>
          </div>
          <div className="vault-stat-card">
            <div className="stat-label">Your SGDX</div>
            <div className="stat-value">{sgdxBalance}</div>
          </div>
          <div className="vault-stat-card">
            <div className="stat-label">Vault TVL (devUSDT)</div>
            <div className="stat-value">{vaultCollateralBalance}</div>
          </div>
          <div className="vault-stat-card">
            <div className="stat-label">Vault Status</div>
            <div className={`stat-value ${vaultInitialized ? "status-ok" : "status-pending"}`}>
              {vaultInitialized ? "✅ Live" : "⚠️ Not initialized"}
            </div>
          </div>
        </div>

        {/* ── Tab Nav ── */}
        <div className="vault-tabs">
          {["deposit", "redeem", "setup"].map(tab => (
            <button
              key={tab}
              className={`vault-tab ${activeTab === tab ? "active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "deposit" && "💰 Deposit"}
              {tab === "redeem" && "🔄 Redeem"}
              {tab === "setup" && "⚙️ Setup"}
            </button>
          ))}
        </div>

        {/* ── Deposit Tab ── */}
        {activeTab === "deposit" && (
          <div className="vault-panel">
            <h3 className="panel-title">Deposit devUSDT → Receive SGDX</h3>

            {/* Faucet */}
            <div className="vault-faucet-row">
              <span className="faucet-label">🚰 devUSDT Faucet</span>
              <input
                type="number"
                className="vault-input faucet-input"
                value={faucetAmount}
                onChange={e => setFaucetAmount(e.target.value)}
                placeholder="Amount"
                min="1"
                max="100000"
              />
              <button
                className="vault-btn faucet-btn"
                onClick={handleFaucet}
                disabled={faucetStatus.status === STATUS.LOADING || !collateralMint}
              >
                {faucetStatus.status === STATUS.LOADING ? "Minting..." : "Mint devUSDT"}
              </button>
            </div>
            <StatusMessage state={faucetStatus} />

            <div className="vault-divider" />

            {/* Deposit form */}
            <label className="vault-label">Amount to deposit (devUSDT)</label>
            <div className="vault-input-row">
              <input
                type="number"
                className="vault-input"
                value={depositAmount}
                onChange={e => setDepositAmount(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.000001"
              />
              <button
                className="vault-max-btn"
                onClick={() => setDepositAmount(collateralBalance)}
              >MAX</button>
            </div>

            {depositPreview && (
              <div className="vault-preview">
                <span>You will receive:</span>
                <span className="preview-value">{depositPreview} SGDX</span>
              </div>
            )}

            <button
              className="vault-action-btn deposit"
              onClick={handleDeposit}
              disabled={depositStatus.status === STATUS.LOADING || !vaultInitialized || !depositAmount}
            >
              {depositStatus.status === STATUS.LOADING ? (
                <><span className="btn-spinner" /> Depositing...</>
              ) : "Deposit & Mint SGDX"}
            </button>
            <StatusMessage state={depositStatus} sig={lastTxSig} />
          </div>
        )}

        {/* ── Redeem Tab ── */}
        {activeTab === "redeem" && (
          <div className="vault-panel">
            <h3 className="panel-title">Redeem SGDX → Receive devUSDT</h3>

            <label className="vault-label">SGDX amount to redeem</label>
            <div className="vault-input-row">
              <input
                type="number"
                className="vault-input"
                value={redeemAmount}
                onChange={e => setRedeemAmount(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.000001"
              />
              <button
                className="vault-max-btn"
                onClick={() => setRedeemAmount(sgdxBalance)}
              >MAX</button>
            </div>

            {redeemPreview && (
              <div className="vault-preview">
                <span>You will receive:</span>
                <span className="preview-value">{redeemPreview} devUSDT</span>
              </div>
            )}

            <div className="vault-warning">
              ⚠️ SGDX will be permanently burned. This action is irreversible.
            </div>

            <button
              className="vault-action-btn redeem"
              onClick={handleRedeem}
              disabled={redeemStatus.status === STATUS.LOADING || !vaultInitialized || !redeemAmount}
            >
              {redeemStatus.status === STATUS.LOADING ? (
                <><span className="btn-spinner" /> Redeeming...</>
              ) : "Burn SGDX & Redeem"}
            </button>
            <StatusMessage state={redeemStatus} sig={lastTxSig} />
          </div>
        )}

        {/* ── Setup Tab ── */}
        {activeTab === "setup" && (
          <div className="vault-panel">
            <h3 className="panel-title">⚙️ Vault Setup (Admin)</h3>
            <p className="setup-note">
              Run these steps once in order to initialize the vault on devnet.
            </p>

            <div className="setup-steps">
              {/* Step 1 */}
              <SetupStep
                number={1}
                title="Create devUSDT Collateral Mint"
                description="Classic SPL Token (6 decimals). Your wallet = mint authority for faucet."
                done={!!collateralMint}
                value={collateralMint?.toString()}
                label="devUSDT Mint"
              >
                <button
                  className="vault-btn setup-btn"
                  onClick={handleCreateCollateralMint}
                  disabled={setupStatus.status === STATUS.LOADING || !!collateralMint}
                >
                  {collateralMint ? "✅ Created" : "Create devUSDT Mint"}
                </button>
              </SetupStep>

              {/* Step 2 */}
              <SetupStep
                number={2}
                title="Create SGDX Mint (Token-2022)"
                description={`Token-2022 with TransferFeeConfig. ${SGDX_TRANSFER_FEE_BASIS_POINTS} bps transfer fee (0.0${SGDX_TRANSFER_FEE_BASIS_POINTS}%). Mint authority = Vault Authority PDA.`}
                done={!!sgdxMint}
                value={sgdxMint?.toString()}
                label="SGDX Mint"
              >
                <button
                  className="vault-btn setup-btn"
                  onClick={handleCreateSgdxMint}
                  disabled={setupStatus.status === STATUS.LOADING || !!sgdxMint}
                >
                  {sgdxMint ? "✅ Created" : "Create SGDX Mint"}
                </button>
              </SetupStep>

              {/* Step 3 */}
              <SetupStep
                number={3}
                title="Initialize Vault On-Chain"
                description="Creates vault_state PDA and vault collateral account. Sets initial oracle price 1.35 USD/SGD."
                done={vaultInitialized}
                value={vaultInitialized ? getVaultStatePDA()[0].toString() : null}
                label="Vault State PDA"
              >
                <button
                  className="vault-btn setup-btn"
                  onClick={handleInitializeVault}
                  disabled={setupStatus.status === STATUS.LOADING || vaultInitialized || !sgdxMint || !collateralMint}
                >
                  {vaultInitialized ? "✅ Initialized" : "Initialize Vault"}
                </button>
              </SetupStep>

              {/* Step 4: Live Pyth Oracle Push */}
              <SetupStep
                number={4}
                title="Update On-Chain Price from Pyth Oracle (Phase 1.5)"
                description="Fetches live USD/SGD feed from Pyth Hermes API with 60s staleness verification and updates vault_state on-chain."
                done={!!pythOracleInfo}
                value={pythOracleInfo ? `1 USD = ${pythOracleInfo.price.toFixed(4)} SGD` : null}
                label="Pyth Feed Status"
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%" }}>
                  {pythOracleInfo && (
                    <div style={{ fontSize: "0.82rem", color: "#a78bfa", background: "rgba(124, 58, 237, 0.1)", padding: "8px 12px", borderRadius: "6px", border: "1px solid rgba(124, 58, 237, 0.25)" }}>
                      <div><strong>Pyth Feed ID:</strong> <code style={{ color: "#e9d5ff", fontSize: "0.76rem" }}>{PYTH_USD_SGD_FEED_ID.slice(0, 18)}...</code></div>
                      <div><strong>Rate:</strong> 1 USD = {pythOracleInfo.price.toFixed(4)} SGD (Age: {pythOracleInfo.ageSec}s)</div>
                      <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "2px" }}>ℹ️ Phase 1.5 mode: Live price fetched off-chain and updated on-chain by admin.</div>
                    </div>
                  )}

                  <button
                    className="vault-btn setup-btn"
                    onClick={handlePushPythPrice}
                    disabled={pythStatus.status === STATUS.LOADING || !vaultInitialized}
                    style={{ background: "linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)", color: "#fff", fontWeight: 600 }}
                  >
                    {pythStatus.status === STATUS.LOADING ? "Pushing Live Price..." : "⚡ Fetch & Push Live Pyth Price On-Chain"}
                  </button>
                  <StatusMessage state={pythStatus} sig={lastTxSig} />
                </div>
              </SetupStep>
            </div>

            <StatusMessage state={setupStatus} sig={lastTxSig} />

            {vaultInitialized && vaultState && (
              <div className="vault-state-display">
                <h4>Live Vault State</h4>
                <div className="vault-state-grid">
                  <div><span>Price</span><span>{(Number(vaultState.price_numerator) / Number(vaultState.price_denominator)).toFixed(4)} USD/SGD</span></div>
                  <div><span>Total Deposited</span><span>{formatTokenAmount(vaultState.total_collateral_deposited)} devUSDT</span></div>
                  <div><span>Total SGDX Minted</span><span>{formatTokenAmount(vaultState.total_sgdx_minted)} SGDX</span></div>
                  <div><span>Authority</span><span className="mono">{vaultState.authority.toString().slice(0,8)}...</span></div>
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </VaultErrorBoundary>
  );
}
