use anchor_lang::prelude::*;

use crate::{errors::VaultError, state::VaultState};

pub const MAX_PRICE_DEVIATION_BPS: u128 = 500; // 5% max allowed price deviation per update
pub const BPS_DENOMINATOR: u128 = 10_000;
pub const MIN_PRICE_UPDATE_INTERVAL_SECONDS: i64 = 30; // Minimum 30 seconds between updates

#[derive(Accounts)]
pub struct UpdateMockPrice<'info> {
    /// Must be the vault admin (vault_state.authority)
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.vault_state_bump,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault_state: Account<'info, VaultState>,
}

pub fn handler(
    ctx: Context<UpdateMockPrice>,
    price_numerator: u64,
    price_denominator: u64,
) -> Result<()> {
    require!(price_denominator > 0, VaultError::ZeroDenominator);
    require!(price_numerator > 0, VaultError::ZeroNumerator);

    let vault_state = &mut ctx.accounts.vault_state;
    let now = Clock::get()?.unix_timestamp;

    // 1. Minimum time-between-updates check (skip on initial setup when last_price_update_timestamp == 0)
    if vault_state.last_price_update_timestamp > 0 {
        let elapsed = now.saturating_sub(vault_state.last_price_update_timestamp);
        require!(
            elapsed >= MIN_PRICE_UPDATE_INTERVAL_SECONDS,
            VaultError::PriceUpdateTooFrequent
        );
    }

    // 2. On-chain deviation cap check (skip if current price numerator is 0 or uninitialized)
    if vault_state.price_numerator > 0 && vault_state.price_denominator > 0 {
        let old_n = vault_state.price_numerator as u128;
        let old_d = vault_state.price_denominator as u128;
        let new_n = price_numerator as u128;
        let new_d = price_denominator as u128;

        let lhs = new_n
            .checked_mul(old_d)
            .ok_or(VaultError::ArithmeticOverflow)?;
        let rhs = old_n
            .checked_mul(new_d)
            .ok_or(VaultError::ArithmeticOverflow)?;

        let diff = if lhs >= rhs { lhs - rhs } else { rhs - lhs };
        let max_diff = rhs
            .checked_mul(MAX_PRICE_DEVIATION_BPS)
            .ok_or(VaultError::ArithmeticOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(VaultError::ArithmeticOverflow)?;

        require!(diff <= max_diff, VaultError::PriceDeviationTooLarge);
    }

    vault_state.price_numerator = price_numerator;
    vault_state.price_denominator = price_denominator;
    vault_state.last_price_update_timestamp = now;

    msg!(
        "Hardened price updated: {}/{} (= {} USD per SGD × 1000, timestamp: {})",
        price_numerator,
        price_denominator,
        (price_numerator * 1000) / price_denominator,
        now,
    );

    Ok(())
}
