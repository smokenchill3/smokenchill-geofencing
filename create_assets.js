const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Helper function to build valid PNG binary chunks with CRC32 checksums
function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcVal = zlib.crc32(typeAndData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal >>> 0, 0);
  return Buffer.concat([len, typeAndData, crcBuf]);
}

// Pure JS PNG generator (No C++ compiler or canvas module required)
function createSolidPng(width, height, r, g, b) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR Chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth
  ihdr[9] = 6; // Color type: RGBA
  ihdr[10] = 0; // Compression
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // Raw RGBA pixel rows
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter byte
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      rawData[pxOffset] = r;     // Red
      rawData[pxOffset + 1] = g; // Green
      rawData[pxOffset + 2] = b; // Blue
      rawData[pxOffset + 3] = 255; // Alpha (Opaque)
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressedData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Target directory: passModels/coupon.pass/
const passDir = path.join(__dirname, 'passModels', 'coupon.pass');

if (!fs.existsSync(passDir)) {
  fs.mkdirSync(passDir, { recursive: true });
}

// Apple Wallet exact asset specifications
const assets = [
  { name: 'icon.png', width: 29, height: 29, color: [59, 130, 246] },      // Blue
  { name: 'icon@2x.png', width: 58, height: 58, color: [59, 130, 246] },
  { name: 'logo.png', width: 160, height: 50, color: [30, 41, 59] },       // Slate
  { name: 'logo@2x.png', width: 320, height: 100, color: [30, 41, 59] },
  { name: 'strip.png', width: 375, height: 144, color: [15, 23, 42] },     // Dark Navy
  { name: 'strip@2x.png', width: 750, height: 288, color: [15, 23, 42] }
];

assets.forEach((asset) => {
  const pngBuffer = createSolidPng(asset.width, asset.height, ...asset.color);
  const filePath = path.join(passDir, asset.name);
  fs.writeFileSync(filePath, pngBuffer);
  console.log(`✅ Created ${asset.name} (${asset.width}x${asset.height} px)`);
});

console.log('\n🎉 All Apple Wallet PNG assets generated successfully!');