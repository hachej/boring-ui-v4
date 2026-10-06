import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCaptured as spawnSync } from '../../scripts/run-captured.mjs';
import test from 'node:test';
import { isContractOnly } from '../../scripts/is-contract-only.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

for (const name of ['files', 'agent', 'execution', 'ui', 'browser']) {
  test(`${name}: public declarations exist and type-only exports stay runtime-free`, async () => {
    const dir = join(root, 'packages', name);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const [subpath, entry] of Object.entries(manifest.exports)) {
      assert.ok(existsSync(join(dir, entry.types)), entry.types);
      assert.ok(existsSync(join(dir, entry.import)), entry.import);
      const source = entry.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
      if (existsSync(join(dir, source)) && isContractOnly(source, readFileSync(join(dir, source), 'utf8'))) {
        const js = readFileSync(join(dir, entry.import), 'utf8').replace(/^\/\/.*$/gm, '').trim();
        assert.equal(js, 'export {};', `${name}/${subpath}: erased types unexpectedly emit implementation`);
        const specifier = manifest.name + (subpath === '.' ? '' : subpath.slice(1));
        assert.deepEqual(Object.keys(await import(specifier)), [], specifier);
      }
      // Real implementations can land with their required proofs. This test
      // must not permanently freeze packages into empty interface-only output.
    }
    assert.ok(readdirSync(join(dir, 'dist')).some((file) => file.endsWith('.d.ts')));
  });
}

test('all five packages can be packed with declarations, without raw source or env files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boring-pack-'));
  try {
    for (const name of ['files', 'agent', 'execution', 'ui', 'browser']) {
      const result = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: join(root, 'packages', name), encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
      const packed = JSON.parse(result.stdout)[0];
      assert.ok(existsSync(join(dir, packed.filename)));
      assert.ok(packed.files.some((file) => file.path === 'dist/index.d.ts'));
      assert.ok(packed.files.every((file) => !file.path.startsWith('src/') && !file.path.includes('.env')));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
