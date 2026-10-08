/**
 * Minimal random-access zip reader for a File: finds entries through the central directory at the end of the
 * file, then inflates only the entries asked for, in pieces. An .xlsx is a zip, and its sheet XML can be
 * hundreds of MB, so nothing here ever holds a whole entry (or the whole file) in memory.
 */
import { Inflate } from "fflate";

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  /** Where this entry's local header starts. */
  offset: number;
}

const SLICE = 1024 * 1024;
/** Hand control back to the page now and then so a long read doesn't freeze it (progress text needs to repaint). */
let lastYield = 0;
async function breathe(): Promise<void> {
  const now = Date.now();
  if (now - lastYield > 80) {
    await new Promise((r) => setTimeout(r, 0));
    lastYield = Date.now();
  }
}

async function bytes(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

export async function readEntries(file: Blob): Promise<Map<string, ZipEntry>> {
  const tailLen = Math.min(file.size, 66_000);
  const tail = await bytes(file, file.size - tailLen, file.size);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This doesn't look like an .xlsx file (it isn't a zip archive).");
  let count = dv.getUint16(eocd + 10, true);
  let dirSize = dv.getUint32(eocd + 12, true);
  let dirStart = dv.getUint32(eocd + 16, true);
  if (dirStart === 0xffffffff || count === 0xffff) {
    // ZIP64 (files over 4 GB or 65,535 entries): the real numbers are in the zip64 end-of-directory record.
    const locator = eocd - 20;
    if (locator < 0 || dv.getUint32(locator, true) !== 0x07064b50) throw new Error("This zip file is damaged or in a format I can't read.");
    const recStart = Number(dv.getBigUint64(locator + 8, true));
    const rec = await bytes(file, recStart, recStart + 56);
    const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    count = Number(rv.getBigUint64(32, true));
    dirSize = Number(rv.getBigUint64(40, true));
    dirStart = Number(rv.getBigUint64(48, true));
  }
  const dir = await bytes(file, dirStart, dirStart + dirSize);
  const d = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const utf8 = new TextDecoder();
  const out = new Map<string, ZipEntry>();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= dir.length; n++) {
    if (d.getUint32(p, true) !== 0x02014b50) break;
    const method = d.getUint16(p + 10, true);
    let compressedSize = d.getUint32(p + 20, true);
    let size = d.getUint32(p + 24, true);
    const nameLen = d.getUint16(p + 28, true);
    const extraLen = d.getUint16(p + 30, true);
    const commentLen = d.getUint16(p + 32, true);
    let offset = d.getUint32(p + 42, true);
    const name = utf8.decode(dir.subarray(p + 46, p + 46 + nameLen));
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
      let q = p + 46 + nameLen;
      const end = q + extraLen;
      while (q + 4 <= end) {
        const id = d.getUint16(q, true), len = d.getUint16(q + 2, true);
        if (id === 1) {
          let r = q + 4;
          if (size === 0xffffffff) { size = Number(d.getBigUint64(r, true)); r += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(d.getBigUint64(r, true)); r += 8; }
          if (offset === 0xffffffff) offset = Number(d.getBigUint64(r, true));
          break;
        }
        q += 4 + len;
      }
    }
    out.set(name, { name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Stream an entry's uncompressed bytes to `onChunk`. Return false from `onChunk` to stop early (reading just
 * the header row of a huge sheet shouldn't inflate the rest of it).
 */
export async function streamEntry(file: Blob, entry: ZipEntry, onChunk: (chunk: Uint8Array) => boolean | void): Promise<void> {
  const head = await bytes(file, entry.offset, entry.offset + 30);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (hv.getUint32(0, true) !== 0x04034b50) throw new Error("This zip file is damaged.");
  const start = entry.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  const end = start + entry.compressedSize;

  let stop = false;
  if (entry.method === 0) {
    for (let at = start; at < end && !stop; at += SLICE) {
      if (onChunk(await bytes(file, at, Math.min(end, at + SLICE))) === false) stop = true;
    }
    return;
  }
  if (entry.method !== 8) throw new Error(`This file uses a zip compression method I can't read (${entry.method}).`);
  let failure: Error | null = null;
  const inflate = new Inflate((chunk) => {
    if (!stop && onChunk(chunk) === false) stop = true;
  });
  for (let at = start; at < end && !stop; at += SLICE) {
    const last = Math.min(end, at + SLICE) >= end;
    try {
      inflate.push(await bytes(file, at, Math.min(end, at + SLICE)), last);
      await breathe();
    } catch (e) {
      failure = e as Error;
      break;
    }
  }
  if (failure) throw new Error(`This file is damaged and can't be read (${failure.message}).`);
}
