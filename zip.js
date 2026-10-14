// Minimal STORE-only ZIP writer. No compression — images are already
// compressed and the JSON is tiny, so the <100 KB we'd save isn't worth
// bundling a DEFLATE implementation.
//
// Exposes window.makeZip(entries) → Blob.
//   entries: [{ name: string, data: Uint8Array }]
//   name can contain forward slashes to create folders inside the archive.

(() => {
  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[i] = c >>> 0;
  }

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) {
      c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = new TextEncoder();

  function makeZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;

    for (const { name, data } of entries) {
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const size = data.length;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);           // version needed to extract
      lh.setUint16(6, 0x0800, true);       // flags: bit 11 = UTF-8 filename
      lh.setUint16(8, 0, true);            // compression method = STORE
      lh.setUint16(10, 0, true);           // mod time
      lh.setUint16(12, 0x0021, true);      // mod date = 1980-01-01
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);        // compressed size
      lh.setUint32(22, size, true);        // uncompressed size
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer));
      parts.push(nameBytes);
      parts.push(data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, 0, true);
      cd.setUint16(14, 0x0021, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer));
      central.push(nameBytes);

      offset += 30 + nameBytes.length + size;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const p of central) centralSize += p.length;

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);            // disk number
    eocd.setUint16(6, 0, true);            // disk w/ CD start
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, centralStart, true);
    eocd.setUint16(20, 0, true);           // comment length

    return new Blob(
      [...parts, ...central, new Uint8Array(eocd.buffer)],
      { type: 'application/zip' }
    );
  }

  window.makeZip = makeZip;
})();
