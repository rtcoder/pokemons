#!/usr/bin/env node

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

const DEFAULT_SOURCE_DIR = "data/images";
const DEFAULT_TRANSPARENT_RATIO = 0.6;
const DEFAULT_ALPHA_THRESHOLD = 0;
const READY_TO_DELETE_DIR = "ready-to-delete";

const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.source ?? DEFAULT_SOURCE_DIR);
const transparentRatio = Number(args.ratio ?? DEFAULT_TRANSPARENT_RATIO);
const alphaThreshold = Number(args.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD);
const dryRun = Boolean(args.dryRun);
const limit = optionalPositiveInteger(args.limit, "--limit");
const offset = Number(args.offset ?? 0);

if (args.help) {
  printHelp();
  process.exit(0);
}

assertRatio(transparentRatio, "--ratio");
assertByte(alphaThreshold, "--alpha-threshold");
assertNonNegativeInteger(offset, "--offset");

await main();

async function main() {
  const pokemonDirs = await listPokemonImageDirs(sourceDir);
  const selectedDirs = pokemonDirs.slice(
    offset,
    limit === undefined ? undefined : offset + limit,
  );
  const manifest = {
    sourceDir,
    transparentRatio,
    alphaThreshold,
    dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sourceCount: pokemonDirs.length,
    selectedOffset: offset,
    selectedLimit: limit ?? null,
    selectedCount: selectedDirs.length,
    scanned: 0,
    moved: 0,
    kept: 0,
    skipped: 0,
    unreadable: 0,
    files: [],
  };

  console.log(`Source: ${sourceDir}`);
  console.log(`Threshold: >${Math.round(transparentRatio * 100)}% transparent pixels`);
  console.log(`Alpha threshold: <=${alphaThreshold}`);
  console.log(`Mode: ${dryRun ? "dry-run" : "move"}`);
  console.log(`Selected dirs: ${selectedDirs.length}/${pokemonDirs.length} from offset ${offset}`);

  for (const [index, dir] of selectedDirs.entries()) {
    const result = await processPokemonDir(dir, offset + index + 1, pokemonDirs.length);
    manifest.scanned += result.scanned;
    manifest.moved += result.moved;
    manifest.kept += result.kept;
    manifest.skipped += result.skipped;
    manifest.unreadable += result.unreadable;
    manifest.files.push(...result.files);
    await writeJson(path.join(sourceDir, "transparent-images-manifest.json"), manifest);
  }

  manifest.finishedAt = new Date().toISOString();
  await writeJson(path.join(sourceDir, "transparent-images-manifest.json"), manifest);
  console.log(
    `Done. Scanned ${manifest.scanned}, ${dryRun ? "would move" : "moved"} ${manifest.moved}, kept ${manifest.kept}, skipped ${manifest.skipped}, unreadable ${manifest.unreadable}.`,
  );
}

async function processPokemonDir(dir, position, total) {
  const label = path.basename(dir);
  const readyDir = path.join(dir, READY_TO_DELETE_DIR);
  const files = await listPngFiles(dir);
  const result = {
    dir,
    scanned: 0,
    moved: 0,
    kept: 0,
    skipped: 0,
    unreadable: 0,
    files: [],
  };

  console.log(`[${position}/${total}] ${label}: ${files.length} png files`);

  for (const filePath of files) {
    const relativeFile = projectRelativePath(filePath);
    result.scanned += 1;

    let analysis;
    try {
      analysis = analyzePngTransparency(await readFile(filePath), filePath);
    } catch (error) {
      result.unreadable += 1;
      result.files.push({
        path: relativeFile,
        status: "unreadable",
        error: error.message,
      });
      continue;
    }

    if (!analysis.hasAlpha) {
      result.skipped += 1;
      continue;
    }

    if (analysis.transparentRatio <= transparentRatio) {
      result.kept += 1;
      continue;
    }

    const targetPath = await uniqueTargetPath(path.join(readyDir, path.basename(filePath)));
    result.moved += 1;
    result.files.push({
      path: relativeFile,
      targetPath: projectRelativePath(targetPath),
      status: dryRun ? "would-move" : "moved",
      width: analysis.width,
      height: analysis.height,
      transparentPixels: analysis.transparentPixels,
      totalPixels: analysis.totalPixels,
      transparentRatio: analysis.transparentRatio,
    });

    console.log(
      `[${position}/${total}] ${label}: ${dryRun ? "would move" : "move"} ${path.basename(filePath)} (${analysis.width}x${analysis.height}, ${Math.round(analysis.transparentRatio * 100)}% transparent)`,
    );

    if (!dryRun) {
      await mkdir(readyDir, { recursive: true });
      await rename(filePath, targetPath);
    }
  }

  console.log(
    `[${position}/${total}] ${label}: scanned ${result.scanned}, ${dryRun ? "would move" : "moved"} ${result.moved}, kept ${result.kept}, skipped ${result.skipped}, unreadable ${result.unreadable}`,
  );

  return result;
}

async function listPokemonImageDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== READY_TO_DELETE_DIR)
    .map((entry) => path.join(dir, entry.name))
    .sort(comparePokemonDirNames);
}

async function listPngFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".png")
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function analyzePngTransparency(buffer, filePath) {
  if (buffer.length < 33 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
    throw new Error(`Invalid PNG: ${filePath}`);
  }

  const chunks = readPngChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr) {
    throw new Error(`Missing IHDR: ${filePath}`);
  }

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  if (interlace !== 0) {
    throw new Error(`Interlaced PNG is not supported: ${filePath}`);
  }

  if (bitDepth !== 8) {
    throw new Error(`Only 8-bit PNGs are supported: ${filePath}`);
  }

  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  const raw = inflateSync(idat);

  if (colorType === 6) {
    return analyzeAlphaChannel(raw, width, height, 4, 3);
  }

  if (colorType === 4) {
    return analyzeAlphaChannel(raw, width, height, 2, 1);
  }

  if (colorType === 3) {
    const trns = chunks.find((chunk) => chunk.type === "tRNS");
    if (!trns) {
      return { width, height, hasAlpha: false };
    }

    return analyzeIndexedAlpha(raw, width, height, trns.data);
  }

  return { width, height, hasAlpha: false };
}

function readPngChunks(buffer) {
  const chunks = [];
  let offset = 8;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;

    if (type === "IEND") {
      break;
    }
  }

  return chunks;
}

function analyzeAlphaChannel(raw, width, height, bytesPerPixel, alphaOffset) {
  const rows = unfilterPng(raw, width, height, bytesPerPixel);
  let transparentPixels = 0;
  const totalPixels = width * height;

  for (let index = alphaOffset; index < rows.length; index += bytesPerPixel) {
    if (rows[index] <= alphaThreshold) {
      transparentPixels += 1;
    }
  }

  return {
    width,
    height,
    hasAlpha: true,
    transparentPixels,
    totalPixels,
    transparentRatio: transparentPixels / totalPixels,
  };
}

function analyzeIndexedAlpha(raw, width, height, transparencyTable) {
  const rows = unfilterPng(raw, width, height, 1);
  let transparentPixels = 0;
  const totalPixels = width * height;

  for (const paletteIndex of rows) {
    const alpha = transparencyTable[paletteIndex] ?? 255;
    if (alpha <= alphaThreshold) {
      transparentPixels += 1;
    }
  }

  return {
    width,
    height,
    hasAlpha: true,
    transparentPixels,
    totalPixels,
    transparentRatio: transparentPixels / totalPixels,
  };
}

function unfilterPng(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const output = Buffer.alloc(stride * height);
  let rawOffset = 0;
  let outputOffset = 0;

  for (let row = 0; row < height; row += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;

    for (let column = 0; column < stride; column += 1) {
      const x = raw[rawOffset + column];
      const left = column >= bytesPerPixel ? output[outputOffset + column - bytesPerPixel] : 0;
      const up = row > 0 ? output[outputOffset + column - stride] : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? output[outputOffset + column - stride - bytesPerPixel]
          : 0;

      output[outputOffset + column] =
        (x + pngFilterValue(filter, left, up, upperLeft)) & 0xff;
    }

    rawOffset += stride;
    outputOffset += stride;
  }

  return output;
}

function pngFilterValue(filter, left, up, upperLeft) {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4:
      return paethPredictor(left, up, upperLeft);
    default:
      throw new Error(`Unsupported PNG filter: ${filter}`);
  }
}

function paethPredictor(left, up, upperLeft) {
  const p = left + up - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upperLeft);

  if (pa <= pb && pa <= pc) {
    return left;
  }

  if (pb <= pc) {
    return up;
  }

  return upperLeft;
}

async function uniqueTargetPath(targetPath) {
  if (!existsSync(targetPath)) {
    return targetPath;
  }

  const ext = path.extname(targetPath);
  const base = targetPath.slice(0, -ext.length);
  let counter = 2;

  while (existsSync(`${base}-${counter}${ext}`)) {
    counter += 1;
  }

  return `${base}-${counter}${ext}`;
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function comparePokemonDirNames(left, right) {
  const leftId = Number(path.basename(left).split("-", 1)[0]);
  const rightId = Number(path.basename(right).split("-", 1)[0]);

  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }

  return left.localeCompare(right);
}

function projectRelativePath(absolutePath) {
  return path.relative(process.cwd(), absolutePath).split(path.sep).join("/");
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = camelCase(rawKey);

    if (["dry-run", "help"].includes(rawKey)) {
      parsed[key] = true;
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    parsed[key] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined) {
    return undefined;
  }

  const number = Number(value);
  assertPositiveInteger(number, name);
  return number;
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertRatio(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
}

function assertByte(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${name} must be an integer between 0 and 255`);
  }
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`
Usage:
  node scripts/move-transparent-images.mjs [options]

Default behavior:
  Move PNG images where more than ${Math.round(DEFAULT_TRANSPARENT_RATIO * 100)}% of pixels are transparent into:
    data/images/[id]-[name]/ready-to-delete/

SVG, GIF, JPG, JPEG, and WebP files are ignored.

Options:
  --source <dir>              Image root directory. Default: ${DEFAULT_SOURCE_DIR}
  --ratio <0..1>              Transparent-pixel ratio threshold. Default: ${DEFAULT_TRANSPARENT_RATIO}
  --alpha-threshold <0..255>  Alpha value treated as transparent. Default: ${DEFAULT_ALPHA_THRESHOLD}
  --limit <number>            Process only N Pokemon image directories.
  --offset <number>           Start from this directory offset. Default: 0
  --dry-run                   Print what would move without moving files.
  --help                      Show this help.

Examples:
  node scripts/move-transparent-images.mjs --dry-run --limit 5
  node scripts/move-transparent-images.mjs --ratio 0.6
  node scripts/move-transparent-images.mjs --ratio 0.75 --alpha-threshold 8
`);
}
