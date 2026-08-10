import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const mobileDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = fileURLToPath(
  new URL('../../../', import.meta.url),
);
const serverDirectory = join(repositoryDirectory, 'packages/server');

const runtimePackages = ['react', 'react-dom'] as const;

interface PackageManifest {
  dependencies?: Record<string, string>;
  version?: string;
}

async function readManifest(path: string): Promise<PackageManifest> {
  const manifest: unknown = await Bun.file(path).json();

  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error(`Expected an object in ${path}`);
  }

  return manifest as PackageManifest;
}

const mobileImporter = join(mobileDirectory, 'src/app/index.tsx');
const serverImporter = join(serverDirectory, 'app/(auth)/layout.tsx');

const origins = [
  ['mobile', mobileImporter],
  ['Expo Router', Bun.resolveSync('expo-router/entry', mobileImporter)],
  ['server', serverImporter],
  ['Next', Bun.resolveSync('next', serverImporter)],
] as const;

const mobileManifest = await readManifest(
  join(mobileDirectory, 'package.json'),
);

for (const packageName of runtimePackages) {
  const expectedVersion = mobileManifest.dependencies?.[packageName];

  if (expectedVersion === undefined) {
    throw new Error(`Mobile must declare an exact ${packageName} version`);
  }

  let expectedRealPath: string | undefined;

  for (const [originName, importerPath] of origins) {
    const manifestPath = Bun.resolveSync(
      `${packageName}/package.json`,
      importerPath,
    );
    const manifest = await readManifest(manifestPath);
    const realPath = realpathSync(manifestPath);

    if (manifest.version !== expectedVersion) {
      throw new Error(
        `${originName} resolves ${packageName}@${String(manifest.version)}; expected ${expectedVersion}`,
      );
    }

    expectedRealPath ??= realPath;
    if (realPath !== expectedRealPath) {
      throw new Error(
        `${originName} resolves a second physical ${packageName} installation`,
      );
    }
  }
}

console.log('React and ReactDOM resolve to one shared mobile/server runtime.');
