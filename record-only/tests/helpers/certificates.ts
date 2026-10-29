import forge from "node-forge";
import { X509Certificate } from "node:crypto";
export function certificate(ip = "127.0.0.1", expired = false) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000 * 2);
  cert.validity.notAfter = new Date(
    Date.now() + (expired ? -86400000 : 86400000 * 30),
  );
  const attrs = [{ name: "commonName", value: "cyez integration only" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 7, ip }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  return {
    cert: pem,
    key: forge.pki.privateKeyToPem(keys.privateKey),
    pin: new X509Certificate(pem).fingerprint256
      .replaceAll(":", "")
      .toLowerCase(),
  };
}
