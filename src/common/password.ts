/**
 * Password policy shared by registration, password reset and profile password
 * changes (spec §4.1 / §17): at least 8 characters containing at least one
 * letter and one number. Kept in one place so every entry point agrees.
 */
export const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;

export const PASSWORD_RULE_MESSAGE =
  'password must be at least 8 characters long and contain at least one letter and one number';
