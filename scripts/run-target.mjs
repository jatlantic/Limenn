// node scripts/run-target.mjs firefox npm run build   → runs the command with LIMENN_TARGET=firefox (works on every OS).
import { spawnSync } from 'node:child_process';

const [target, cmd, ...args] = process.argv.slice(2);
const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, LIMENN_TARGET: target } });
process.exit(r.status ?? 1);
