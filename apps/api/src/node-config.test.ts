import { expect, test } from 'vitest';
import { nodeConfig } from './node-config.js';

test('local Architect remains loopback-only, including accidental container overrides', () => {
  expect(nodeConfig({})).toMatchObject({ profile: 'local', hostname: '127.0.0.1', port: 9312 });
  for (const HOST of ['127.0.0.1', 'localhost', '::1']) expect(nodeConfig({ HOST }).hostname).toBe(HOST);
  for (const HOST of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '']) {
    expect(() => nodeConfig({ HOST, UNITY_PUBLIC_ORIGIN: 'https://unity.example' })).toThrow('loopback');
  }
});

test('hub wildcard listeners still require an exact canonical HTTPS or loopback origin', () => {
  for (const HOST of ['0.0.0.0', '::', '127.0.0.1']) {
    const env = { HOST, UNITY_PROFILE: 'hub' };
    expect(() => nodeConfig(env)).toThrow('UNITY_PUBLIC_ORIGIN');
    for (const origin of ['http://unity.example', 'https://unity.example/path', 'https://unity.example/']) {
      expect(() => nodeConfig({ ...env, UNITY_PUBLIC_ORIGIN: origin })).toThrow('origin');
    }
    for (const origin of ['https://unity.example', 'http://127.0.0.1:9312']) {
      expect(nodeConfig({ ...env, UNITY_PUBLIC_ORIGIN: origin }).publicOrigin).toBe(origin);
    }
  }
  expect(() => nodeConfig({ UNITY_PROFILE: 'typo', HOST: '0.0.0.0' })).toThrow('UNITY_PROFILE');
  for (const PORT of ['NaN', '-1', '65536', '1.5']) expect(() => nodeConfig({ PORT })).toThrow('PORT');
});


test('signed sync is opt-in and requires an HTTPS hub origin', () => {
  expect(nodeConfig({}).syncEnabled).toBe(false);
  for (const value of ['1', 'yes', 'TRUE', '']) expect(() => nodeConfig({ UNITY_SYNC_ENABLED: value })).toThrow('UNITY_SYNC_ENABLED');
  expect(() => nodeConfig({ UNITY_SYNC_ENABLED: 'true' })).toThrow('HTTPS');
  expect(() => nodeConfig({ UNITY_PROFILE: 'hub', UNITY_PUBLIC_ORIGIN: 'http://127.0.0.1:9312', UNITY_SYNC_ENABLED: 'true' })).toThrow('HTTPS');
  expect(nodeConfig({ UNITY_PROFILE: 'hub', UNITY_PUBLIC_ORIGIN: 'https://unity.example', UNITY_SYNC_ENABLED: 'true' }).syncEnabled).toBe(true);
});

test('signed writes require a separate strict opt-in and enabled signed reads', () => {
  const env = { UNITY_PROFILE: 'hub', UNITY_PUBLIC_ORIGIN: 'https://unity.example', UNITY_SYNC_ENABLED: 'true' };
  expect(nodeConfig(env).syncWritesEnabled).toBe(false);
  expect(nodeConfig({ ...env, UNITY_SYNC_WRITES_ENABLED: 'true' }).syncWritesEnabled).toBe(true);
  expect(() => nodeConfig({ ...env, UNITY_SYNC_WRITES_ENABLED: 'yes' })).toThrow('UNITY_SYNC_WRITES_ENABLED');
  expect(() => nodeConfig({ ...env, UNITY_SYNC_ENABLED: 'false', UNITY_SYNC_WRITES_ENABLED: 'true' })).toThrow('UNITY_SYNC_ENABLED');
});
