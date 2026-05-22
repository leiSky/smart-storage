import { rmSync, mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(currentDir, '..');
const tsupCli = resolve(rootDir, 'node_modules/tsup/dist/cli-default.js');

const distDir = resolve(rootDir, 'dist');
const tempDir = resolve(rootDir, '.build-temp');
const entryDir = resolve(rootDir, 'dist/entry');
const chunkDir = resolve(rootDir, 'dist/chunk');
const typesDir = resolve(rootDir, 'dist/types');

function cleanOutputDirs() {
  rmSync(distDir, { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
}

function ensureOutputDirs() {
  mkdirSync(entryDir, { recursive: true });
  mkdirSync(chunkDir, { recursive: true });
  mkdirSync(typesDir, { recursive: true });
}

function runTsupBuild() {
  const result = spawnSync(
    process.execPath,
    [
      tsupCli,
      '--entry.index',
      'src/index.ts',
      '--entry.hook',
      'src/hook/index.ts',
      '--entry.localSmartStorage',
      'src/local/localSmartStorage.ts',
      '--entry.sessionSmartStorage',
      'src/session/sessionSmartStorage.ts',
      '--format',
      'esm',
      '--dts',
      '--clean',
      '--out-dir',
      tempDir,
    ],
    {
      cwd: rootDir,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function moveArtifacts() {
  for (const fileName of readdirSync(tempDir)) {
    const sourcePath = join(tempDir, fileName);

    if (fileName.endsWith('.d.ts')) {
      renameSync(sourcePath, join(typesDir, fileName));
      continue;
    }

    if (extname(fileName) === '.js' && fileName.startsWith('chunk-')) {
      renameSync(sourcePath, join(chunkDir, fileName));
      continue;
    }

    if (extname(fileName) === '.js') {
      renameSync(sourcePath, join(entryDir, fileName));
      continue;
    }
  }
}

function rewriteEntryImports() {
  for (const fileName of readdirSync(entryDir)) {
    if (!fileName.endsWith('.js')) {
      continue;
    }

    const filePath = join(entryDir, fileName);
    const source = readFileSync(filePath, 'utf8');
    const rewritten = source.replaceAll(/"\.\/(chunk-[^"]+\.js)"/g, '"../chunk/$1"');
    writeFileSync(filePath, rewritten);
  }
}

function cleanupTempDir() {
  rmSync(tempDir, { recursive: true, force: true });
}

cleanOutputDirs();
ensureOutputDirs();
runTsupBuild();
moveArtifacts();
rewriteEntryImports();
cleanupTempDir();
