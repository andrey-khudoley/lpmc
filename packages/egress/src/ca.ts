import { existsSync, readFileSync, writeFileSync } from "node:fs";
import forge from "node-forge";

/**
 * Собственный удостоверяющий центр прокси.
 *
 * Ключи RSA 2048, а не эллиптические: node-forge не умеет генерировать ключи EC,
 * а выпуск сертификатов ведётся именно им. RSA 2048 принимается всеми браузерами;
 * цена — более медленная генерация, поэтому листовая пара создаётся ОДИН раз
 * и переиспользуется для всех хостов: различаются только сертификаты.
 */
export class CertificateAuthority {
  private constructor(
    private readonly caCert: forge.pki.Certificate,
    private readonly caKey: forge.pki.rsa.PrivateKey,
    private readonly leafKeys: forge.pki.rsa.KeyPair,
    private readonly leafKeyPem: string,
  ) {}

  private readonly cache = new Map<string, { key: string; cert: string }>();

  static loadOrCreate(certPath: string, keyPath: string): CertificateAuthority {
    let caCert: forge.pki.Certificate;
    let caKey: forge.pki.rsa.PrivateKey;

    if (existsSync(certPath) && existsSync(keyPath)) {
      caCert = forge.pki.certificateFromPem(readFileSync(certPath, "utf8"));
      caKey = forge.pki.privateKeyFromPem(readFileSync(keyPath, "utf8"));
    } else {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = serial();
      cert.validity.notBefore = new Date(Date.now() - 3600_000);
      cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600_000);
      const attrs = [
        { name: "commonName", value: "LPMC egress proxy CA" },
        { name: "organizationName", value: "LPMC" },
      ];
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      cert.setExtensions([
        { name: "basicConstraints", cA: true, pathLenConstraint: 0 },
        { name: "keyUsage", keyCertSign: true, cRLSign: true },
      ]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      // Сертификат публичен (его ставят в доверенные), приватный ключ — 0600
      // и принадлежит пользователю прокси: ни исполнитель, ни браузер его не видят.
      writeFileSync(certPath, forge.pki.certificateToPem(cert), { mode: 0o644 });
      writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
      caCert = cert;
      caKey = keys.privateKey;
    }

    const leafKeys = forge.pki.rsa.generateKeyPair(2048);
    return new CertificateAuthority(
      caCert,
      caKey,
      leafKeys,
      forge.pki.privateKeyToPem(leafKeys.privateKey),
    );
  }

  /**
   * Выпускает листовой сертификат на имя хоста и кэширует его. Выпуск НЕ является
   * разрешением: разрешение проверяется политикой раньше, до терминирования TLS.
   */
  leaf(host: string): { key: string; cert: string } {
    const hit = this.cache.get(host);
    if (hit) return hit;

    const cert = forge.pki.createCertificate();
    cert.publicKey = this.leafKeys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 3600_000);
    cert.validity.notAfter = new Date(Date.now() + 30 * 24 * 3600_000);
    cert.setSubject([{ name: "commonName", value: host }]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: host }] },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());

    const out = { key: this.leafKeyPem, cert: forge.pki.certificateToPem(cert) };
    this.cache.set(host, out);
    return out;
  }
}

function serial(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}
