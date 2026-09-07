use anchor_lang::prelude::*;

pub const MAX_PRICE_AGE_SECONDS: i64 = 300; // 5 minutes

/// On-chain state for the SGDX Vault.
/// Stored at PDA: seeds = [b"vault_state"]
#[account]
#[derive(Debug)]
pub struct VaultState {
    /// Admin who can update mock oracle price
    pub authority: Pubkey,
    /// The collateral token mint (devUSDT — classic SPL, 6 decimals)
    pub collateral_mint: Pubkey,
    /// The SGDX Token-2022 mint (6 decimals)
    pub sgdx_mint: Pubkey,
    /// Bump for vault_authority PDA (seeds = [b"vault_authority"])
    pub vault_authority_bump: u8,
    /// Bump for vault_state itself
    pub vault_state_bump: u8,
    /// Mock oracle: price_numerator / price_denominator = USD per SGD
    /// e.g. numerator=135, denominator=100 → 1 USD = 1.35 SGD
    pub price_numerator: u64,
    pub price_denominator: u64,
    /// Timestamp (unix_timestamp) of the last price update
    pub last_price_update_timestamp: i64,
    /// Total collateral deposited (in smallest units) — for accounting/monitoring
    pub total_collateral_deposited: u64,
    /// Total SGDX minted (in smallest units)
    pub total_sgdx_minted: u64,
    /// Reserved space for future fields without redeployment
    pub _reserved: [u8; 56],
}

impl VaultState {
    /// Discriminator (8) + all fields
    pub const SIZE: usize = 8
        + 32   // authority
        + 32   // collateral_mint
        + 32   // sgdx_mint
        + 1    // vault_authority_bump
        + 1    // vault_state_bump
        + 8    // price_numerator
        + 8    // price_denominator
        + 8    // last_price_update_timestamp
        + 8    // total_collateral_deposited
        + 8    // total_sgdx_minted
        + 56;  // _reserved

    /// Calculate SGDX to mint for a given collateral deposit.
    /// Uses u128 intermediate math to prevent overflow.
    /// price = numerator/denominator = USD_per_SGD
    /// e.g. 1 devUSDT (1 USD) × 1.35 = 1.35 SGDX
    ///
    /// Formula: sgdx_out = collateral_amount × price_numerator / price_denominator
    pub fn calc_sgdx_for_collateral(&self, collateral_amount: u64) -> Option<u64> {
        let result = (collateral_amount as u128)
            .checked_mul(self.price_numerator as u128)?
            .checked_div(self.price_denominator as u128)?;

        // Safe downcast — if result > u64::MAX the vault would be broken anyway
        if result > u64::MAX as u128 {
            return None;
        }
        Some(result as u64)
    }

    /// Calculate collateral to return when redeeming SGDX.
    /// Formula: collateral_out = sgdx_amount × price_denominator / price_numerator
    ///
    /// Note: this rounds DOWN (user gets slightly less), protecting the vault from
    /// fractional-unit drain attacks.
    pub fn calc_collateral_for_sgdx(&self, sgdx_amount: u64) -> Option<u64> {
        let result = (sgdx_amount as u128)
            .checked_mul(self.price_denominator as u128)?
            .checked_div(self.price_numerator as u128)?;

        if result > u64::MAX as u128 {
            return None;
        }
        Some(result as u64)
    }
}
