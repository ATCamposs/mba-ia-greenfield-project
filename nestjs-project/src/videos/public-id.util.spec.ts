import { generatePublicId, isPublicId } from './public-id.util';

describe('public id', () => {
  it('should generate 11-character URL-safe identifiers', () => {
    for (let i = 0; i < 100; i++) {
      const id = generatePublicId();
      expect(id).toHaveLength(11);
      expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should not collide across 10,000 generated identifiers', () => {
    const ids = new Set(Array.from({ length: 10000 }, generatePublicId));

    expect(ids.size).toBe(10000);
  });

  it('should accept generated ids and reject malformed values', () => {
    expect(isPublicId(generatePublicId())).toBe(true);
    expect(isPublicId('short')).toBe(false);
    expect(isPublicId('twelve-chars')).toBe(false);
    expect(isPublicId('has space!!')).toBe(false);
    expect(isPublicId('../etc/pass')).toBe(false);
  });
});
