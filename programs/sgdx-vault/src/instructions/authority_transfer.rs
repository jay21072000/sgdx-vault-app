use anchor_lang::prelude::*;

use crate::{errors::VaultError, state::VaultState};

#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    /// Current admin authority
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.vault_state_bump,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault_state: Account<'info, VaultState>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    /// Proposed pending authority accepting the admin role
    pub pending_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.vault_state_bump,
        constraint = vault_state.pending_authority == pending_authority.key() @ VaultError::UnauthorizedPendingAuthority,
    )]
    pub vault_state: Account<'info, VaultState>,
}

/// Step 1 of two-step authority transfer: current admin proposes a new pending authority.
pub fn propose_authority_handler(
    ctx: Context<ProposeAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidNewAuthority
    );

    let vault_state = &mut ctx.accounts.vault_state;
    vault_state.pending_authority = new_authority;

    msg!(
        "Authority transfer proposed. Pending authority set to: {}",
        new_authority
    );

    Ok(())
}

/// Step 2 of two-step authority transfer: proposed pending authority accepts the admin role.
pub fn accept_authority_handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let vault_state = &mut ctx.accounts.vault_state;
    let old_authority = vault_state.authority;
    let new_authority = vault_state.pending_authority;

    vault_state.authority = new_authority;
    vault_state.pending_authority = Pubkey::default();

    msg!(
        "Authority transfer complete! Vault admin changed from {} to {}",
        old_authority,
        new_authority
    );

    Ok(())
}
