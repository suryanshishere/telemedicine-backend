import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

@Injectable()
export class CryptoService {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor(config: ConfigService) {
    this.activeKeyId = config.getOrThrow<string>('ACTIVE_FIELD_KEY_ID');
    const configured = config.getOrThrow<string>('FIELD_ENCRYPTION_KEYS');

    for (const entry of configured.split(',')) {
      const separator = entry.indexOf(':');
      if (separator < 1) throw new Error('Invalid FIELD_ENCRYPTION_KEYS entry');
      const keyId = entry.slice(0, separator).trim();
      const key = Buffer.from(entry.slice(separator + 1).trim(), 'base64');
      if (key.length !== 32) throw new Error(`Encryption key ${keyId} must decode to 32 bytes`);
      this.keys.set(keyId, key);
    }

    if (!this.keys.has(this.activeKeyId)) {
      throw new Error('ACTIVE_FIELD_KEY_ID is not present in FIELD_ENCRYPTION_KEYS');
    }
  }

  encrypt(value: string): string {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new InternalServerErrorException('Active encryption key unavailable');

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      this.activeKeyId,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(envelope: string): string {
    const [version, keyId, ivEncoded, tagEncoded, valueEncoded] = envelope.split('.');
    if (version !== 'v1' || !keyId || !ivEncoded || !tagEncoded || !valueEncoded) {
      throw new InternalServerErrorException('Invalid encrypted value');
    }
    const key = this.keys.get(keyId);
    if (!key) throw new InternalServerErrorException('Encryption key unavailable');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivEncoded, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(valueEncoded, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
