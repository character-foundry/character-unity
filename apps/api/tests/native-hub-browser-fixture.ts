import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openLocalServices } from '../src/services.js';

// Operator-only bootstrap against a fresh scratch directory, never an HTTP route.
const [directory, credentialsPath] = process.argv.slice(2);
if (!directory || !credentialsPath) throw new Error('Isolated directory and credentials output are required');
const databasePath = join(directory, 'unity.db'), blobDirectory = join(directory, 'blobs');
const services = await openLocalServices({ databasePath, blobDirectory });
try {
  const accounts = {} as Record<string, unknown>;
  for (const name of ['Alice', 'Bob']) {
    const credentials = await services.accounts.create(name);
    const actor = { id: credentials.account.id, uri: credentials.account.uri };
    const library = await services.cards.createWorkspace(actor, 'Library');
    const second = await services.cards.createWorkspace(actor, 'Second desk');
    accounts[name] = { ...credentials, workspaces: { library: library.id, second: second.id } };
  }
  await writeFile(credentialsPath, JSON.stringify({ accounts, databasePath, blobDirectory }), { mode: 0o600, flag: 'wx' });
} finally { services.close(); }
