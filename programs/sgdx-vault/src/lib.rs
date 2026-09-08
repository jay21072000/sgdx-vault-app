use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("2vaoPv3xyoY7r8GWtcTNZxG7Q2a2j3JhC2qeu71JSmqq");

#[program]
pub mod sgdx_vault {
    use super::*;

    /// Initialize the vault: registers collateral mint, SGDX mint, sets initial oracle price.
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

    /// Admin-only: update the price feed.
    /// Hardened admin-controlled price feed with a 5% deviation limit per update
    /// and a minimum 30-second interval between updates to prevent rapid price manipulation.
    pub fn update_mock_price(
        ctx: Context<UpdateMockPrice>,
        price_numerator: u64,
        price_denominator: u64,
    ) -> Result<()> {
        instructions::update_price::handler(ctx, price_numerator, price_denominator)
    }

    /// Step 1 of two-step authority transfer: current admin proposes a new pending authority.
    pub fn propose_authority(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::authority_transfer::propose_authority_handler(ctx, new_authority)
    }

    /// Step 2 of two-step authority transfer: proposed pending authority accepts the admin role.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::authority_transfer::accept_authority_handler(ctx)
    }
}
