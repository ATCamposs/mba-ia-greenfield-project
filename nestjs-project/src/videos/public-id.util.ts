import { randomBytes } from 'crypto';

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// 8 random bytes in base64url are exactly 11 URL-safe characters.
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}

export function isPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}
