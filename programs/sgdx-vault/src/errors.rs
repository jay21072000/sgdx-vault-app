use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Arithmetic overflow in price calculation")]
    ArithmeticOverflow,

    #[msg("Deposit amount must be greater than zero")]
    ZeroAmount,

    #[msg("Price denominator cannot be zero")]
    ZeroDenominator,

    #[msg("Calculated SGDX amount is zero — deposit too small")]
    SgdxAmountZero,

    #[msg("Calculated collateral amount is zero — SGDX amount too small")]
    CollateralAmountZero,

    #[msg("Insufficient collateral in vault for redemption")]
    InsufficientVaultCollateral,

    #[msg("SGDX mint authority must be the vault_authority PDA")]
    InvalidMintAuthority,

    #[msg("SGDX mint does not match vault state")]
    MintMismatch,

    #[msg("Collateral mint does not match vault state")]
    CollateralMintMismatch,

    #[msg("Only the vault authority admin can call this instruction")]
    Unauthorized,

    #[msg("Price numerator cannot be zero")]
    ZeroNumerator,
}
