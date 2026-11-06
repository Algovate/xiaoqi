import crypto from "node:crypto";

const AAD = Buffer.from("xiaoqi:secret:v1", "utf8");

export function encryptSecret(plaintext: string, key: Buffer, kid = "v1"): string {
  if (key.length !== 32) throw new Error("MASTER_KEY must be 32 bytes");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", kid, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(stored: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("MASTER_KEY must be 32 bytes");
  const parts = stored.split(":");
  if (parts.length !== 5 || parts[0] !== "v1") throw new Error("unsupported secret format");
  const [, , ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64!, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64!, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
