use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Token, Transfer},
    token_interface::{
        mint_to, Mint as InterfaceMint, MintTo, TokenAccount as InterfaceTokenAccount,
        TokenInterface,
    },
};

use crate::{errors::VaultError, state::VaultState};

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    /// The user depositing collateral
    #[account(mut)]
    pub user: Signer<'info>,

    /// Vault state — validates collateral mint + SGDX mint, holds price
    #[account(
        mut,
        seeds = [b"vault_state"],
        bump = vault_state.vault_state_bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Vault authority PDA — signs the SGDX mint CPI
    /// CHECK: safe — PDA with no private key; signs via invoke_signed
    #[account(
        seeds = [b"vault_authority"],
        bump = vault_state.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// SGDX Token-2022 mint — mint_authority must be vault_authority
    #[account(
        mut,
        constraint = sgdx_mint.key() == vault_state.sgdx_mint @ VaultError::MintMismatch,
        constraint = sgdx_mint.mint_authority == anchor_lang::solana_program::program_option::COption::Some(vault_authority.key())
            @ VaultError::InvalidMintAuthority,
    )]
    pub sgdx_mint: InterfaceAccount<'info, InterfaceMint>,

    /// Collateral mint (devUSDT)
    #[account(
        constraint = collateral_mint.key() == vault_state.collateral_mint @ VaultError::CollateralMintMismatch,
    )]
    pub collateral_mint: Account<'info, anchor_spl::token::Mint>,

    /// User's collateral token account (source of devUSDT)
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = user,
    )]
    pub user_collateral_account: Account<'info, anchor_spl::token::TokenAccount>,

    /// Vault's collateral token account (destination for devUSDT)
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_collateral_account: Account<'info, anchor_spl::token::TokenAccount>,

    /// User's SGDX token account (ATA for Token-2022 mint)
    /// Created here if it doesn't exist yet.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = sgdx_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_sgdx_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
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

    // ── Calculate SGDX to mint (overflow-safe u128 math) ──────────────────
    // price = price_numerator / price_denominator = USD_per_SGD (e.g. 1.35)
    // deposit 1 devUSDT → 1.35 SGDX
    // sgdx_out = amount × price_numerator / price_denominator
    let sgdx_amount = vault_state
        .calc_sgdx_for_collateral(amount)
        .ok_or(VaultError::ArithmeticOverflow)?;

    require!(sgdx_amount > 0, VaultError::SgdxAmountZero);

    // ── Step 1: Transfer collateral from user → vault ─────────────────────
    // Record vault balance BEFORE transfer so we can verify actual receipt
    let vault_balance_before = ctx.accounts.vault_collateral_account.amount;

    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_collateral_account.to_account_info(),
            to: ctx.accounts.vault_collateral_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    // Reload to get actual received amount (defensive — devUSDT has no fee,
    // but this pattern is correct for any SPL token)
    ctx.accounts.vault_collateral_account.reload()?;
    let vault_balance_after = ctx.accounts.vault_collateral_account.amount;
    let actual_received = vault_balance_after
        .checked_sub(vault_balance_before)
        .ok_or(VaultError::ArithmeticOverflow)?;

    // Recalculate SGDX based on ACTUAL received collateral (not sent amount)
    // This protects against any fee-on-transfer tokens
    let final_sgdx_amount = vault_state
        .calc_sgdx_for_collateral(actual_received)
        .ok_or(VaultError::ArithmeticOverflow)?;

    require!(final_sgdx_amount > 0, VaultError::SgdxAmountZero);

    // ── Step 2: Mint SGDX to user via CPI (vault_authority signs) ─────────
    let vault_authority_seeds: &[&[u8]] = &[
        b"vault_authority",
        &[vault_state.vault_authority_bump],
    ];
    let signer_seeds = &[vault_authority_seeds];

    let mint_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_2022_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.sgdx_mint.to_account_info(),
            to: ctx.accounts.user_sgdx_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer_seeds,
    );
    mint_to(mint_ctx, final_sgdx_amount)?;

    // ── Step 3: Update vault accounting ───────────────────────────────────
    let vault_state = &mut ctx.accounts.vault_state;
    vault_state.total_collateral_deposited = vault_state
        .total_collateral_deposited
        .checked_add(actual_received)
        .ok_or(VaultError::ArithmeticOverflow)?;
    vault_state.total_sgdx_minted = vault_state
        .total_sgdx_minted
        .checked_add(final_sgdx_amount)
        .ok_or(VaultError::ArithmeticOverflow)?;

    msg!(
        "Deposit: {} collateral received, {} SGDX minted",
        actual_received,
        final_sgdx_amount
    );

    Ok(())
}
