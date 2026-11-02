import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey(): Buffer {
  const encoded = process.env.ENCRYPTION_KEY;
  if (!encoded) throw new Error('API key encryption is not configured.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('ENCRYPTION_KEY must be 32 random bytes encoded as base64.');
  return key;
}

/** The context must bind the ciphertext to `${userId}:${provider}`. */
export function encryptSecret(plaintext: string, context: string): string {
  if (plaintext.length < 8 || plaintext.length > 512 || /\s/.test(plaintext)) throw new Error('Invalid API key format.');
  if (!context || context.length > 256) throw new Error('Encryption context is required.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`taskllm:v1:${context}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptSecret(encrypted: string, context: string): string {
  if (!context || encrypted.length > 1024) throw new Error('Unable to decrypt API key.');
  const parts = encrypted.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unable to decrypt API key.');
  const [, ivString, tagString, ciphertext] = parts;
  try {
    const iv = Buffer.from(ivString, 'base64');
    const tag = Buffer.from(tagString, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope.');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAAD(Buffer.from(`taskllm:v1:${context}`, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new Error('Unable to decrypt API key. Check the encryption key and owner context.'); }
}
