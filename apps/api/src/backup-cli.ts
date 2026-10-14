import { backupNodeProfile, restoreNodeProfile, verifyNodeBackup } from './node-backup.js';

const usage = `Unity Node backup (operator-only; no live migration or activation)
  backup create --database FILE --blob-dir DIRECTORY --output NEW_DIRECTORY
  backup verify --input BACKUP_DIRECTORY
  backup restore --input BACKUP_DIRECTORY --output NEW_PROFILE_DIRECTORY

Create captures the SQLite snapshot and ready, non-retired Unity-owned files.
Archive bytes are NOT copied: inherited assets remain exact-version locators.
External Archive data, environment configuration and browser preferences are not included.
Quiesce uploads and asset maintenance while backing up; concurrent missing bytes fail
verification. Incomplete directories have no valid completion manifest.
Backups contain private cards, account/session and chat credentials. Protect them.
Restore requires a nonexistent directory, never overwrites or activates current data,
and never runs migrations. It produces unity.db and blobs/ for explicit later use.
Use matching Unity database/blob paths. No paths or defaults are inferred.
`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(usage); return; }
  if (!['create', 'verify', 'restore'].includes(command)) throw new Error('Unknown command; use --help');
  const allowed = command === 'create' ? ['database', 'blob-dir', 'output'] : command === 'verify' ? ['input'] : ['input', 'output'];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!, name = flag.slice(2), value = args[index + 1];
    if (!flag.startsWith('--') || !allowed.includes(name) || flags.has(name) || !value || value.startsWith('--')) throw new Error('Invalid or duplicate option; use --help');
    flags.set(name, value);
  }
  if (allowed.some((name) => !flags.has(name))) throw new Error(`Required options: ${allowed.map((name) => `--${name}`).join(', ')}`);
  let result: unknown;
  if (command === 'create') {
    const manifest = await backupNodeProfile({ database: flags.get('database')!, blobDirectory: flags.get('blob-dir')!, directory: flags.get('output')! });
    result = { status: 'complete', ownedAssets: manifest.blobs.length, archiveAssetLocators: manifest.archiveAssetLocators, schemaVersion: manifest.schemaVersion };
  } else if (command === 'verify') {
    const manifest = await verifyNodeBackup(flags.get('input')!);
    result = { status: 'verified', ownedAssets: manifest.blobs.length, archiveAssetLocators: manifest.archiveAssetLocators, schemaVersion: manifest.schemaVersion };
  } else result = { status: 'restored-not-activated', ...await restoreNodeProfile({ directory: flags.get('input')!, destination: flags.get('output')! }) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
try { await main(); } catch (error) {
  process.stderr.write(`Backup failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exitCode = 1;
}
