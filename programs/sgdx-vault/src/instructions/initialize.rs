use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_interface::{Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount, TokenInterface},
};

use crate::{errors::VaultError, state::VaultState};

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// The admin who initializes and owns the vault config
    #[account(mut)]
    pub authority: Signer<'info>,

    /// VaultState PDA — initialized here
    #[account(
        init,
        payer = authority,
        space = VaultState::SIZE,
        seeds = [b"vault_state"],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Vault authority PDA — this becomes the SGDX mint_authority and
    /// the owner of vault_collateral_account. Has no private key.
    /// CHECK: safe — this is a PDA we derive; it holds no data and signs via invoke_signed.
    #[account(
        seeds = [b"vault_authority"],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// The collateral mint (devUSDT — classic SPL Token, 6 decimals)
    pub collateral_mint: Account<'info, anchor_spl::token::Mint>,

    /// The SGDX Token-2022 mint.
    /// SECURITY: We verify that its mint_authority == vault_authority PDA below.
    #[account(
        constraint = sgdx_mint.mint_authority == anchor_lang::solana_program::program_option::COption::Some(vault_authority.key())
            @ VaultError::InvalidMintAuthority,
    )]
    pub sgdx_mint: InterfaceAccount<'info, InterfaceMint>,

    /// Vault's collateral token account (ATA of vault_authority for collateral_mint)
    /// Created here so the vault can receive collateral.
    #[account(
        init,
        payer = authority,
        associated_token::mint = collateral_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_collateral_account: Account<'info, anchor_spl::token::TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    /// Token-2022 program needed to read SGDX mint
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeVault>,
    price_numerator: u64,
    price_denominator: u64,
) -> Result<()> {
    require!(price_denominator > 0, VaultError::ZeroDenominator);
    require!(price_numerator > 0, VaultError::ZeroNumerator);

    let vault_state = &mut ctx.accounts.vault_state;

    vault_state.authority = ctx.accounts.authority.key();
    vault_state.collateral_mint = ctx.accounts.collateral_mint.key();
    vault_state.sgdx_mint = ctx.accounts.sgdx_mint.key();
    vault_state.vault_authority_bump = ctx.bumps.vault_authority;
    vault_state.vault_state_bump = ctx.bumps.vault_state;
    vault_state.price_numerator = price_numerator;
    vault_state.price_denominator = price_denominator;
    vault_state.last_price_update_timestamp = Clock::get()?.unix_timestamp;
    vault_state.total_collateral_deposited = 0;
    vault_state.total_sgdx_minted = 0;
    vault_state._reserved = [0u8; 56];

    msg!(
        "SGDX Vault initialized. Collateral: {}, SGDX mint: {}, Price: {}/{}",
        ctx.accounts.collateral_mint.key(),
        ctx.accounts.sgdx_mint.key(),
        price_numerator,
        price_denominator,
    );

    Ok(())
}
