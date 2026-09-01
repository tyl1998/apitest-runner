import { ApiError, type PlatformClient } from "./client.js";
import { SecretMasker } from "./masker.js";

/**
 * 日志流（8.2 接口 4）：行缓冲 → 脱敏 → 按 byte_offset 推送。
 *
 * 三个不能省的设计：
 *
 * 1. **行是脱敏的原子单位**。secret 逐行替换挡不住跨 chunk 的情况——"tok" 结尾一个
 *    chunk、"en123" 开头下一个 chunk，独立脱敏两边都漏。按行缓冲后，secret（单行值）
 *    不可能被切断。
 * 2. **chunk 边界必须落在码点上**。`byte_offset` 的单位是字节，但 chunk 存的是 TEXT：
 *    在多字节字符中间切开，那一半既进不了 JSON 也进不了 Postgres 的 text 列。
 * 3. **重传不丢不重靠服务端**（边界 7）：`UNIQUE (run, byte_offset)` + ack 回的总长。
 *    这里只负责「没 ack 就重发同一段」。
 *
 * 409/403/404 一律读作「服务端不再收这个 job 的日志」（终态已落 / 租约被判 / 易主），
 * 静默放弃而不是无限重试——日志是尽力而为，终态才是事实。
 */

const MAX_CHUNK_BYTES = 256 * 1024;
const SEND_RETRY_MS = 1_000;
const CLOSE_DRAIN_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LogStreamer {
  private tail = "";
  private pending = "";
  private sentOffset: number;
  private pumping = false;
  private dead = false;

  constructor(
    private readonly client: PlatformClient,
    private readonly jobId: string,
    private readonly runnerId: string,
    private readonly masker: SecretMasker,
    opts: { initialOffset: number; onAck?: (offset: number) => void },
  ) {
    this.sentOffset = Math.max(0, opts.initialOffset);
    this.onAck = opts.onAck;
  }

  private onAck?: (offset: number) => void;

  /** 已被服务端确认的字节水位——heartbeat 的 `log_bytes` 用它（报「真的收到了多少」）。 */
  get ackedOffset(): number {
    return this.sentOffset;
  }

  /** 喂入原始输出（子进程 stdout/stderr 与 Runner 自己的操作行）。 */
  feed(text: string): void {
    if (this.dead || !text) return;
    this.tail += text;
    for (;;) {
      const index = this.tail.indexOf("\n");
      if (index < 0) break;
      const line = this.tail.slice(0, index);
      this.tail = this.tail.slice(index + 1);
      this.enqueue(this.masker.maskLine(line) + "\n");
    }
  }

  /** 收尾：把最后一段不完整的行也脱敏发出去，然后等在途请求排空（有上限）。 */
  async close(): Promise<void> {
    if (this.tail) {
      this.enqueue(this.masker.maskLine(this.tail));
      this.tail = "";
    }
    const deadline = Date.now() + CLOSE_DRAIN_TIMEOUT_MS;
    while (!this.dead && this.pending && Date.now() < deadline) {
      await sleep(100);
    }
    if (!this.dead && this.pending) {
      this.dead = true;
      this.pending = "";
    }
  }

  private enqueue(masked: string): void {
    this.pending += masked;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.dead) return;
    this.pumping = true;
    try {
      while (!this.dead && this.pending) {
        const chunk = this.peekChunk();
        if (!chunk) break;
        try {
          const result = await this.client.logs(this.jobId, this.runnerId, this.sentOffset, chunk.text);
          /* ack 的总长可能大于本地水位（崩溃重发撞幂等收）：以服务端为准。 */
          this.commitChunk(chunk.chars);
          if (result.next_offset > this.sentOffset) {
            this.sentOffset = result.next_offset;
            this.onAck?.(this.sentOffset);
          }
        } catch (error) {
          if (error instanceof ApiError && !error.transient) {
            this.dead = true;
            this.pending = "";
            break;
          }
          /* 网络/5xx：同一段原样重发——offset 没动，服务端要么没收到要么幂等收。 */
          await sleep(SEND_RETRY_MS);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 取最长的不超过 MAX_CHUNK_BYTES 的前缀（按码点推进，绝不在多字节字符中间切）。 */
  private peekChunk(): { text: string; chars: number } | null {
    if (!this.pending) return null;
    let bytes = 0;
    let chars = 0;
    for (const ch of this.pending) {
      const size = Buffer.byteLength(ch);
      if (bytes + size > MAX_CHUNK_BYTES) break;
      bytes += size;
      chars += ch.length;
    }
    return { text: this.pending.slice(0, chars), chars };
  }

  private commitChunk(chars: number): void {
    this.pending = this.pending.slice(chars);
  }
}
