// node scripts/run-target.mjs firefox npm run build   → runs the command with LIMENN_TARGET=firefox (works on every OS).
import { spawnSync } from 'node:child_process';

const [spec, cmd, ...args] = process.argv.slice(2);
const [target, lite] = spec.split('-'); // 'firefox-lite' = Firefox without the second detector
const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, LIMENN_TARGET: target, LIMENN_LITE: lite === 'lite' ? '1' : '' } });
process.exit(r.status ?? 1);
