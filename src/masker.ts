/**
 * secret 的日志脱敏（边界 12）。
 *
 * **在 Runner 侧做，不在平台侧做**：日志一旦按 offset 上报，原文已经在网络上了，
 * 平台侧再脱敏已经晚了——与 SDK 侧脱敏（P4 边界 14）是同一个道理。
 *
 * 能力边界必须写死在这里而不是藏在 README 里：**只做原文逐行替换**。base64、
 * URL-encode、逐字符 echo 等变形挡不住——承诺挡不住的东西，用户会按承诺去用。
 */

const MASK = "***";

/** 短于 4 个字符的值不参与脱敏：把 "abc" 全局替换掉的误伤远大于泄露风险。 */
const MIN_VALUE_LENGTH = 4;

export class SecretMasker {
  private readonly values: string[];

  constructor(values: Array<string | undefined | null>) {
    const cleaned = [...new Set(values.filter((each): each is string => typeof each === "string" && each.length >= MIN_VALUE_LENGTH))];
    /* 长的先替换：一个值恰好是另一个值的子串时，先短会把长的切成「半截明文 + 掩码」。 */
    this.values = cleaned.sort((a, b) => b.length - a.length);
  }

  /** 对一行做原文替换。换行符由调用方管理（masker 不感知行的边界约定）。 */
  maskLine(line: string): string {
    let out = line;
    for (const value of this.values) {
      if (out.includes(value)) out = out.split(value).join(MASK);
    }
    return out;
  }
}

/** https_token 的脱敏面就是 token 本身。 */
export function httpsCredentialMaskValues(credential: string | null): string[] {
  return credential ? [credential] : [];
}

/** ssh_key 的脱敏面是 PEM 的 body 行：整把 key 不会被单行打印，但每一行可能被。 */
export function sshKeyMaskValues(credential: string | null): string[] {
  if (!credential) return [];
  return credential
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_VALUE_LENGTH && !line.startsWith("-----"));
}
