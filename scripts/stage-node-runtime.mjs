import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

// Copy locked native dependencies from each parent to preserve versions. Archive
// gets its own image; LanceDB and Arrow do not enter the API/browser runtimes.
const target = process.argv[2];
const profile = process.argv[3] ?? 'api';
if (!target || !['api', 'archive'].includes(profile) || process.argv.length > 4) throw new Error('Pass a new runtime output directory and optional api|archive profile');
const output = resolve(target);
await mkdir(output); // Refuse to merge with or remove an existing directory.
async function manifestFor(name, from) {
  const require = createRequire(from);
  try { return require.resolve(`${name}/package.json`); }
  catch (error) {
    // Some export maps reject package.json, others wildcard-map it to a missing
    // package.json.js (Arrow). Resolve the real entrypoint in either case.
    if (!['ERR_PACKAGE_PATH_NOT_EXPORTED', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
    let directory = dirname(require.resolve(name));
    while (true) {
      const file = join(directory, 'package.json');
      try { if (JSON.parse(await readFile(file, 'utf8')).name === name) return file; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate manifest for ${name}`, { cause: error });
      directory = parent;
    }
  }
}
async function copyDependency(name, from, modules) {
  const manifestPath = await manifestFor(name, from);
  const source = dirname(manifestPath), destination = join(modules, name);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await cp(source, destination, { recursive: true,
    filter: (path) => relative(source, path).split(/[\\/]/)[0] !== 'node_modules' });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyDependency(dependency, manifestPath, join(destination, 'node_modules'));
  }
  return manifestPath;
}
const modules = join(output, 'node_modules'), from = resolve(`apps/${profile}/package.json`);
await copyDependency('better-sqlite3', from, modules);
await writeFile(join(output, 'package.json'), JSON.stringify({ name: `character-unity-${profile}-runtime`, private: true, type: 'module' }) + '\n');
if (profile === 'archive') {
  // The image is Debian/glibc. Fail on unsupported build platforms rather than
  // silently produce an image without its native library. No embedding extras.
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Archive staging requires Linux x64 or arm64');
  const lance = await copyDependency('@lancedb/lancedb', from, modules);
  await copyDependency(`@lancedb/lancedb-linux-${process.arch}-gnu`, lance, modules);
  await copyDependency('apache-arrow', from, modules);
  for (const name of ['node.js', 'native-rehearsal.js', 'generation-cli.js']) await cp(`apps/archive/dist/${name}`, join(output, name));
} else {
  for (const name of ['node.js', 'accounts-cli.js', 'peers-cli.js', 'assets-cli.js']) await cp(`apps/api/dist/${name}`, join(output, name));
  for (const name of ['architect', 'hub']) await cp(`apps/${name}/dist`, join(output, 'web', name), { recursive: true });
  await cp('foundry-sdk.json', join(output, 'foundry-sdk.json'));
}
