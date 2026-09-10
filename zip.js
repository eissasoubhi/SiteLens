// Minimal ZIP writer using STORE (no compression). PNG/WebP files are already compressed,
// so this avoids shipping a third-party dependency while keeping the extension fully local.
(() => {
  const encoder = new TextEncoder();
  let crcTable;

  function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
    return crcTable;
  }

  function crc32(bytes) {
    const table = getCrcTable();
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTimeDate(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const dosDate = ((year - 1980) << 9) | (month << 5) | day;
    return { time, date: dosDate };
  }

  function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
  function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

  class LocalZip {
    constructor() { this.files = []; }

    add(name, data) {
      let bytes;
      if (typeof data === 'string') bytes = encoder.encode(data);
      else if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else throw new TypeError('Unsupported ZIP entry type');
      this.files.push({ name, bytes, crc: crc32(bytes) });
    }

    blob() {
      const localParts = [];
      const centralParts = [];
      let offset = 0;
      const { time, date } = dosTimeDate();

      for (const file of this.files) {
        const name = encoder.encode(file.name);
        const localHeader = new Uint8Array([
          ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
          ...u16(time), ...u16(date), ...u32(file.crc), ...u32(file.bytes.length), ...u32(file.bytes.length),
          ...u16(name.length), ...u16(0), ...name
        ]);
        localParts.push(localHeader, file.bytes);

        const centralHeader = new Uint8Array([
          ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
          ...u16(time), ...u16(date), ...u32(file.crc), ...u32(file.bytes.length), ...u32(file.bytes.length),
          ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name
        ]);
        centralParts.push(centralHeader);
        offset += localHeader.length + file.bytes.length;
      }

      const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
      const end = new Uint8Array([
        ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(this.files.length), ...u16(this.files.length),
        ...u32(centralSize), ...u32(offset), ...u16(0)
      ]);
      return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
    }
  }

  window.LocalZip = LocalZip;
})();
