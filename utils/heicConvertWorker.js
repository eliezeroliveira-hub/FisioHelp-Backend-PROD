import fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import heicConvert from 'heic-convert';

async function main() {
  const inputPath = String(workerData?.inputPath || '');
  const outputPath = String(workerData?.outputPath || '');
  const quality = Number(workerData?.quality ?? 0.88);

  if (!inputPath || !outputPath) {
    throw new Error('inputPath/outputPath obrigatorios para conversao HEIC.');
  }

  const inputBuffer = await fs.promises.readFile(inputPath);
  const convert = heicConvert?.default || heicConvert;
  const output = await convert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality,
  });

  await fs.promises.writeFile(outputPath, Buffer.from(output));
  parentPort?.postMessage({ ok: true, bytes: Buffer.byteLength(output) });
}

main().catch((err) => {
  parentPort?.postMessage({
    ok: false,
    erro: err?.message || String(err),
    stack: err?.stack,
  });
});
