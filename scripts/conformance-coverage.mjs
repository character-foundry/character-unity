import { readFile, writeFile } from 'node:fs/promises';

const report = JSON.parse(await readFile('runtime/test-results.json', 'utf8'));
const assertions = report.testResults.flatMap((file) => file.assertionResults);
for (const contract of [
  { name: 'asset-maintenance', requirements: 'packages/store/tests/conformance/asset-maintenance-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'store', requirements: 'packages/store/tests/conformance/requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'hub', requirements: 'packages/store/tests/conformance/hub-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'chat', requirements: 'packages/store/tests/conformance/chat-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'statistics', requirements: 'packages/store/tests/conformance/statistics-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'meta-tags', requirements: 'packages/store/tests/conformance/meta-tags-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'content', requirements: 'packages/store/tests/conformance/content-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'accounts', requirements: 'packages/store/tests/conformance/accounts-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'sync', requirements: 'packages/store/tests/conformance/sync-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'sync-operations', requirements: 'packages/store/tests/conformance/sync-operations-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'sync-outbox', requirements: 'packages/store/tests/conformance/sync-outbox-requirements.json', drivers: ['sqlite', 'd1'], labels: 'SQLite | Local D1' },
  { name: 'blob', requirements: 'packages/blob-store/tests/requirements.json', drivers: ['node', 'r2'], labels: 'Filesystem | Local R2' },
  { name: 'archive', version: 'v1', requirements: 'packages/archive-client/tests/requirements.json', drivers: ['fixture'], labels: 'Fixture read service/client' },
]) {
  const requirements = JSON.parse(await readFile(contract.requirements, 'utf8'));
  const lines = [`# ${contract.name} conformance — internal contract ${contract.version ?? 'v0.1'}`, '', `| Requirement (MUST) | ${contract.labels} |`, `|${Array(contract.drivers.length + 1).fill('---').join('|')}|`];
  let passing = 0;
  let total = 0;
  for (const [id, description] of Object.entries(requirements)) {
    const verdicts = contract.drivers.map((driver) => {
      const matches = assertions.filter((test) => test.fullName.includes(`${contract.name} contract / ${driver}`) && test.title.startsWith(`[${id}]`));
      total++;
      if (matches.length === 1 && matches[0].status === 'passed') { passing++; return 'PASS'; }
      return matches.length === 1 ? matches[0].status.toUpperCase() : `MISSING OR DUPLICATE (${matches.length})`;
    });
    lines.push(`| ${id}: ${description} | ${verdicts.join(' | ')} |`);
  }
  lines.push('', `${passing}/${total} required driver checks passed.`, '',
    'This report covers the named internal contract, not remote deployment, authorization, Foundry identity or live Archive adoption.');
  await writeFile(`runtime/${contract.name}-conformance.md`, `${lines.join('\n')}\n`);
  console.log(`${contract.name} conformance: ${passing}/${total}; report: runtime/${contract.name}-conformance.md`);
  if (passing !== total) process.exitCode = 1;
}
