import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// Minimal DER writer for this fixed, test-only certificate shape. No external
// openssl executable is needed on Windows, and no private key is stored on disk.
function der(tag: number, ...parts: Buffer[]): Buffer {
    const value = Buffer.concat(parts);
    const length = value.length < 128 ? Buffer.from([value.length]) : (() => {
        const bytes: number[] = [];
        for (let size = value.length; size > 0; size >>>= 8) { bytes.unshift(size & 255); }
        return Buffer.from([0x80 | bytes.length, ...bytes]);
    })();
    return Buffer.concat([Buffer.from([tag]), length, value]);
}
const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'));
const utc = (date: Date): Buffer => der(0x17, Buffer.from(date.toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));

/** A fresh one-day localhost identity for TLS verification tests, never production use. */
export function createLocalhostTlsFixture(): { key: string | Buffer; cert: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const algorithm = sequence(oid('2a8648ce3d040302')); // ecdsa-with-SHA256
    const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('localhost')))));
    const serial = randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x40;
    const validity = sequence(utc(new Date(Date.now() - 60000)), utc(new Date(Date.now() + 86400000)));
    const extensions = der(0xa3, sequence(
        sequence(oid('551d13'), der(0x01, Buffer.from([0xff])), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
        sequence(oid('551d11'), der(0x04, sequence(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1]))))),
    ));
    const certificateBody = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name,
        validity, name, publicKey.export({ type: 'spki', format: 'der' }), extensions);
    const certificate = sequence(certificateBody, algorithm, der(0x03, Buffer.from([0]), sign('sha256', certificateBody, privateKey)));
    const base64 = certificate.toString('base64').match(/.{1,64}/g)!.join('\n');
    return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n` };
}
