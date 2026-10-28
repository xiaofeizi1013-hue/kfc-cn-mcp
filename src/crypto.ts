/**
 * KFC China H5 request signing + field encryption.
 *
 * The web client (order.kfc.com.cn/preorder-taro) signs every API call with a
 * "KBS" header triple (kbck / kbcts / kbsv) and DES-encrypts selected fields
 * listed in `encodeList` before sending them.
 *
 * Signing string (POST):
 *   client_key \t client_sec \t timestamp \t path \t\t <exact JSON body>
 * kbsv = md5(signing string), lowercase hex.
 *
 * The DES key is the per-brand `apiSecretKey` baked into the H5 bundle.
 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

/** client_key / client_sec for the kfc.WEB (H5) channel. */
export const KBS_CLIENT_KEY = 'kbwapzJAAUs1g2od';
export const KBS_CLIENT_SEC = 'fegFLVMJJ88If2hp';

/** apiSecretKey for brand "kfc", decoded from the bundle config. */
const DES_KEY = 'D963r1wp';
const KEY = Buffer.from(DES_KEY, 'utf8');
// Node/OpenSSL 3 disables single-DES. 3DES EDE with three identical subkeys is
// bit-for-bit identical to single DES, so this is safe and dependency-free.
const TRIPLE_KEY = Buffer.concat([KEY, KEY, KEY]);

export function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

export function desEncrypt(plain: string): string {
  const cipher = createCipheriv('des-ede3-cbc', TRIPLE_KEY, KEY);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

export function desDecrypt(cipherText: string): string {
  const decipher = createDecipheriv('des-ede3-cbc', TRIPLE_KEY, KEY);
  return Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Build the KBS headers for one request. */
export function kbsHeaders(
  path: string,
  body: string,
  timestamp = Date.now(),
): Record<string, string> {
  const signString = `${KBS_CLIENT_KEY}\t${KBS_CLIENT_SEC}\t${timestamp}\t${path}\t\t${body}`;
  return {
    kbck: KBS_CLIENT_KEY,
    kbcts: String(timestamp),
    kbsv: md5(signString),
  };
}
