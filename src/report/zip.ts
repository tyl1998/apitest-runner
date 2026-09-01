import { deflateRawSync } from "node:zlib";

/**
 * 极简 zip 写入器（P4.5-13，边界 19 的报告层）。
 *
 * Runner 是零运行时依赖的仓（report/xml.ts 的手写扫描器同一条纪律），为一个
 * 「把几十个 JSON 与截图打成一个包」的动作引 archiver / yauzl 不值。zip 的
 * central directory 格式是稳定的公开事实，这里实现刚好够用的子集：
 * - STORE（不压缩）或 DEFLATE（zlib deflateRaw，单文件逐个选）；
 * - 单文件、非加密、非 zip64——allure-results 的量级（几千个 JSON + 截图）远够；
 * - 文件名一律 UTF-8（bit 11 置位），mtime 取 0（产物的内容哈希才是身份，
 *   时间戳进包只会让同目录两次打包的 checksum 不同）。
 *
 * 只写不读：平台侧的读取在 apitest-server 的 lib/zip.ts（同款纪律的服务端副本）。
 */

const ZIP_VERSION_NEEDED = 20; // 2.0：deflate 与目录条目都支持
const ZIP_VERSION_MADE_BY = 20; // 0 (MS-DOS) + 2.0：不依赖 Unix 扩展字段

type Entry = {
  nameBytes: Buffer;
  crc32: number;
  method: number; // 0 = store, 8 = deflate
  compressed: Buffer;
  uncompressedSize: number;
};

/** CRC-32 (IEEE 802.3)。查表法：512 字节的表换逐位循环的 8 倍速，值一次算好。 */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 追加一个文件（name 用 `/` 分隔的相对路径，UTF-8）。 */
export class ZipWriter {
  private entries: Entry[] = [];

  addFile(name: string, content: Buffer, opts?: { deflate?: boolean }): void {
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length > 0xffff) throw new Error(`zip entry name too long: ${name.length} chars`);
    if (content.length > 0xffffffff) throw new Error(`zip entry too large: ${content.length} bytes`);
    const crc = crc32(content);
    /* 小文件 deflate 收益为负（开销大于压掉的部分，JSON 之外的截图本来就是已压缩
       格式）；阈值取 512 字节——之下直接 STORE。 */
    const wantDeflate = (opts?.deflate ?? true) && content.length >= 512;
    let method = 0;
    let compressed = content;
    if (wantDeflate) {
      const deflated = deflateRawSync(content, { level: 6 });
      if (deflated.length < content.length) {
        method = 8;
        compressed = deflated;
      }
    }
    this.entries.push({
      nameBytes, crc32: crc, method, compressed,
      uncompressedSize: content.length,
    });
  }

  /** 目录条目（名字以 `/` 结尾、零字节）：allure-results 打平进 zip 后不需要——
      平台侧按文件名前缀分组，目录条目反而是冗余；留着这个方法给将来需要树状结构的
      产物用。 */
  addDirectory(name: string): void {
    this.addFile(name.endsWith("/") ? name : `${name}/`, Buffer.alloc(0), { deflate: false });
  }

  /** 产出完整 zip 字节。 */
  build(): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;

    for (const entry of this.entries) {
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); // local file header signature
      local.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
      /* general purpose bit flag：bit 11 (0x0800) = UTF-8 文件名。 */
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(entry.method, 8);
      local.writeUInt16LE(0, 10); // mod time（mtime 固定 0：checksum 才是身份）
      local.writeUInt16LE(0, 12); // mod date
      local.writeUInt32LE(entry.crc32, 14);
      local.writeUInt32LE(entry.compressed.length, 18);
      local.writeUInt32LE(entry.uncompressedSize, 22);
      local.writeUInt16LE(entry.nameBytes.length, 26);
      local.writeUInt16LE(0, 28); // extra field length
      chunks.push(local, entry.nameBytes, entry.compressed);

      const centralEntry = Buffer.alloc(46);
      centralEntry.writeUInt32LE(0x02014b50, 0); // central directory header signature
      centralEntry.writeUInt16LE(ZIP_VERSION_MADE_BY, 4);
      centralEntry.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
      centralEntry.writeUInt16LE(0x0800, 8);
      centralEntry.writeUInt16LE(entry.method, 10);
      centralEntry.writeUInt16LE(0, 12); // mod time
      centralEntry.writeUInt16LE(0, 14); // mod date
      centralEntry.writeUInt32LE(entry.crc32, 16);
      centralEntry.writeUInt32LE(entry.compressed.length, 20);
      centralEntry.writeUInt32LE(entry.uncompressedSize, 24);
      centralEntry.writeUInt16LE(entry.nameBytes.length, 28);
      centralEntry.writeUInt16LE(0, 30); // extra
      centralEntry.writeUInt16LE(0, 32); // comment
      centralEntry.writeUInt16LE(0, 34); // disk number start
      centralEntry.writeUInt16LE(0, 36); // internal attributes
      centralEntry.writeUInt32LE(0, 38); // external attributes
      centralEntry.writeUInt32LE(offset, 42); // relative offset of local header
      central.push(centralEntry, entry.nameBytes);

      offset += 30 + entry.nameBytes.length + entry.compressed.length;
    }

    const centralBuffer = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
    end.writeUInt16LE(0, 4); // this disk
    end.writeUInt16LE(0, 6); // disk with central directory
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16); // offset of central directory
    end.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...chunks, centralBuffer, end]);
  }

  get fileCount(): number {
    return this.entries.length;
  }
}
