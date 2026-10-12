import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Diagnostic fixtures only. Production exports never call an external encoder. */
export async function sillyTavernImages(checkout) {
  await import(pathToFileURL(resolve(checkout, 'src/fetch-patch.js')));
  const { Jimp, JimpMime } = await import(pathToFileURL(resolve(checkout, 'src/jimp.js')));
  const encode = async (color) => new Uint8Array(await new Jimp({ width: 48, height: 64, color }).getBuffer(JimpMime.png));
  return { encoded: await encode(0x487342ff), changed: await encode(0x8e3131ff),
    ordinary: new Uint8Array(await readFile(resolve(checkout, 'public/img/ai4.png'))) };
}
