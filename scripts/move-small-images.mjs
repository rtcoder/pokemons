#!/usr/bin/env node

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_SOURCE_DIR = "data/images";
const DEFAULT_MIN_WIDTH = 128;
const DEFAULT_MIN_HEIGHT = 128;
const READY_TO_DELETE_DIR = "ready-to-delete";
const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.source ?? DEFAULT_SOURCE_DIR);
const minWidth = Number(args.minWidth ?? DEFAULT_MIN_WIDTH);
const minHeight = Number(args.minHeight ?? DEFAULT_MIN_HEIGHT);
const dryRun = Boolean(args.dryRun);
const limit = optionalPositiveInteger(args.limit, "--limit");
const offset = Number(args.offset ?? 0);

if (args.help) {
  printHelp();
  process.exit(0);
}

assertPositiveInteger(minWidth, "--min-width");
assertPositiveInteger(minHeight, "--min-height");
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
    minWidth,
    minHeight,
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
  console.log(`Threshold: ${minWidth}x${minHeight}`);
  console.log(`Mode: ${dryRun ? "dry-run" : "move"}`);
  console.log(`Selected dirs: ${selectedDirs.length}/${pokemonDirs.length} from offset ${offset}`);

  for (const [index, dir] of selectedDirs.entries()) {
    const result = await processPokemonDir(dir, index + offset + 1, pokemonDirs.length);
    manifest.scanned += result.scanned;
    manifest.moved += result.moved;
    manifest.kept += result.kept;
    manifest.skipped += result.skipped;
    manifest.unreadable += result.unreadable;
    manifest.files.push(...result.files);
    await writeJson(path.join(sourceDir, "small-images-manifest.json"), manifest);
  }

  manifest.finishedAt = new Date().toISOString();
  await writeJson(path.join(sourceDir, "small-images-manifest.json"), manifest);
  console.log(
    `Done. Scanned ${manifest.scanned}, ${dryRun ? "would move" : "moved"} ${manifest.moved}, kept ${manifest.kept}, skipped ${manifest.skipped}, unreadable ${manifest.unreadable}.`,
  );
}

async function processPokemonDir(dir, position, total) {
  const label = path.basename(dir);
  const readyDir = path.join(dir, READY_TO_DELETE_DIR);
  const files = await listImageFiles(dir);
  const result = {
    dir,
    scanned: 0,
    moved: 0,
    kept: 0,
    skipped: 0,
    unreadable: 0,
    files: [],
  };

  console.log(`[${position}/${total}] ${label}: ${files.length} candidate files`);

  for (const filePath of files) {
    const relativeFile = projectRelativePath(filePath);
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".svg") {
      result.skipped += 1;
      continue;
    }

    result.scanned += 1;

    let dimensions;
    try {
      dimensions = await readImageDimensions(filePath);
    } catch (error) {
      result.unreadable += 1;
      result.files.push({
        path: relativeFile,
        status: "unreadable",
        error: error.message,
      });
      continue;
    }

    const isSmall = dimensions.width < minWidth || dimensions.height < minHeight;
    if (!isSmall) {
      result.kept += 1;
      continue;
    }

    const targetPath = await uniqueTargetPath(path.join(readyDir, path.basename(filePath)));
    result.moved += 1;
    result.files.push({
      path: relativeFile,
      targetPath: projectRelativePath(targetPath),
      status: dryRun ? "would-move" : "moved",
      width: dimensions.width,
      height: dimensions.height,
    });

    console.log(
      `[${position}/${total}] ${label}: ${dryRun ? "would move" : "move"} ${path.basename(filePath)} (${dimensions.width}x${dimensions.height})`,
    );

    if (!dryRun) {
      await mkdir(readyDir, { recursive: true });
      await rename(filePath, targetPath);
    }
  }

  console.log(
    `[${position}/${total}] ${label}: scanned ${result.scanned}, ${dryRun ? "would move" : "moved"} ${result.moved}, kept ${result.kept}, unreadable ${result.unreadable}`,
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

async function listImageFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .filter((filePath) => SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort();
}

async function readImageDimensions(filePath) {
  const handle = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".png") {
    return readPngDimensions(handle, filePath);
  }

  if (ext === ".gif") {
    return readGifDimensions(handle, filePath);
  }

  if (ext === ".jpg" || ext === ".jpeg") {
    return readJpegDimensions(handle, filePath);
  }

  if (ext === ".webp") {
    return readWebpDimensions(handle, filePath);
  }

  throw new Error(`Unsupported image extension: ${ext}`);
}

function readPngDimensions(buffer, filePath) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`Invalid PNG: ${filePath}`);
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readGifDimensions(buffer, filePath) {
  const signature = buffer.toString("ascii", 0, 6);
  if (buffer.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) {
    throw new Error(`Invalid GIF: ${filePath}`);
  }

  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function readJpegDimensions(buffer, filePath) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error(`Invalid JPEG: ${filePath}`);
  }

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    offset += 2;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }

    const length = buffer.readUInt16BE(offset);
    if (isJpegStartOfFrame(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }

    offset += length;
  }

  throw new Error(`JPEG dimensions not found: ${filePath}`);
}

function isJpegStartOfFrame(marker) {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    ![0xc4, 0xc8, 0xcc].includes(marker)
  );
}

function readWebpDimensions(buffer, filePath) {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error(`Invalid WebP: ${filePath}`);
  }

  const chunkType = buffer.toString("ascii", 12, 16);

  if (chunkType === "VP8 ") {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunkType === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunkType === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }

  throw new Error(`Unsupported WebP chunk ${chunkType}: ${filePath}`);
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

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`
Usage:
  node scripts/move-small-images.mjs [options]

Default behavior:
  Move raster images smaller than ${DEFAULT_MIN_WIDTH}x${DEFAULT_MIN_HEIGHT} into:
    data/images/[id]-[name]/ready-to-delete/

SVG files are always ignored.

Options:
  --source <dir>       Image root directory. Default: ${DEFAULT_SOURCE_DIR}
  --min-width <px>     Minimum allowed width. Default: ${DEFAULT_MIN_WIDTH}
  --min-height <px>    Minimum allowed height. Default: ${DEFAULT_MIN_HEIGHT}
  --limit <number>     Process only N Pokemon image directories.
  --offset <number>    Start from this directory offset. Default: 0
  --dry-run            Print what would move without moving files.
  --help               Show this help.

Examples:
  node scripts/move-small-images.mjs --dry-run --limit 5
  node scripts/move-small-images.mjs --min-width 128 --min-height 128
  node scripts/move-small-images.mjs --min-width 256 --min-height 256
`);
}
