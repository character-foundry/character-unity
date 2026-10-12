import { hubOrigin } from '@character-unity/api/sessions';

export function nodeConfig(env: NodeJS.ProcessEnv) {
  const port = Number(env.PORT ?? 9312);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  const profile = env.UNITY_PROFILE ?? 'local';
  if (profile !== 'local' && profile !== 'hub') throw new Error('UNITY_PROFILE must be local or hub');
  const hostname = env.HOST ?? '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  if (!loopback && !(profile === 'hub' && ['0.0.0.0', '::'].includes(hostname))) {
    throw new Error('Local Architect requires a loopback HOST; only the hub profile supports wildcard container listeners');
  }
  const publicOrigin = env.UNITY_PUBLIC_ORIGIN;
  if (profile === 'hub') {
    if (!publicOrigin) throw new Error('The hub profile requires UNITY_PUBLIC_ORIGIN');
    hubOrigin(publicOrigin);
  }
  if (env.UNITY_REMOTE_CONNECTIONS_FILE !== undefined && (profile !== 'hub' || !env.UNITY_REMOTE_CONNECTIONS_FILE.trim())) throw new Error('Remote connections require the hub profile and a configuration file');
  if (env.UNITY_SYNC_ENABLED !== undefined && !['true', 'false'].includes(env.UNITY_SYNC_ENABLED)) throw new Error('UNITY_SYNC_ENABLED must be true or false');
  const syncEnabled = env.UNITY_SYNC_ENABLED === 'true';
  if (syncEnabled && (profile !== 'hub' || !publicOrigin?.startsWith('https://'))) throw new Error('Signed sync requires the hub profile with an HTTPS public origin');
  if (env.UNITY_SYNC_WRITES_ENABLED !== undefined && !['true', 'false'].includes(env.UNITY_SYNC_WRITES_ENABLED)) throw new Error('UNITY_SYNC_WRITES_ENABLED must be true or false');
  const syncWritesEnabled = env.UNITY_SYNC_WRITES_ENABLED === 'true';
  if (syncWritesEnabled && !syncEnabled) throw new Error('Signed writes require UNITY_SYNC_ENABLED=true');
  return { port, profile, hostname, publicOrigin, syncEnabled, syncWritesEnabled };
}
