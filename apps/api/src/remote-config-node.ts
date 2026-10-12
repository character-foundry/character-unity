import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseRemoteConnections, remoteConfigurationLimit } from './remote-config.js';

/** Operator-only startup file. Browser requests never select a path or supply private keys. */
export async function loadRemoteConnections(path?: string) {
  if (path === undefined) return [];
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!path.trim()) throw new Error();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > remoteConfigurationLimit) throw new Error();
    const buffer = Buffer.alloc(remoteConfigurationLimit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > remoteConfigurationLimit) throw new Error();
    return await parseRemoteConnections(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { throw new Error('Remote configuration could not be loaded; use a valid, owner-only regular JSON file'); }
  finally { await file?.close(); }
}
