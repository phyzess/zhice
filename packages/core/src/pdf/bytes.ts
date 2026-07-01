const encoder = new TextEncoder();

export function encodeAscii(value: string): Uint8Array {
  return encoder.encode(value);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function escapePdfString(value: string): string {
  return value.replace(/[()\\]/g, (match) => `\\${match}`);
}

export function formatPdfString(value: string): string {
  if (/^[\u0020-\u007e]*$/.test(value)) {
    return `(${escapePdfString(value)})`;
  }
  return `<FEFF${utf16BeHex(value)}>`;
}

function utf16BeHex(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    output += value.charCodeAt(index).toString(16).padStart(4, "0").toUpperCase();
  }
  return output;
}
