use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Token, Transfer},
    token_interface::{
        burn, Burn, Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount, TokenInterface,
    },
};

use crate::{errors::VaultError, state::VaultState};

#[derive(Accounts)]
pub struct RedeemSgdx<'info> {
    /// The user redeeming SGDX for collateral
    #[account(mut)]
    pub user: Signer<'info>,

    /// Vault state
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.vault_state_bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Vault authority PDA — signs the collateral transfer back to user
    /// CHECK: safe — PDA with no private key; signs via invoke_signed
    #[account(
        seeds = [b"vault_authority"],
        bump = vault_state.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// SGDX Token-2022 mint — we burn from here
    #[account(
        mut,
        constraint = sgdx_mint.key() == vault_state.sgdx_mint @ VaultError::MintMismatch,
    )]
    pub sgdx_mint: InterfaceAccount<'info, InterfaceMint>,

    /// Collateral mint (devUSDT)
    #[account(
        constraint = collateral_mint.key() == vault_state.collateral_mint @ VaultError::CollateralMintMismatch,
    )]
    pub collateral_mint: Account<'info, anchor_spl::token::Mint>,

    /// User's SGDX token account (source of SGDX to burn)
    #[account(
        mut,
        associated_token::mint = sgdx_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_sgdx_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Vault's collateral token account (source for collateral return)
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_collateral_account: Account<'info, anchor_spl::token::TokenAccount>,

    /// User's collateral token account (destination for returned devUSDT)
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = collateral_mint,
        associated_token::authority = user,
    )]
    pub user_collateral_account: Account<'info, anchor_spl::token::TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<RedeemSgdx>, amount: u64) -> Result<()> {
    // ── Safety checks ─────────────────────────────────────────────────────
    require!(amount > 0, VaultError::ZeroAmount);

    let vault_state = &ctx.accounts.vault_state;

    // ── Freshness check: reject if on-chain price is older than MAX_PRICE_AGE_SECONDS ──
    let clock = Clock::get()?;
    let age = clock.unix_timestamp.saturating_sub(vault_state.last_price_update_timestamp);
    require!(
        age <= crate::state::MAX_PRICE_AGE_SECONDS,
        VaultError::PriceStale
    );

    // ── Calculate collateral to return ────────────────────────────────────
    // collateral_out = sgdx_amount × price_denominator / price_numerator
    // (inverse of deposit formula — rounds down, protecting vault solvency)
    let collateral_amount = vault_state
        .calc_collateral_for_sgdx(amount)
        .ok_or(VaultError::ArithmeticOverflow)?;

    require!(collateral_amount > 0, VaultError::CollateralAmountZero);

    // Verify vault has enough collateral (prevents under-collateralization drain)
    require!(
        ctx.accounts.vault_collateral_account.amount >= collateral_amount,
        VaultError::InsufficientVaultCollateral
    );

    // ── Step 1: Burn SGDX from user (user must sign) ──────────────────────
    let burn_ctx = CpiContext::new(
        ctx.accounts.token_2022_program.to_account_info(),
        Burn {
            mint: ctx.accounts.sgdx_mint.to_account_info(),
            from: ctx.accounts.user_sgdx_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    );
    burn(burn_ctx, amount)?;

    // ── Step 2: Transfer collateral from vault → user ─────────────────────
    // vault_authority PDA signs via invoke_signed
    let vault_authority_seeds: &[&[u8]] = &[
        b"vault_authority",
        &[vault_state.vault_authority_bump],
    ];
    let signer_seeds = &[vault_authority_seeds];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_collateral_account.to_account_info(),
            to: ctx.accounts.user_collateral_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, collateral_amount)?;

    // ── Step 3: Update vault accounting ───────────────────────────────────
    let vault_state = &mut ctx.accounts.vault_state;
    vault_state.total_sgdx_minted = vault_state
        .total_sgdx_minted
        .checked_sub(amount)
        .ok_or(VaultError::ArithmeticOverflow)?;
    vault_state.total_collateral_deposited = vault_state
        .total_collateral_deposited
        .checked_sub(collateral_amount)
        .ok_or(VaultError::ArithmeticOverflow)?;

    msg!(
        "Redeem: {} SGDX burned, {} collateral returned",
        amount,
        collateral_amount
    );

    Ok(())
}
