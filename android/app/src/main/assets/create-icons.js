import fs from 'fs';
import zlib from 'zlib';

/**
 * Creates an uncompressed / zlib compressed valid raw PNG file
 */
function createPng(width, height, r, g, b) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8 bits per channel
  ihdrData[9] = 2; // Truecolor RGB
  ihdrData[10] = 0; // deflate
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // no interlace

  const ihdrChunk = createChunk('IHDR', ihdrData);

  // Raw image scanlines
  // Each line has 1 filter byte (0) + width * 3 bytes
  const scanlineLength = 1 + width * 3;
  const rawData = Buffer.alloc(scanlineLength * height);

  for (let y = 0; y < height; y++) {
    const offset = y * scanlineLength;
    rawData[offset] = 0; // Filter: none
    for (let x = 0; x < width; x++) {
      const pxOffset = offset + 1 + x * 3;
      // Draw Spotify green waves in the center, dark background around
      const cx = width / 2;
      const cy = height / 2;
      const dist = Math.hypot(x - cx, y - cy);
      const isWaveBar = Math.abs(x - cx) < width * 0.35 && Math.abs(y - cy) < height * 0.35 && ((Math.floor(x / 14)) % 2 === 0);

      if (dist < width * 0.45 && isWaveBar) {
        rawData[pxOffset] = 29;     // #1db954
        rawData[pxOffset + 1] = 185;
        rawData[pxOffset + 2] = 84;
      } else {
        rawData[pxOffset] = 10;     // #0a0c10
        rawData[pxOffset + 1] = 12;
        rawData[pxOffset + 2] = 16;
      }
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = createChunk('IDAT', compressedData);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(12 + len);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  const crc = crc32(chunk.subarray(4, 8 + len));
  chunk.writeInt32BE(crc, 8 + len);
  return chunk;
}

// CRC32 table
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ -1;
}

fs.writeFileSync('icons/icon-192.png', createPng(192, 192, 29, 185, 84));
fs.writeFileSync('icons/icon-512.png', createPng(512, 512, 29, 185, 84));
console.log('Generated icon-192.png and icon-512.png successfully!');
