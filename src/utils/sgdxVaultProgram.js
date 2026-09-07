/**
 * sgdxVaultProgram.js
 * ──────────────────────────────────────────────────────────────────────────
 * Client-side helpers to interact with the deployed sgdx-vault Anchor program.
 * Uses Anchor IDL-compatible instruction builders manually for lightweight frontend execution.
 */

import {
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  getMintLen,
  ExtensionType,
  createMintToInstruction,
} from "@solana/spl-token";
import * as borsh from "@coral-xyz/borsh";
import { RPC_URL } from "../config";

// ── Program ID ────────────────────────────────────────────────────────────
export const SGDX_VAULT_PROGRAM_ID = new PublicKey(
  "2vaoPv3xyoY7r8GWtcTNZxG7Q2a2j3JhC2qeu71JSmqq"
);

// ── Transfer Fee Config (2 bps = 0.02%) ────────────────────────────────────
export const SGDX_TRANSFER_FEE_BASIS_POINTS = 2;
export const SGDX_MAX_FEE = BigInt(1_000_000); // 1 SGDX max fee cap (6 decimals)
export const SGDX_DECIMALS = 6;
export const COLLATERAL_DECIMALS = 6;

// ── PDAs ───────────────────────────────────────────────────────────────────
export function getVaultStatePDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_state")],
    SGDX_VAULT_PROGRAM_ID
  );
}

export function getVaultAuthorityPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority")],
    SGDX_VAULT_PROGRAM_ID
  );
}

const DISC = {
  initialize_vault:   [48,  191, 163, 44,  71,  129, 63,  164],
  deposit_collateral: [156, 131, 142, 116, 146, 247, 162, 120],
  redeem_sgdx:        [122, 190, 114, 189, 83,  225, 207, 252],
  update_mock_price:  [240, 168, 200, 127, 41,  159, 199, 93 ],
};

export const DISCRIMINATORS = {
  initializeVault:   Buffer.from(DISC.initialize_vault),
  depositCollateral: Buffer.from(DISC.deposit_collateral),
  redeemSgdx:        Buffer.from(DISC.redeem_sgdx),
  updateMockPrice:   Buffer.from(DISC.update_mock_price),
};

// ── Borsh layouts ──────────────────────────────────────────────────────────
const VaultStateLayout = borsh.struct([
  borsh.publicKey("authority"),
  borsh.publicKey("collateral_mint"),
  borsh.publicKey("sgdx_mint"),
  borsh.u8("vault_authority_bump"),
  borsh.u8("vault_state_bump"),
  borsh.u64("price_numerator"),
  borsh.u64("price_denominator"),
  borsh.u64("total_collateral_deposited"),
  borsh.u64("total_sgdx_minted"),
]);

/**
 * Fetch and decode VaultState from chain.
 */
export async function fetchVaultState(connection) {
  const [vaultStatePDA] = getVaultStatePDA();
  const rpcUrl = connection?.rpcEndpoint || RPC_URL;

  if (rpcUrl) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [vaultStatePDA.toString(), { encoding: "base64" }],
        }),
      });
      const json = await res.json();
      if (json && json.result && json.result.value && json.result.value.data) {
        const rawBuffer = Buffer.from(json.result.value.data[0], "base64");
        const data = rawBuffer.slice(8);
        return VaultStateLayout.decode(data);
      }
    } catch (err) {
      console.warn("Direct fetchVaultState via rpcEndpoint error:", err.message);
    }
  }

  try {
    const accountInfo = await connection.getAccountInfo(vaultStatePDA);
    if (!accountInfo) return null;
    const data = accountInfo.data.slice(8);
    return VaultStateLayout.decode(data);
  } catch (e) {
    console.warn("connection.getAccountInfo error:", e.message);
    return null;
  }
}

// ── Step 1: Create Token-2022 SGDX Mint ────────────────────────────────────
export async function buildCreateSgdxMintTransaction(
  connection,
  payerPubkey,
  mintKeypair
) {
  const [vaultAuthority] = getVaultAuthorityPDA();
  const extensions = [ExtensionType.TransferFeeConfig];
  const mintLen = getMintLen(extensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payerPubkey;

  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payerPubkey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      mintKeypair.publicKey,
      payerPubkey,
      payerPubkey,
      SGDX_TRANSFER_FEE_BASIS_POINTS,
      SGDX_MAX_FEE,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      SGDX_DECIMALS,
      vaultAuthority,
      null,
      TOKEN_2022_PROGRAM_ID
    )
  );

  return tx;
}

// ── Step 2: Create devUSDT (classic SPL) ───────────────────────────────────
export async function buildCreateDevUsdtMintTransaction(
  connection,
  payerPubkey,
  mintKeypair
) {
  const lamports = await connection.getMinimumBalanceForRentExemption(82);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payerPubkey;

  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payerPubkey,
      newAccountPubkey: mintKeypair.publicKey,
      space: 82,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      COLLATERAL_DECIMALS,
      payerPubkey,
      null,
      TOKEN_PROGRAM_ID
    )
  );

  return tx;
}

// ── Step 3: Mint devUSDT to user (faucet) ─────────────────────────────────
export async function buildFaucetTransaction(
  connection,
  payerPubkey,
  collateralMint,
  amount
) {
  const userATA = getAssociatedTokenAddressSync(
    collateralMint,
    payerPubkey,
    false,
    TOKEN_PROGRAM_ID
  );
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payerPubkey;

  const ataInfo = await connection.getAccountInfo(userATA);
  if (!ataInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        payerPubkey,
        userATA,
        payerPubkey,
        collateralMint,
        TOKEN_PROGRAM_ID
      )
    );
  }

  tx.add(
    createMintToInstruction(collateralMint, userATA, payerPubkey, BigInt(amount), [], TOKEN_PROGRAM_ID)
  );

  return tx;
}

// ── Step 4: Initialize Vault on-chain ──────────────────────────────────────
export async function buildInitializeVaultTransaction(
  connection,
  payerPubkey,
  collateralMint,
  sgdxMint,
  priceNumerator = 135n,
  priceDenominator = 100n
) {
  const [vaultStatePDA] = getVaultStatePDA();
  const [vaultAuthority] = getVaultAuthorityPDA();

  const vaultCollateralATA = getAssociatedTokenAddressSync(
    collateralMint,
    vaultAuthority,
    true,
    TOKEN_PROGRAM_ID
  );

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payerPubkey;

  const data = Buffer.alloc(8 + 8 + 8);
  DISCRIMINATORS.initializeVault.copy(data, 0);
  data.writeBigUInt64LE(priceNumerator, 8);
  data.writeBigUInt64LE(priceDenominator, 16);

  const keys = [
    { pubkey: payerPubkey, isSigner: true, isWritable: true },
    { pubkey: vaultStatePDA, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: collateralMint, isSigner: false, isWritable: false },
    { pubkey: sgdxMint, isSigner: false, isWritable: false },
    { pubkey: vaultCollateralATA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  tx.add({ keys, programId: SGDX_VAULT_PROGRAM_ID, data });
  return tx;
}

// ── Step 5: Deposit Collateral ─────────────────────────────────────────────
export async function buildDepositTransaction(
  connection,
  userPubkey,
  collateralMint,
  sgdxMint,
  amountBaseUnits
) {
  const [vaultStatePDA] = getVaultStatePDA();
  const [vaultAuthority] = getVaultAuthorityPDA();

  const userCollateralATA = getAssociatedTokenAddressSync(collateralMint, userPubkey, false, TOKEN_PROGRAM_ID);
  const vaultCollateralATA = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true, TOKEN_PROGRAM_ID);
  const userSgdxATA = getAssociatedTokenAddressSync(sgdxMint, userPubkey, false, TOKEN_2022_PROGRAM_ID);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = userPubkey;

  const sgdxAtaInfo = await connection.getAccountInfo(userSgdxATA).catch(() => null);
  if (!sgdxAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        userPubkey,
        userSgdxATA,
        userPubkey,
        sgdxMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.depositCollateral.copy(data, 0);
  data.writeBigUInt64LE(BigInt(amountBaseUnits), 8);

  const keys = [
    { pubkey: userPubkey, isSigner: true, isWritable: true },
    { pubkey: vaultStatePDA, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: sgdxMint, isSigner: false, isWritable: true },
    { pubkey: collateralMint, isSigner: false, isWritable: false },
    { pubkey: userCollateralATA, isSigner: false, isWritable: true },
    { pubkey: vaultCollateralATA, isSigner: false, isWritable: true },
    { pubkey: userSgdxATA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  tx.add({ keys, programId: SGDX_VAULT_PROGRAM_ID, data });
  return tx;
}

// ── Step 6: Redeem SGDX ────────────────────────────────────────────────────
export async function buildRedeemTransaction(
  connection,
  userPubkey,
  collateralMint,
  sgdxMint,
  sgdxAmountBaseUnits
) {
  const [vaultStatePDA] = getVaultStatePDA();
  const [vaultAuthority] = getVaultAuthorityPDA();

  const userSgdxATA = getAssociatedTokenAddressSync(sgdxMint, userPubkey, false, TOKEN_2022_PROGRAM_ID);
  const vaultCollateralATA = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true, TOKEN_PROGRAM_ID);
  const userCollateralATA = getAssociatedTokenAddressSync(collateralMint, userPubkey, false, TOKEN_PROGRAM_ID);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = userPubkey;

  const colAtaInfo = await connection.getAccountInfo(userCollateralATA).catch(() => null);
  if (!colAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        userPubkey,
        userCollateralATA,
        userPubkey,
        collateralMint,
        TOKEN_PROGRAM_ID
      )
    );
  }

  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.redeemSgdx.copy(data, 0);
  data.writeBigUInt64LE(BigInt(sgdxAmountBaseUnits), 8);

  const keys = [
    { pubkey: userPubkey, isSigner: true, isWritable: true },
    { pubkey: vaultStatePDA, isSigner: false, isWritable: true },
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: sgdxMint, isSigner: false, isWritable: true },
    { pubkey: collateralMint, isSigner: false, isWritable: false },
    { pubkey: userSgdxATA, isSigner: false, isWritable: true },
    { pubkey: vaultCollateralATA, isSigner: false, isWritable: true },
    { pubkey: userCollateralATA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  tx.add({ keys, programId: SGDX_VAULT_PROGRAM_ID, data });
  return tx;
}

// ── Step 7: Update Oracle Price On-Chain (Admin) ──────────────────────────
export async function buildUpdateMockPriceTransaction(
  connection,
  authorityPubkey,
  priceNumerator,
  priceDenominator
) {
  const [vaultStatePDA] = getVaultStatePDA();

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = authorityPubkey;

  const data = Buffer.alloc(8 + 8 + 8);
  DISCRIMINATORS.updateMockPrice.copy(data, 0);
  data.writeBigUInt64LE(BigInt(priceNumerator), 8);
  data.writeBigUInt64LE(BigInt(priceDenominator), 16);

  const keys = [
    { pubkey: authorityPubkey, isSigner: true, isWritable: true },
    { pubkey: vaultStatePDA, isSigner: false, isWritable: true },
  ];

  tx.add({ keys, programId: SGDX_VAULT_PROGRAM_ID, data });
  return tx;
}

// ── Price helpers ──────────────────────────────────────────────────────────
export function calcSgdxOut(collateralAmount, priceNumerator, priceDenominator) {
  return (BigInt(collateralAmount) * BigInt(priceNumerator)) / BigInt(priceDenominator);
}

export function calcCollateralOut(sgdxAmount, priceNumerator, priceDenominator) {
  return (BigInt(sgdxAmount) * BigInt(priceDenominator)) / BigInt(priceNumerator);
}

export function formatTokenAmount(baseUnits, decimals = 6) {
  const divisor = 10 ** decimals;
  return (Number(baseUnits) / divisor).toFixed(4);
}

export function parseTokenAmount(displayAmount, decimals = 6) {
  return Math.floor(parseFloat(displayAmount) * 10 ** decimals);
}
