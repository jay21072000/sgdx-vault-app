import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createMintToInstruction } from '@solana/spl-token'

const DEFAULT_DEV_USDT = new PublicKey('B13ghd5HQkK5MB6obAj2hn8fuoQSFdCu1YjNz5Z9tYMb');
const RPC_DEVNET_URL = process.env.VITE_DEVNET_RPC_URL || 'https://devnet.helius-rpc.com/?api-key=ec93aeac-1895-4773-9d6d-e0f49512691e';

async function sendAndConfirmServerTx(conn, buildTxFn, signers, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retransmitTimer = null;
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const tx = await buildTxFn(blockhash);
      tx.recentBlockhash = blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.sign(...signers);

      const rawTx = tx.serialize();
      const sig = await conn.sendRawTransaction(rawTx, { skipPreflight: true, preflightCommitment: 'confirmed' });

      retransmitTimer = setInterval(() => {
        conn.sendRawTransaction(rawTx, { skipPreflight: true }).catch(() => {});
      }, 2000);

      let confirmed = false;
      const startTime = Date.now();

      while (!confirmed && Date.now() - startTime < 60000) {
        const statusRes = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
        const status = statusRes?.value;
        if (status) {
          if (status.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
            confirmed = true;
            break;
          }
        }

        const currentBlockHeight = await conn.getBlockHeight('confirmed').catch(() => 0);
        if (currentBlockHeight > lastValidBlockHeight) {
          console.warn(`Server tx attempt ${attempt}/${maxAttempts} blockhash expired at block ${currentBlockHeight}`);
          break;
        }

        await new Promise((r) => setTimeout(r, 1200));
      }

      if (retransmitTimer) clearInterval(retransmitTimer);

      if (!confirmed) {
        const finalStatus = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true }))?.value;
        if (finalStatus?.confirmationStatus === 'confirmed' || finalStatus?.confirmationStatus === 'finalized') {
          if (!finalStatus.err) return sig;
        }
      } else {
        return sig;
      }

      lastErr = new Error(`Server tx attempt ${attempt} blockhash expired`);
    } catch (e) {
      if (retransmitTimer) clearInterval(retransmitTimer);
      if (e.message?.includes('Transaction failed on-chain')) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('Server transaction failed after max retries');
}

function devnetFaucetPlugin() {
  return {
    name: 'devnet-faucet-plugin',
    configureServer(server) {
      server.middlewares.use('/api/airdrop-devnet-sol', async (req, res) => {
        try {
          const urlObj = new URL(req.url, 'http://localhost');
          const recipientStr = urlObj.searchParams.get('address');
          if (!recipientStr) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing address parameter' }));
            return;
          }

          const recipient = new PublicKey(recipientStr);
          const idJsonPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
          if (!fs.existsSync(idJsonPath)) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Local fund keypair not found' }));
            return;
          }

          const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(idJsonPath, 'utf-8')));
          const faucetKeypair = Keypair.fromSecretKey(secretKey);
          const conn = new Connection(RPC_DEVNET_URL, 'confirmed');

          const sig = await sendAndConfirmServerTx(
            conn,
            async () =>
              new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: faucetKeypair.publicKey,
                  toPubkey: recipient,
                  lamports: 500_000_000,
                })
              ),
            [faucetKeypair]
          );

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, txHash: sig, amount: 0.5 }));
        } catch (err) {
          console.error('Local faucet transfer error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      server.middlewares.use('/api/mint-devusdt', async (req, res) => {
        try {
          const urlObj = new URL(req.url, 'http://localhost');
          const recipientStr = urlObj.searchParams.get('address');
          const amountStr = urlObj.searchParams.get('amount') || '5';
          if (!recipientStr) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing address parameter' }));
            return;
          }

          const recipient = new PublicKey(recipientStr);
          const idJsonPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
          const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(idJsonPath, 'utf-8')));
          const adminKeypair = Keypair.fromSecretKey(secretKey);
          const conn = new Connection(RPC_DEVNET_URL, 'confirmed');
          const userATA = getAssociatedTokenAddressSync(DEFAULT_DEV_USDT, recipient, false, TOKEN_PROGRAM_ID);

          const sig = await sendAndConfirmServerTx(
            conn,
            async () => {
              const tx = new Transaction();
              const ataInfo = await conn.getAccountInfo(userATA);
              if (!ataInfo) {
                tx.add(
                  createAssociatedTokenAccountInstruction(
                    adminKeypair.publicKey,
                    userATA,
                    recipient,
                    DEFAULT_DEV_USDT,
                    TOKEN_PROGRAM_ID
                  )
                );
              }

              const amountBaseUnits = BigInt(Math.floor(parseFloat(amountStr) * 1e6));
              tx.add(
                createMintToInstruction(
                  DEFAULT_DEV_USDT,
                  userATA,
                  adminKeypair.publicKey,
                  amountBaseUnits,
                  [],
                  TOKEN_PROGRAM_ID
                )
              );
              return tx;
            },
            [adminKeypair]
          );

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, txHash: sig, amount: amountStr }));
        } catch (err) {
          console.error('Local devUSDT mint error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    devnetFaucetPlugin(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
  ],
  esbuild: {
    keepNames: true,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app-v3-[hash].js',
        chunkFileNames: 'assets/[name]-v3-[hash].js',
        assetFileNames: 'assets/[name]-v3-[hash].[ext]',
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (
              id.includes('@solana') ||
              id.includes('@noble') ||
              id.includes('@coral-xyz') ||
              id.includes('bs58') ||
              id.includes('buffer')
            ) {
              return 'solana-vendor';
            }
          }
        },
      },
    },
  },
})
