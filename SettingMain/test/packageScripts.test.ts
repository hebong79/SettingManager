import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const packageJsonUrl = new URL('../package.json', import.meta.url);

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isUnknownRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

async function readPackageManifest(): Promise<PackageManifest> {
  const packageJsonPath = fileURLToPath(packageJsonUrl);
  const packageJson = await readFile(packageJsonPath, 'utf8');
  const parsed: unknown = JSON.parse(packageJson);

  if (!isUnknownRecord(parsed)) {
    throw new Error('package.json must contain an object');
  }

  const devDependencies = parsed['devDependencies'];
  const scripts = parsed['scripts'];

  if (
    (devDependencies !== undefined && !isStringRecord(devDependencies)) ||
    (scripts !== undefined && !isStringRecord(scripts))
  ) {
    throw new Error('package.json scripts and devDependencies must be string records');
  }

  return { devDependencies, scripts };
}

describe('package scripts', () => {
  it('runs the TypeScript server through local nodemon while watching source files', async () => {
    const manifest = await readPackageManifest();

    expect(manifest.devDependencies?.nodemon).toBeDefined();
    expect(manifest.scripts?.start).toBe(
      'nodemon --watch src --ext ts --exec "tsx src/index.ts"',
    );
  });
});
