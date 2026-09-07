use anchor_lang::prelude::*;

use crate::{errors::VaultError, state::VaultState};

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
    vault_state.price_numerator = price_numerator;
    vault_state.price_denominator = price_denominator;
    vault_state.last_price_update_timestamp = Clock::get()?.unix_timestamp;

    msg!(
        "Mock price updated: {}/{} (= {} USD per SGD × 1000)",
        price_numerator,
        price_denominator,
        (price_numerator * 1000) / price_denominator,
    );

    Ok(())
}
