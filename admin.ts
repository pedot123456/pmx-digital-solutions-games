/** Admin PIN policy: 6–12 digits, not one repeated digit, not a straight run (123456 / 987654). */
export function pinPolicyError(pin: string): string | null {
  if (!/^\d{6,12}$/.test(pin)) return 'Use 6 to 12 digits.'
  if (/^(\d)\1+$/.test(pin)) return 'Do not use one repeated digit.'
  const digits = pin.split('').map(Number)
  const step = digits[1] - digits[0]
  if ((step === 1 || step === -1) && digits.every((d, i) => i === 0 || d - digits[i - 1] === step)) return 'Do not use a straight run of digits.'
  return null
}

export interface LoginResponse {
  token: string
  must_change_pin: boolean
  expires_at: string
}
