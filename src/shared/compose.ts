import { PREAMBLE } from '../pii/pipeline';
import type { JobState } from './jobs';
import type { OutgoingFile } from './messages';

/**
 * What actually goes into the chat's composer: preamble + cleaned prompt, cleaned files as .txt attachments.
 * With `inline`, the cleaned documents are written into the message instead (when the site refuses uploads,
 * e.g. ChatGPT without an account).
 */
export function composeMessage(job: JobState, opts: { inline?: boolean } = {}): { text: string; files: OutgoingFile[] } {
  const prompt = job.items.find((i) => i.kind === 'prompt');
  const files = job.items
    .filter((i) => i.kind === 'file' && i.clean)
    .map((i) => ({ name: i.name.replace(/\.[^.]+$/, '') + (job.unprotected ? '.txt' : '.redacted.txt'), content: i.clean, mime: 'text/plain' }));
  // Without protection there are no placeholders to explain.
  const preamble = job.unprotected ? '' : `${PREAMBLE}\n\n`;
  if (opts.inline && files.length) {
    const docs = files.map((f) => `<document name="${f.name.replace(/\.redacted\.txt$/, '')}">\n${f.content}\n</document>`).join('\n\n');
    const body = prompt?.clean || 'Please review the document(s) below.';
    return { text: `${preamble}${body}\n\n${docs}`, files: [] };
  }
  const body = prompt?.clean || 'Please review the attached document(s).';
  return { text: `${preamble}${body}`, files };
}

export const protectedCount = (job: JobState) => job.items.reduce((a, i) => a + i.entities.length, 0);
