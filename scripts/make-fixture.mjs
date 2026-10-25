// Generates fixtures/sample_contract.pdf — a fictional Swiss employment contract full of (fake) PII.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const pages = [
  [
    ['ARBEITSVERTRAG', 'title'],
    [''],
    ['zwischen'],
    ['Brunner & Keller Treuhand AG, Rosenbergstrasse 30, 9000 St. Gallen'],
    ['vertreten durch Petra Vogel, Leiterin Personal (petra.vogel@bk-treuhand.ch, Tel. 071 222 33 44)'],
    ['nachfolgend "Arbeitgeberin"'],
    [''],
    ['und'],
    ['Herrn Lukas Brunner, geboren am 14.07.1988, wohnhaft Bahnhofstrasse 12, 9000 St. Gallen'],
    ['AHV-Nummer: 756.1234.5678.97, Personalnummer: BK-20931'],
    ['nachfolgend "Arbeitnehmer"'],
    [''],
    ['1. Stelle und Beginn', 'h'],
    ['Der Arbeitnehmer tritt per 1. April 2021 als Senior Treuhänder in die Dienste der Arbeitgeberin.'],
    ['Arbeitsort ist St. Gallen. Die Probezeit beträgt drei Monate.'],
    [''],
    ['2. Lohn', 'h'],
    ["Der Bruttolohn beträgt CHF 7'850.– pro Monat, zahlbar 13 Mal jährlich, auf das Konto"],
    ['IBAN CH93 0076 2011 6238 5295 7 bei der St. Galler Kantonalbank.'],
    [''],
    ['3. Lohnfortzahlung bei Krankheit', 'h'],
    ['Bei unverschuldeter Arbeitsverhinderung infolge Krankheit besteht eine Krankentaggeldversicherung'],
    ['bei der Helvetia Versicherungen AG (Policen-Nr. KT-448812-07). Diese deckt 80% des Lohnes während'],
    ['730 Tagen nach einer Wartefrist von 30 Tagen. Während der Wartefrist bezahlt die Arbeitgeberin 100%.'],
    ['Ein Arztzeugnis ist ab dem dritten Krankheitstag unaufgefordert einzureichen.'],
    [''],
    ['4. Kündigung', 'h'],
    ['Nach der Probezeit beträgt die Kündigungsfrist im ersten Dienstjahr einen Monat, im zweiten bis neunten'],
    ['Dienstjahr zwei Monate, jeweils auf das Ende eines Monats. Es gelten die Sperrfristen nach Art. 336c OR:'],
    ['bei Krankheit ab dem zweiten bis fünften Dienstjahr 90 Tage.'],
  ],
  [
    ['5. Ferien und Arbeitszeit', 'h'],
    ['Der Arbeitnehmer hat Anspruch auf 25 Arbeitstage Ferien pro Jahr. Die Arbeitszeit beträgt 42 Stunden.'],
    [''],
    ['6. Wiedereingliederung', 'h'],
    ['Nach längerer Krankheit vereinbaren die Parteien einen stufenweisen Wiedereinstieg in Absprache mit dem'],
    ['behandelnden Arzt. Die Arbeitgeberin kann einen Vertrauensarzt beiziehen.'],
    [''],
    ['7. Schlussbestimmungen', 'h'],
    ['Änderungen bedürfen der Schriftform. Gerichtsstand ist St. Gallen.'],
    [''],
    ['St. Gallen, 15. März 2021'],
    [''],
    ['Petra Vogel                                              Lukas Brunner'],
    ['Brunner & Keller Treuhand AG                         Arbeitnehmer'],
    [''],
    [''],
    ['Anhang: Arztzeugnis', 'h'],
    ['Klinik Hirslanden, Witellikerstrasse 40, 8008 Zürich'],
    ['Dr. med. Sabine Odermatt, FMH Psychiatrie (s.odermatt@hirslanden-example.ch)'],
    [''],
    ['Patient: Lukas Brunner, geb. 14.07.1988, Patienten-Nr. 4402819'],
    ['Diagnose: Erschöpfungsdepression (Burnout), ICD-10 F43.0'],
    ['Arbeitsunfähigkeit: 100% vom 03.02.2026 bis 28.02.2026, voraussichtlich 50% ab 01.03.2026.'],
    [''],
    ['Zürich, 03.02.2026                    Dr. med. Sabine Odermatt'],
  ],
];

const doc = await PDFDocument.create();
doc.setTitle('Arbeitsvertrag Lukas Brunner');
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
for (const lines of pages) {
  const page = doc.addPage([595, 842]);
  let y = 790;
  for (const [text, style] of lines) {
    const f = style ? bold : font;
    const size = style === 'title' ? 18 : 10.5;
    page.drawText(text, { x: 60, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    y -= style === 'title' ? 26 : 16;
  }
}
writeFileSync(new URL('../fixtures/sample_contract.pdf', import.meta.url), await doc.save());
console.log('wrote fixtures/sample_contract.pdf');
