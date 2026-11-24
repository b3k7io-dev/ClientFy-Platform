import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const ALLOWLISTED_ROOT_ENTRIES = [
  'src',
  'server',
  'public',
  'docs',
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'server.ts',
  'metadata.json',
  '.env.example',
  '.gitignore',
  'README.md',
];

const EXCLUDED_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'data',
  'autosend',
  '.git',
  '.DS_Store',
]);

function isSafeArchiveEntry(relPath: string): boolean {
  const parts = relPath.split('/');
  for (const part of parts) {
    if (!part || EXCLUDED_NAMES.has(part)) return false;
    if (part.startsWith('.env') && part !== '.env.example') return false;
    if (part.endsWith('.log')) return false;
  }
  return true;
}

function createTarHeader(entryPath: string, size: number, mode = 0o644, isDir = false): Buffer {
  const header = Buffer.alloc(512, 0);
  const cleanName = isDir && !entryPath.endsWith('/') ? `${entryPath}/` : entryPath;

  let name = cleanName;
  let prefix = '';
  if (Buffer.byteLength(cleanName, 'utf8') > 100) {
    const slashIdx = cleanName.lastIndexOf('/');
    if (slashIdx > 0) {
      prefix = cleanName.slice(0, slashIdx);
      name = cleanName.slice(slashIdx + 1);
    }
  }

  header.write(name.slice(0, 100), 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write((isDir ? 0 : size).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156); // checksum placeholder
  header.write(isDir ? '5' : '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) {
    header.write(prefix.slice(0, 155), 345, 155, 'utf8');
  }

  let checksum = 0;
  for (let i = 0; i < 512; i += 1) {
    checksum += header[i];
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

async function collectFiles(
  rootDir: string,
  absPath: string,
  relPath: string,
  chunks: Buffer[],
): Promise<void> {
  if (!isSafeArchiveEntry(relPath)) return;

  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat) return;

  const archivePath = `clientfy/${relPath}`;
  if (stat.isDirectory()) {
    chunks.push(createTarHeader(archivePath, 0, 0o755, true));
    const entries = await fs.readdir(absPath);
    entries.sort();
    for (const entry of entries) {
      await collectFiles(rootDir, path.join(absPath, entry), `${relPath}/${entry}`, chunks);
    }
    return;
  }

  if (!stat.isFile()) return;
  const content = await fs.readFile(absPath);
  chunks.push(createTarHeader(archivePath, content.length, 0o644, false));
  chunks.push(content);
  const remainder = content.length % 512;
  if (remainder !== 0) {
    chunks.push(Buffer.alloc(512 - remainder, 0));
  }
}

let cachedArchive: {buffer: Buffer; expiresAt: number} | null = null;

export async function buildCleanSourceTarGz(): Promise<Buffer> {
  if (cachedArchive && cachedArchive.expiresAt > Date.now()) {
    return cachedArchive.buffer;
  }

  const rootDir = process.cwd();
  const chunks: Buffer[] = [];
  chunks.push(createTarHeader('clientfy', 0, 0o755, true));

  for (const entry of ALLOWLISTED_ROOT_ENTRIES) {
    const absPath = path.resolve(rootDir, entry);
    await collectFiles(rootDir, absPath, entry, chunks);
  }

  // TAR end-of-archive marker (two 512-byte zero blocks)
  chunks.push(Buffer.alloc(1024, 0));

  const tarBuffer = Buffer.concat(chunks);
  const gzBuffer = zlib.gzipSync(tarBuffer, {level: 6});

  cachedArchive = {
    buffer: gzBuffer,
    expiresAt: Date.now() + 15_000,
  };
  return gzBuffer;
}
