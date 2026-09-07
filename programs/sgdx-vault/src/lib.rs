use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("2vaoPv3xyoY7r8GWtcTNZxG7Q2a2j3JhC2qeu71JSmqq");

#[program]
pub mod sgdx_vault {
    use super::*;

    /// Initialize the vault: registers collateral mint, SGDX mint, sets mock oracle price.
    /// Must be called AFTER the Token-2022 SGDX mint has been created with
    /// vault_authority PDA as mint_authority.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        price_numerator: u64,   // e.g. 135 for 1.35 USD/SGD
        price_denominator: u64, // e.g. 100
    ) -> Result<()> {
        instructions::initialize::handler(ctx, price_numerator, price_denominator)
    }

    /// Deposit collateral (devUSDT) → receive SGDX proportional to oracle price.
    /// amount: collateral amount in smallest units (6 decimals for devUSDT)
    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    /// Burn SGDX → receive proportional collateral back.
    /// amount: SGDX amount to burn in smallest units (6 decimals)
    pub fn redeem_sgdx(ctx: Context<RedeemSgdx>, amount: u64) -> Result<()> {
        instructions::redeem::handler(ctx, amount)
    }

    /// Admin-only: update the mock oracle price.
    /// Real Pyth integration replaces this in Phase 1.5.
    pub fn update_mock_price(
        ctx: Context<UpdateMockPrice>,
        price_numerator: u64,
        price_denominator: u64,
    ) -> Result<()> {
        instructions::update_price::handler(ctx, price_numerator, price_denominator)
    }
}
