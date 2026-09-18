import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../../src/common/services/crypto.service';

function config(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: jest.fn((name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`Missing ${name}`);
      return value;
    }),
  } as unknown as ConfigService;
}

const firstKey = Buffer.alloc(32, 0x11).toString('base64');
const secondKey = Buffer.alloc(32, 0x22).toString('base64');

describe('CryptoService', () => {
  it('round-trips UTF-8 data in a versioned AES-GCM envelope', () => {
    const service = new CryptoService(
      config({ ACTIVE_FIELD_KEY_ID: 'primary', FIELD_ENCRYPTION_KEYS: `primary:${firstKey}` }),
    );

    const encrypted = service.encrypt('नमस्ते telemedicine');

    expect(encrypted).toMatch(/^v1\.primary\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encrypted).not.toContain('telemedicine');
    expect(service.decrypt(encrypted)).toBe('नमस्ते telemedicine');
  });

  it('uses a fresh nonce so equal plaintexts do not produce equal ciphertexts', () => {
    const service = new CryptoService(
      config({ ACTIVE_FIELD_KEY_ID: 'primary', FIELD_ENCRYPTION_KEYS: `primary:${firstKey}` }),
    );

    expect(service.encrypt('same value')).not.toBe(service.encrypt('same value'));
  });

  it('decrypts data written with an older configured key after rotation', () => {
    const oldService = new CryptoService(
      config({ ACTIVE_FIELD_KEY_ID: 'old', FIELD_ENCRYPTION_KEYS: `old:${firstKey}` }),
    );
    const envelope = oldService.encrypt('clinical note');
    const rotatedService = new CryptoService(
      config({
        ACTIVE_FIELD_KEY_ID: 'new',
        FIELD_ENCRYPTION_KEYS: `old:${firstKey},new:${secondKey}`,
      }),
    );

    expect(rotatedService.decrypt(envelope)).toBe('clinical note');
    expect(rotatedService.encrypt('new value').split('.')[1]).toBe('new');
  });

  it('rejects malformed, unknown-key, and tampered envelopes', () => {
    const service = new CryptoService(
      config({ ACTIVE_FIELD_KEY_ID: 'primary', FIELD_ENCRYPTION_KEYS: `primary:${firstKey}` }),
    );
    const encrypted = service.encrypt('private');
    const parts = encrypted.split('.');
    const ciphertext = Buffer.from(parts[4], 'base64url');
    ciphertext[0] ^= 0xff;

    expect(() => service.decrypt('not-an-envelope')).toThrow(InternalServerErrorException);
    expect(() => service.decrypt(encrypted.replace('.primary.', '.retired.'))).toThrow(
      'Encryption key unavailable',
    );
    expect(() =>
      service.decrypt([...parts.slice(0, 4), ciphertext.toString('base64url')].join('.')),
    ).toThrow();
  });

  it.each([
    ['missing separator', 'primary'],
    ['wrong key length', `primary:${Buffer.alloc(16).toString('base64')}`],
  ])('rejects invalid key configuration: %s', (_label, configured) => {
    expect(
      () =>
        new CryptoService(
          config({ ACTIVE_FIELD_KEY_ID: 'primary', FIELD_ENCRYPTION_KEYS: configured }),
        ),
    ).toThrow();
  });

  it('requires the active key to be present in the key ring', () => {
    expect(
      () =>
        new CryptoService(
          config({ ACTIVE_FIELD_KEY_ID: 'missing', FIELD_ENCRYPTION_KEYS: `old:${firstKey}` }),
        ),
    ).toThrow('ACTIVE_FIELD_KEY_ID is not present');
  });
});
