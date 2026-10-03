import crypto from "node:crypto";

/**
 * 决定类事件的人工签署：HMAC-SHA256 over 规范串。
 * 规范串把 event_id / 流 / 版本 / 发生时刻 / 载荷全部绑定，
 * 载荷采用键排序的紧凑 JSON，避免“同决定不同摘要”。
 */

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function signingPayload(event) {
  return [
    event.event_id,
    event.event_type,
    event.aggregate_type,
    event.aggregate_id,
    String(event.version),
    event.occurred_at,
    canonicalJson(event.payload ?? {}),
  ].join("|");
}

/**
 * @param {object} event 待签署事件（version/payload 已定稿）
 * @param {{signer_id: string, signer_role: string}} signer
 * @param {string} secret 签名方持有密钥
 * @param {string} [signedAt]
 */
export function signEvent(event, signer, secret, signedAt = event.occurred_at) {
  const value = crypto.createHmac("sha256", secret).update(signingPayload(event)).digest("hex");
  return {
    signer_id: signer.signer_id,
    signer_role: signer.signer_role,
    algorithm: "HS256",
    value,
    signed_at: signedAt,
  };
}

export function verifySignature(event, secret) {
  if (!event.signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(signingPayload(event)).digest("hex");
  const actual = event.signature.value;
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}
