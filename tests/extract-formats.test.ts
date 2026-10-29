import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { emlText, extractText, htmlText, rtfText } from '../src/docvault/extract';
import { composeMessage } from '../src/shared/compose';
import type { JobState } from '../src/shared/jobs';

const enc = (s: string) => new TextEncoder().encode(s);

describe('document formats', () => {
  it('reads RTF with escapes and drops the font table', () => {
    const t = rtfText("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Sehr geehrte Frau M\\'fcller,\\par IBAN CH93 0076 2011 6238 5295 7\\par Gr\\u252?sse}");
    expect(t).toBe('Sehr geehrte Frau Müller,\nIBAN CH93 0076 2011 6238 5295 7\nGrüsse');
  });
  it('reads HTML without scripts and styles', () => {
    expect(htmlText('<style>p{}</style><p>Anna&nbsp;Meier</p><script>x()</script><div>Zürich</div>')).toBe('Anna Meier\nZürich');
  });
  it('reads e-mails: decoded headers, quoted-printable body, attachment names', () => {
    const eml = [
      'From: =?UTF-8?Q?J=C3=BCrg_Keller?= <juerg@keller.ch>', 'To: anna@meier.ch', 'Subject: Vertrag', 'Content-Type: multipart/mixed; boundary="b1"', '',
      '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Gr=C3=BCezi Anna, anbei der Vertrag.', '',
      '--b1', 'Content-Type: application/pdf; name="vertrag.pdf"', 'Content-Disposition: attachment; filename="vertrag.pdf"', '', 'JVBERi0=', '--b1--',
    ].join('\r\n');
    const t = emlText(eml);
    expect(t).toContain('From: Jürg Keller <juerg@keller.ch>');
    expect(t).toContain('Grüezi Anna, anbei der Vertrag.');
    expect(t).toContain('[attachments: vertrag.pdf]');
  });
  it('reads Excel sheets and PowerPoint slides', async () => {
    const x = new JSZip();
    x.file('xl/workbook.xml', '<workbook><sheets><sheet name="Lohn" sheetId="1"/></sheets></workbook>');
    x.file('xl/sharedStrings.xml', '<sst><si><t>Name</t></si><si><t>Anna Meier</t></si></sst>');
    x.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>7450</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>');
    const xl = await extractText('lohn.xlsx', await x.generateAsync({ type: 'uint8array' }), { pdfjs: null });
    expect(xl.text).toBe('--- Sheet Lohn ---\nName\t7450\nAnna Meier');
    const p = new JSZip();
    p.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>Zweite</a:t></a:r></a:p></p:sld>');
    p.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>Mandant: </a:t></a:r><a:r><a:t>Anna Meier</a:t></a:r></a:p></p:sld>');
    const pp = await extractText('deck.pptx', await p.generateAsync({ type: 'uint8array' }), { pdfjs: null });
    expect(pp.text).toBe('--- Slide 1 ---\nMandant: Anna Meier\n\n--- Slide 2 ---\nZweite');
  });
  it('explains that images need OCR when none is available', async () => {
    await expect(extractText('scan.png', enc('x'), { pdfjs: null })).rejects.toThrow(/OCR/);
  });
});

describe('composeMessage', () => {
  const job = { items: [
    { kind: 'prompt', clean: 'Fasse zusammen.' },
    { kind: 'file', name: 'brief.pdf', clean: 'Sehr geehrte [PERSON-1]' },
  ] } as unknown as JobState;
  it('attaches cleaned documents as files by default', () => {
    const m = composeMessage(job);
    expect(m.files.map((f) => f.name)).toEqual(['document-1.redacted.txt']);
    expect(m.text).not.toContain('[PERSON-1]');
  });
  it('writes them into the message when uploads are refused', () => {
    const m = composeMessage(job, { inline: true });
    expect(m.files).toEqual([]);
    expect(m.text).toContain('<document name="document-1">\nSehr geehrte [PERSON-1]\n</document>');
  });
});

describe('public places', () => {
  it('keeps countries and descriptions of them readable, but not cities or addresses', async () => {
    const { isPublicTerm } = await import('../src/pii/public-terms');
    for (const t of ['Schweiz', 'Hauptstadt der Schweiz', 'capital of France', "nord de l'Italie"]) expect(isPublicTerm(t)).toBe(true);
    for (const t of ['Zürich', 'Seestrasse 4', 'Hauptstadt der Kanton Zug']) expect(isPublicTerm(t)).toBe(false);
  });
});
