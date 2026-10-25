// Build the Chrome Web Store / GitHub Release package and check it before zipping:
//   node scripts/release.mjs          → release/limenn-<version>.zip
// Checks: manifest permissions, no source maps, no remote endpoints in shipped code, every model file matches its sha256.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import lock from '../models/models.lock.json' with { type: 'json' };
import { sha256File } from './fetch-models.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

run('npm', ['run', 'build']);
for (const f of ['LICENSE', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'DISCLAIMER.md']) copyFileSync(join(root, f), join(dist, f));
cpSync(join(root, 'licenses'), join(dist, 'licenses'), { recursive: true });

const problems = [];
const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const all = files(dist).map((f) => relative(dist, f));

// 1. Manifest: exactly the permissions the store listing justifies.
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const expect = (name, got, want) => JSON.stringify([...got].sort()) !== JSON.stringify([...want].sort()) && problems.push(`manifest ${name}: ${JSON.stringify(got)}`);
expect('permissions', manifest.permissions, ['sidePanel', 'storage', 'offscreen', 'alarms']);
expect('host_permissions', manifest.host_permissions, ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://claude.ai/*', 'https://grok.com/*']);
if (!/connect-src 'self'/.test(manifest.content_security_policy?.extension_pages ?? '')) problems.push('CSP must restrict connect-src');
if (manifest.version !== JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) problems.push('manifest and package.json versions differ');

// 2. No source maps, dev leftovers or stray files.
for (const f of all) if (/\.map$|\.DS_Store$|\.part$/.test(f)) problems.push(`unexpected file: ${f}`);

// 3. Shipped code must not contain remote endpoints the extension could call.
const FORBIDDEN = [/openrouter\.ai/, /api\/alpha\/decisions/, /sk-or-[a-z0-9]/i, /hf_[A-Za-z0-9]{20,}/];
for (const f of all.filter((f) => /\.(m?js|html|json)$/.test(f) && !f.startsWith('models/'))) {
  const text = readFileSync(join(dist, f), 'utf8');
  for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${f} contains ${re}`);
}

// 4. Models: present and unmodified.
for (const f of lock.files) {
  const p = join(dist, 'models', f.dest ?? f.path);
  if (f.optional && !statSync(p, { throwIfNoEntry: false })) { console.warn(`release without optional model ${f.dest ?? f.path}`); continue; }
  if ((await sha256File(p).catch(() => '')) !== f.sha256) problems.push(`model ${f.dest ?? f.path}: missing or hash mismatch`);
}

if (problems.length) {
  console.error(`Release check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

mkdirSync(join(root, 'release'), { recursive: true });
const zip = join(root, 'release', `limenn-${manifest.version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: dist, stdio: 'inherit' });
console.log(`release check passed (${all.length} files) → ${relative(root, zip)} (${(statSync(zip).size / 1e6).toFixed(0)} MB)`);
