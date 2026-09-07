import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { SgdxVault } from './components/SgdxVault';
import { RPC_URL } from './config';

import '@solana/wallet-adapter-react-ui/styles.css';

export function App() {
  const endpoint = useMemo(() => RPC_URL, []);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="standalone-app-root">
            {/* Top Standalone Header Navbar */}
            <header className="standalone-header">
              <div className="header-container">
                <div className="brand-logo">
                  <span className="flag">🇸🇬</span>
                  <div className="brand-text">
                    <span className="brand-title">SGDX Vault</span>
                    <span className="brand-subtitle">Solana Devnet Stablecoin Platform</span>
                  </div>
                </div>
                <div className="header-actions">
                  <div className="network-badge">🟢 Devnet</div>
                  <WalletMultiButton className="custom-wallet-btn" />
                </div>
              </div>
            </header>

            {/* Main Application Container */}
            <main className="standalone-main">
              <SgdxVault />
            </main>

            {/* Footer */}
            <footer className="standalone-footer">
              <div className="footer-container">
                <p>SGDX Vault Platform · Token-2022 Stablecoin Protocol · Pyth Live Oracle Feed</p>
              </div>
            </footer>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default App;
