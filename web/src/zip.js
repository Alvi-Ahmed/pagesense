// A tiny ZIP writer (no compression: the files are JPEGs, which do not shrink) so "Download all" works in the browser,
// demo included, without a library or a server round trip.
const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

const dataUrlBytes = (url) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (ch) => ch.charCodeAt(0))

// files: [{ name, dataUrl }] -> a Blob of a .zip
export function zipBlob(files) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  const u16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255])
  const u32 = (v) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255])
  for (const f of files) {
    const name = enc.encode(f.name)
    const bytes = dataUrlBytes(f.dataUrl)
    const crc = crc32(bytes)
    const local = [u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(bytes.length), u32(bytes.length), u16(name.length), u16(0), name]
    central.push([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(bytes.length), u32(bytes.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name])
    parts.push(...local, bytes)
    offset += local.reduce((n, p) => n + p.length, 0) + bytes.length
  }
  const size = central.flat().reduce((n, p) => n + p.length, 0)
  parts.push(...central.flat(), u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(size), u32(offset), u16(0))
  return new Blob(parts, { type: 'application/zip' })
}
