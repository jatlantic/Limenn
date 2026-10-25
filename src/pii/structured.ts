// Extra structured detectors: dates in more languages/styles, identifiers (labelled and code-shaped),
// and person/organisation patterns that the cased NER model misses (lowercase chat names, ALL-CAPS headers,
// sign-offs, "SURNAME, Firstname", clinics, companies by legal form).
import type { Entity, EntityType } from './types';

const e = (text: string, start: number, end: number, type: EntityType, score = 0.95): Entity => ({
  start,
  end,
  text: text.slice(start, end),
  type,
  source: 'regex',
  score,
});

// ---------------- dates ----------------

const MONTH_NAMES = [
  // de / en
  'Januar', 'Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
  'January', 'February', 'March', 'May', 'June', 'July', 'October', 'December',
  // fr
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
  // it
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];
const MONTH_ABBR = ['Jan', 'Feb', 'Mär', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Okt', 'Oct', 'Nov', 'Dez', 'Dec', 'janv', 'févr', 'fév', 'avr', 'juil', 'déc', 'gen', 'giu', 'lug', 'ott', 'dic'];
const MONTH = `(?:${[...MONTH_NAMES].sort((a, b) => b.length - a.length).join('|')}|(?:${MONTH_ABBR.join('|')})\\.?)`;
const DAY = '(?:0?[1-9]|[12]\\d|3[01])';
const ORD = '(?:\\.|er|e|st|nd|rd|th|°)?';
const YEAR = '(?:19|20)\\d{2}';
const NB = '(?<![\\p{L}\\p{N}])';
const NA = '(?![\\p{L}\\p{N}])';

const DATE_RES = [
  // 20 mars 2026 · 1er août 2025 · 24th September 2026 · 3. März · il 3 marzo
  new RegExp(`${NB}${DAY}${ORD}\\s?(?:de\\s|of\\s)?${MONTH}(?:,?\\s${YEAR})?${NA}`, 'giu'),
  // September 24th, 2026 · July 11, 1974 · March 3rd
  new RegExp(`${NB}${MONTH}\\s${DAY}(?:st|nd|rd|th)?(?:,?\\s${YEAR})?${NA}`, 'gu'),
  // 05.01.26 · 27/10/93 (2-digit year)
  new RegExp(`(?<![\\p{L}\\p{N}.])${DAY}[./](?:0?[1-9]|1[0-2])[./]\\d{2}(?![\\d./])`, 'gu'),
  // US 01/16/2026
  new RegExp(`${NB}(?:0?[1-9]|1[0-2])/${DAY}/${YEAR}${NA}`, 'gu'),
  // 2026/03/01
  new RegExp(`${NB}${YEAR}/(?:0?[1-9]|1[0-2])/${DAY}${NA}`, 'gu'),
  // US short 3/14/26
  new RegExp(`(?<![\\p{L}\\p{N}./])(?:0?[1-9]|1[0-2])/(?:1[3-9]|2\\d|3[01])/\\d{2}(?![\\d./])`, 'gu'),
  // month/year periods (CVs, contracts): 03/2019, 3.2019, März 2019, mars 2019, marzo 2019
  new RegExp(`(?<![\\p{L}\\p{N}./])(?:0?[1-9]|1[0-2])[./](?:19|20)\\d{2}(?![\\d./])`, 'gu'),
  new RegExp(`${NB}(?:${[...MONTH_NAMES].sort((a, b) => b.length - a.length).join('|')})\\s${YEAR}${NA}`, 'giu'),
];

// A bare year is a quasi-identifier when the context makes it a date about someone:
// "born in 1974", "seit 2019", "depuis 2015", "between 1982 and 1984", "1982–1984", "zwischen 1982 und 1984".
const Y = '(?:19|20)\\d{2}';
const YEAR_CONTEXT = new RegExp(
  `${NB}(?:born in|born|since|until|till|from|in|during|geboren|seit|bis|von|im jahr|im jahre|ab|né en|née en|nés en|depuis|jusqu'en|en|dès|nato nel|nata nel|dal|fino al|nel|durante)[ \\t]+(${Y})${NA}`,
  'giu',
);
const YEAR_RANGE = new RegExp(
  `${NB}(?:between[ \\t]+${Y}[ \\t]+and[ \\t]+${Y}|zwischen[ \\t]+${Y}[ \\t]+und[ \\t]+${Y}|entre[ \\t]+${Y}[ \\t]+et[ \\t]+${Y}|tra[ \\t]+il[ \\t]+${Y}[ \\t]+e[ \\t]+il[ \\t]+${Y}|${Y}[ \\t]?[–-][ \\t]?(?:${Y}|\\d{2}))${NA}`,
  'giu',
);

export function detectDates(text: string): Entity[] {
  const out: Entity[] = [];
  YEAR_RANGE.lastIndex = 0;
  for (const m of text.matchAll(YEAR_RANGE)) {
    // keep only the years ("between 1982 and 1984" → two DATE spans) so the sentence stays readable
    for (const y of m[0].matchAll(/(?:19|20)\d{2}|(?<=[–-][ \t]?)\d{2}(?!\d)/g)) out.push(e(text, m.index! + y.index!, m.index! + y.index! + y[0].length, 'DATE', 0.85));
  }
  YEAR_CONTEXT.lastIndex = 0;
  for (const m of text.matchAll(YEAR_CONTEXT)) {
    const s = m.index! + m[0].lastIndexOf(m[1]);
    out.push(e(text, s, s + 4, 'DATE', 0.8));
  }
  for (const re of DATE_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      // "Mai" / "mars" / "May" alone are common words; a bare "3 Mai" still counts, a month name alone never matches.
      out.push(e(text, m.index!, m.index! + m[0].length, 'DATE'));
    }
  }
  return out;
}

// ---------------- identifiers ----------------

const ID_LABELS = [
  'Rechnung(?:s)?', 'Invoice', 'Facture', 'Fattura', 'Bestell(?:ung)?', 'Order', 'Commande', 'Ordine', 'Auftrag(?:s)?', 'Ticket', 'Case', 'Fall', 'Dossier',
  'Pratica', 'Referenz', 'Ref\\.?', 'Réf\\.?', 'Riferimento', 'Rif\\.?', 'Kunden', 'Customer', 'Client', 'Cliente', 'Patient(?:en)?', 'Paziente', 'Matricule',
  'Matricola', 'Personal', 'Mitarbeiter', 'Employee', 'Staff', 'Vertrag(?:s)?', 'Contrat', 'Contract', 'Contratto', 'Police', 'Policy', 'Polizza', 'Policen',
  'Schaden(?:s)?', 'Claim', 'Sinistre', 'Sinistro', 'Mandat', 'Mandats', 'Akte', 'Akten', 'Konto', 'Account', 'Compte', 'Conto', 'Mitglied(?:s)?', 'Member',
  'Membre', 'Versicherten', 'Versicherungs', 'Assuré', 'Assicurato', 'Steuer', 'Tax', 'Fiscal', 'Contribuable', 'Contribuente', 'Passport', 'Pass', 'Passeport',
  'Passaporto', 'Ausweis', 'ID', 'Carte', 'Karte', 'Tessera', 'Kennzeichen', 'Plaque', 'Targa', 'Immatriculation', 'Fahrzeug', 'Vehicle', 'Véhicule', 'Veicolo',
  'Versichertenkarte', 'Krankenkassen', 'Insurance', 'Assurance', 'Assicurazione', 'Aktenzeichen', 'Geschäfts', 'Verfahrens', 'Procédure', 'Procedura',
  'Patient\\(e\\)', 'Sendung(?:s)?', 'Tracking', 'Lieferschein', 'Delivery', 'Livraison', 'Serien', 'Serial',
];
const ID_SUFFIX = '(?:[-\\s]?(?:nummer|nr\\.?|no\\.?|nº|n°|number|num\\.?|numéro|numero|id|ID|code|#))?';
const CODE = '([A-Z0-9][A-Z0-9\\-/.]*\\d[A-Z0-9\\-/.]*|\\d[\\d\\s]{3,}\\d)';
// "Invoice no. 2025-1088", "Kundennummer: 705077", "N° patient 834126", "Matricule: 64666", "numero pratica 2024/118"
const LABELLED_ID = new RegExp(`${NB}(?:(?:${ID_LABELS.join('|')})${ID_SUFFIX}(?![\\p{L}])|(?:N°|Nº|No\\.|Nr\\.|n°|nº|numéro|numero|Number)\\s?(?:de\\s|du\\s|di\\s|of\\s)?(?:${ID_LABELS.join('|')})?)\\s?[:#]?\\s?${CODE}`, 'giu');
// Code-shaped tokens without a label: W585016, T-35852, BL-87198, RA-9277, AB-48213-X
const CODE_ID = /(?<![\p{L}\p{N}\-/.])[A-Z]{1,3}-?\d{4,}(?:-[A-Z0-9]{1,4})?(?![\p{L}\p{N}])/gu;
const CODE_STOP = /^(?:ISO|EN|DIN|IEC|COVID|SARS|CVE|RFC|ART|CHE|UID|IP|TCP|USB|HDMI|PCIE?|DDR|RTX|GTX|GPT|LTE|AHV|AVS|CH|DE|FR|IT|AT|Q|H)-?\d/;

function stripCode(v: string) {
  return v.replace(/[.\-/\s]+$/, '');
}

// Court and case numbers: Swiss Federal Court "4A_123/2020", "6B_1234/2019"; ECHR-style "nos. 511 and 513".
const COURT_REFS: RegExp[] = [
  /(?<![\p{L}\p{N}])\d[A-Z]_\d{1,5}\/(?:19|20)\d{2}(?![\p{N}])/gu,
  /(?<![\p{L}\p{N}])(?:[A-Z]{1,3}\.)?(?:19|20)\d{2}\.\d{1,5}(?:\.[A-Z0-9]{1,4})?(?![\p{N}.])(?=[^\n]{0,40}(?:Urteil|arrêt|sentenza|Entscheid|décision|decisione|Verfahren|procédure|procedura|Dossier|dossier))/gu,
];
const PLURAL_NOS = /(?<![\p{L}])(?:nos|Nos|Nrn|n°s)\.?[ \t]*\d{2,6}(?:\/\d{2,4})?(?:[ \t]*(?:,|and|und|et|e)[ \t]*\d{2,6}(?:\/\d{2,4})?)+/gu;

// Swiss plates "ZH 123456", "TI 98765" (≥3 digits); health card numbers (20 digits, 807…); GLN (13 digits, 76…);
// ZSR numbers (letter + 6 digits); VIN-like frame numbers.
const CANTONS = 'AG|AI|AR|BE|BL|BS|FR|GE|GL|GR|JU|LU|NE|NW|OW|SG|SH|SO|SZ|TG|TI|UR|VD|VS|ZG|ZH|FL';
const OTHER_IDS: RegExp[] = [
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${CANTONS})[ \\t]?\\d{3,6}(?![\\p{L}\\p{N}'’.,])`, 'gu'),
  /(?<![\d])807\d{2}[ ]?\d{4}[ ]?\d{4}[ ]?\d{4}[ ]?\d{3}(?!\d)/g,
  /(?<![\d])76\d{11}(?!\d)/g,
  /(?<![\p{L}\p{N}])[A-Z]\d{6}(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}(?![\p{L}\p{N}])/gu,
];

export function detectIds(text: string): Entity[] {
  const out: Entity[] = [];
  for (const re of COURT_REFS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push(e(text, m.index!, m.index! + m[0].length, 'ID_NUMBER', 0.9));
  }
  PLURAL_NOS.lastIndex = 0;
  for (const m of text.matchAll(PLURAL_NOS)) {
    for (const n of m[0].matchAll(/\d{2,6}(?:\/\d{2,4})?/g)) out.push(e(text, m.index! + n.index!, m.index! + n.index! + n[0].length, 'ID_NUMBER', 0.9));
  }
  for (const re of OTHER_IDS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      // "BE 2025" / "AG 1000"-like year or postcode-looking matches are too ambiguous.
      if (/^(?:[A-Z]{2})[ \t]?(?:19|20)\d{2}$/.test(m[0]) || /^[A-Z]{2}[ \t]?\d{4}$/.test(m[0])) continue;
      out.push(e(text, m.index!, m.index! + m[0].length, 'ID_NUMBER', 0.85));
    }
  }
  LABELLED_ID.lastIndex = 0;
  for (const m of text.matchAll(LABELLED_ID)) {
    const code = stripCode(m[1]);
    if ((code.match(/\d/g) ?? []).length < 3 || /^(?:19|20)\d{2}$/.test(code)) continue; // too short, or just a year
    if (/^756[.\s]?\d{4}/.test(code) || /^[A-Z]{2}\d{2}[\s]?[A-Z0-9]{4}/.test(code)) continue; // AHV / IBAN have their own rules
    const start = m.index! + m[0].lastIndexOf(m[1]);
    out.push(e(text, start, start + code.length, 'ID_NUMBER'));
  }
  CODE_ID.lastIndex = 0;
  for (const m of text.matchAll(CODE_ID)) {
    if (CODE_STOP.test(m[0])) continue;
    out.push(e(text, m.index!, m.index! + m[0].length, 'ID_NUMBER', 0.85));
  }
  return out;
}

// ---------------- people & organisations ----------------

const NAME_WORD = "[\\p{L}][\\p{L}'’-]+";
const NOT_NAMES = new Set(
  (
    'team all everyone zusammen tous toutes tutti everybody folks support kundendienst service customer kunde client cliente bot agent admin ' +
    'parent parents colleague colleagues customers clients member members user users patient patients applicant applicants valued friend friends ' +
    'neighbour neighbours eltern kollege kollegin kollegen kunden mitglieder nutzer patientin parents collègue collègues clients membres genitori colleghi ' +
    'herr frau mr mrs ms dr prof monsieur madame signor signora sir madam liebe lieber dear hi hello hallo bonjour salut ciao ' +
    'and und et e or oder from aus von de da di at in bei with mit i ich je io the der die das le la il les une un a an my mein ma mon mio ' +
    'thanks danke merci grazie regards grüsse grüße gruss gruß cordialement saluti best kind sincerely yours responsable rh hr manager ceo ' +
    'confidential vertraulich confidentiel riservato'
  ).split(' '),
);

const trimName = (words: string[]) => {
  const keep: string[] = [];
  for (const w of words) {
    if (NOT_NAMES.has(w.toLowerCase().replace(/[.,]$/, ''))) break;
    keep.push(w);
  }
  return keep;
};

function pushName(out: Entity[], text: string, start: number, raw: string, score = 0.9) {
  const words = trimName(raw.trim().split(/\s+/)).slice(0, 4);
  if (!words.length) return;
  const value = words.join(' ').replace(/[.,;:]+$/, '');
  if (value.length < 2 || /\d/.test(value)) return;
  out.push(e(text, start, start + value.length, 'PERSON', score));
}

// "hi, this is steven murphy", "hallo, hier ist eduard burri", "c'est julie", "sono marco rossi"
// Only right after a greeting, at a line start or after a chat speaker — not "It's super easy", "This is to notify you".
const INTRO = new RegExp(
  `(?:(?:^|\\n)[ \\t]*|(?:hi|hello|hey|hallo|hoi|grüezi|bonjour|salut|ciao|buongiorno|buonasera)[,!]?[ \\t]+|:[ \\t]*)(?:this is|it's|it is|here is|hier ist|hier spricht|ici|c'est|moi c'est|je suis|sono|qui è|qui parla)[ \\t]+(${NAME_WORD}(?:[ \\t]${NAME_WORD}){0,2})(?=[ \\t]*(?:[,.!?:;)]|\\n|$|here|hier|ici|qui|from|von|de|da))`,
  'giu',
);
// "Hi Steven," "Hallo janine," "Dear Ms Meier," "Liebe Frau Huber," "Bonjour Claire," "Ciao Luca,"
const GREETING = new RegExp(
  `(?:^|\\n|[:>)][ \\t])[ \\t]*(?:Hi|Hello|Hey|Hallo|Hoi|Grüezi|Liebe|Lieber|Dear|Bonjour|Salut|Coucou|Ciao|Caro|Cara|Gentile|Buongiorno|Sehr geehrte|Sehr geehrter)\\s+(?:(?:Frau|Herr|Ms\\.?|Mr\\.?|Mrs\\.?|Dr\\.?|Madame|Monsieur|Signora|Signor)\\s+)?(${NAME_WORD}(?:[ \\t]${NAME_WORD})?)\\s*[,!]`,
  'gu',
);
// "Danke, Eduard!" "Thanks Mia," "Merci, Julie." "Grazie Luca!"
const THANKS = new RegExp(`(?<![\\p{L}])(?:Danke|Merci|Thanks|Thank you|Grazie|Vielen Dank|Merci beaucoup|Grazie mille)[ \\t]?,?[ \\t](\\p{Lu}[\\p{Ll}'’-]+)[ \\t]?[!,.]`, 'gu');
// Name alone on the line after a sign-off.
const SIGNOFF = new RegExp(
  `(?:^|\\n)\\s*(?:Viele Grüsse|Viele Grüße|Liebe Grüsse|Liebe Grüße|Freundliche Grüsse|Freundliche Grüße|Mit freundlichen Grüssen|Mit freundlichen Grüßen|Beste Grüsse|Beste Grüße|Herzliche Grüsse|Gruss|Gruß|Grüsse|LG|MfG|Best regards|Kind regards|Warm regards|Regards|Best|Cheers|Thanks|Thank you|Many thanks|Cordialement|Bien cordialement|Meilleures salutations|Salutations|Bien à vous|À bientôt|Merci|Cordiali saluti|Distinti saluti|Saluti|Un saluto|Grazie)\\s*[,!.]?[ \\t]*\\n[ \\t]*(${NAME_WORD}(?:[ \\t]${NAME_WORD}){0,2})[ \\t]*(?=\\n|$)`,
  'giu',
);
// Email headers: "From: Steven Murphy <…>", "An: Janine Hafner <…>", "De : Irina Gähwiler <…>"
const HEADER = new RegExp(`(?:^|\\n)\\s*(?:From|To|Cc|Bcc|Von|An|Kopie|De|À|A|Da|Absender|Empfänger|Expéditeur|Destinataire|Mittente|Destinatario)[ \\t]?:[ \\t]*(${NAME_WORD}(?:[ \\t]${NAME_WORD}){0,3})\\s*<`, 'gu');
// Labelled name fields, incl. ALL CAPS and "SURNAME, Firstname"
const NAME_FIELD = new RegExp(
  `(?:^|\\n|\\|)\\s*(?:Name|Nom|Nome|Vorname|Nachname|Prénom|Cognome|Patient|Patientin|Patient\\(e\\)|PATIENT|PATIENTE|Paziente|Employee|Mitarbeiter|Mitarbeiterin|Collaborateur|Collaboratrice|Mieter|Mieter/in|Mieterin|Locataire|Inquilino|Vermieter|Bailleur|Bailleresse|Locatore|Kunde|Kundin|Client|Cliente|Customer|Antragsteller|Antragstellerin|Requérant|Richiedente|Versicherte|Versicherter|Assuré|Assurée|Assicurato|Schüler|Schülerin|Élève|Allievo|Allieva|Kind|Enfant|Bambino|Arzt|Ärztin|Médecin|Medico|Zeuge|Témoin|Testimone|Beschuldigte|Beschuldigter|Prévenu|Imputato|Contact|Kontakt|Contatto|Unterzeichnet|Signé|Firmato|Vorgesetzte|Vorgesetzte/r|Supérieur|Supérieur\\(e\\)|Superiore)[ \\t]?:[ \\t]*((?:${NAME_WORD},?[ \\t]?){1,4})`,
  'gu',
);
// "BOURCARD, Zoey" · "RIVIÈRE, Claude"
const INVERTED = /(?<![\p{L}])(\p{Lu}[\p{Lu}'’-]{1,}),\s(\p{Lu}[\p{Ll}'’-]+)(?![\p{L}])/gu;
// "M. Rossi", "J.-P. Favre", "A. B. Keller"
const INITIALS = /(?<![\p{L}.])(?:\p{Lu}\.(?:-?\p{Lu}\.)?[ \t]?){1,2}\p{Lu}[\p{Ll}'’-]{2,}(?:-\p{Lu}[\p{Ll}'’-]+)?(?![\p{L}])/gu;
// Honorific + name: "Herrn Kowalczyk", "Mme Rochat", "sig.ra Bernasconi", "avv. Pedrazzini", "RA Dr. Meier"
const HONORIFIC_NAME = new RegExp(
  `(?<![\\p{L}])(?:Herrn?|Frau|Hr\\.|Fr\\.|Mr\\.?|Mrs\\.?|Ms\\.?|Mme\\.?|Mlle|Monsieur|Madame|Signora|Signor|Sig\\.ra|Sig\\.|sig\\.ra|sig\\.|Dott\\.(?:ssa)?|dott\\.(?:ssa)?|avv\\.|Avv\\.|RA|Me|Maître|lic\\. iur\\.)[ \\t]+(?:(?:Dr\\.|Prof\\.|med\\.|dott\\.)[ \\t]+)*(\\p{Lu}[\\p{Ll}'’-]+(?:[ \\t-]\\p{Lu}[\\p{Ll}'’-]+)?)`,
  'gu',
);
// "Familie Meier", "famille Favre", "Famiglia Bernasconi", "the Smith family"
const FAMILY = /(?<![\p{L}])(?:Familie|Fam\.|famille|Famille|famiglia|Famiglia)[ \t]+(\p{Lu}[\p{Ll}'’-]+(?:-\p{Lu}[\p{Ll}'’-]+)?)/gu;
// Chat speakers: "[09:09] Odie (Support):" "Sandra (Support):"
const SPEAKER = /(?:^|\n)[ \t]*(?:\[\d{1,2}:\d{2}\][ \t]*)?(\p{Lu}[\p{Ll}'’-]+(?:[ \t]\p{Lu}[\p{Ll}'’-]+)?)\s\((?:Support|Kundendienst|Service|Agent|Bot|Team|Assistenza)\)\s?:/gu;

const ORG_HEAD = String.raw`(?:Versicherung|Versicherungen|Krankenkasse|Krankenversicherung|Assurance|Assurances|Assicurazione|Assicurazioni|Cassa malati|Caisse maladie|Bank|Banque|Banca|Privatbank|Kantonalbank|Banca cantonale|Banque cantonale|Gymnasium|Kantonsschule|Primarschule|Sekundarschule|Lycée|Collège|Liceo|Scuola media|Klinik|Clinique|Clinic|Spital|Spitäler|Hôpital|Hospital|Ospedale|Clinica|Praxis|Gruppenpraxis|Arztpraxis|Cabinet|Cabinet médical|Studio medico|Kanzlei|Anwaltskanzlei|Étude|Studio legale|Fiduciaire|Treuhand|Fiduciaria|Schule|École|Scuola|Kita|Crèche|Asilo|Pflegeheim|EMS|Casa anziani|Apotheke|Pharmacie|Farmacia)`;
const ORG_RES = [
  // "Klinik Bethanien", "Clinique La Colline", "Clinica Sant'Anna", "Praxis Dr. Huber"
  new RegExp(`${NB}${ORG_HEAD}[ \\t](?:(?:La|Le|Les|des|du|de|di|am|im|zum|zur|St\\.|Sankt|San|Santa|Dr\\.)[ \\t])?\\p{Lu}[\\p{L}'’-]+(?:[ \\t]\\p{Lu}[\\p{L}'’-]+)?`, 'gu'),
  // "Lindenhof Clinic", "Hirslanden Klinik", "Helvetia Versicherungen", "Zuger Kantonalbank"
  new RegExp(`${NB}\\p{Lu}[\\p{L}'’-]+[ \\t](?:Clinic|Hospital|Klinik|Spital|Praxis|Fiduciaire|Treuhand|Versicherung|Versicherungen|Assurances?|Assicurazioni|Insurance|Bank|Kantonalbank|Privatbank|Apotheke|Pharmacy|Pharmacie|Farmacia|School|Schule|Gymnasium)${NA}`, 'gu'),
  // Company by legal form: "Favre Immobilier SA", "Limmat Consulting GmbH", "Seeland Property AG", "Jura Services Sàrl"
  // "Brunner & Keller Treuhand AG", "Meier und Partner GmbH": partners joined by &/und/and/et belong to the name.
  new RegExp(`${NB}(?:\\p{Lu}[\\p{L}&'’.-]*(?:[ \\t](?:&|\\+|und|and|et|e)[ \\t]|[ \\t])){1,4}(?:AG|GmbH|SA|Sàrl|SARL|Sagl|SAGL|Ltd\\.?|LLC|Inc\\.|KG|S\\.A\\.|S\\.p\\.A\\.|Genossenschaft|Stiftung|Fondation|Fondazione)${NA}`, 'gu'),
];
const GENERIC_ORG_WORDS = new Set(
  (
    'security team account accounts statement statements details transfer transfers policy policies department service services support card cards ' +
    'holder holders branch manager officer staff office data information app portal login online customer customers critical illness life health ' +
    'car home travel private public national central investment retail commercial primary secondary high language business international global ' +
    'general medical dental mental emergency children community local regional state federal city municipal new old main ' +
    'united kingdom states republic european swiss world'
  ).split(' '),
);
const ORG_LEAD_STOP = /^(?:Die|Der|Das|Den|Dem|Des|Le|La|Les|The|A|An|Un|Une|Il|Lo|Bei|Von|Vom|Zur|Zum|Chez|At|For|Für|Bailleresse|Bailleur|Vermieter|Arbeitgeber|Employer|Employeur)\s/;

// Streets without a recognisable suffix are still addresses when a Swiss/German postcode follows:
// "Spalenberg 57, 4051 Basel", "Im Lot 3\n8610 Uster", "Via Nassa 5, 6900 Lugano"
const STREET_BEFORE_POSTCODE = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}.'’-]+(?:[ \t][\p{L}.'’-]+){0,3}[ \t]\d{1,4}[a-z]?(?=,?[ \t]*(?:\n[ \t]*)?(?:CH-|D-|DE-|A-)?\d{4,5}[ \t]\p{Lu})/gu;

export function detectAddresses(text: string): Entity[] {
  STREET_BEFORE_POSTCODE.lastIndex = 0;
  return [...text.matchAll(STREET_BEFORE_POSTCODE)].map((m) => {
    // Drop a leading label/name part separated by ":" or "|" is not possible inside the match; trim leading stop words.
    let s = m.index!;
    let v = m[0];
    const lead = /^(?:Adresse|Address|Indirizzo|Wohnhaft|Domicile|Domicilio|Anschrift)[ \t]/.exec(v);
    if (lead) {
      s += lead[0].length;
      v = v.slice(lead[0].length);
    }
    return e(text, s, s + v.length, 'ADDRESS', 0.9);
  });
}

export function detectPeopleAndOrgs(text: string): Entity[] {
  const out: Entity[] = [];
  INITIALS.lastIndex = 0;
  for (const m of text.matchAll(INITIALS)) out.push(e(text, m.index!, m.index! + m[0].length, 'PERSON', 0.85));
  for (const re of [INTRO, GREETING, THANKS, SIGNOFF, HEADER, SPEAKER, HONORIFIC_NAME, FAMILY]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) pushName(out, text, m.index! + m[0].lastIndexOf(m[1]), m[1]);
  }
  NAME_FIELD.lastIndex = 0;
  for (const m of text.matchAll(NAME_FIELD)) {
    let raw = m[1].replace(/[,\s]+$/, '');
    // A comma only belongs to the name in "SURNAME, Firstname"; "GLOVER JAZMIN, DOB …" ends at the comma.
    const comma = raw.indexOf(',');
    if (comma > 0 && /\s/.test(raw.slice(0, comma))) raw = raw.slice(0, comma);
    else if (comma > 0) raw = raw.slice(0, comma + 1) + raw.slice(comma + 1).split(',')[0];
    // Only names: every word capitalised (or ALL CAPS) — "Name: Zoey Bourcard", "PATIENT: GLOVER JAZMIN"
    if (!raw.split(/[\s,]+/).every((w) => /^\p{Lu}/u.test(w))) continue;
    const start = m.index! + m[0].lastIndexOf(m[1]);
    const words = trimName(raw.split(/\s+/));
    if (!words.length) continue;
    const value = words.join(' ').replace(/[,]+$/, '');
    out.push(e(text, start, start + value.length, 'PERSON', 0.9));
  }
  INVERTED.lastIndex = 0;
  for (const m of text.matchAll(INVERTED)) out.push(e(text, m.index!, m.index! + m[0].length, 'PERSON', 0.9));
  for (const re of ORG_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      let s = m.index!;
      let v = m[0];
      const lead = ORG_LEAD_STOP.exec(v);
      if (lead) {
        s += lead[0].length;
        v = v.slice(lead[0].length);
      }
      if (v.split(/\s+/).length < 2) continue;
      // "Critical Illness Insurance", "Bank Security Team": the name part must not be a generic word.
      if (v.split(/\s+/).some((w) => GENERIC_ORG_WORDS.has(w.toLowerCase()))) continue;
      out.push(e(text, s, s + v.length, 'ORG', 0.9));
    }
  }
  return out;
}
