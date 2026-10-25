// Proper-noun gate for model detections (BERT / span models such as GLiNER).
// Models tag roles and pronouns as persons ("the applicant", "she", "die Beschwerdeführerin") and generic
// institutions as organisations ("the Government", "the Court"). In the TAB benchmark these were ~80% of the
// span model's false positives. Rules and manual marks are never filtered here.
import type { Entity } from './types';

// Determiners / ordinals / possessives in front of a role: "the second applicant", "die Beschwerdeführerin".
const LEAD = /^(?:the|a|an|this|that|these|those|its|his|her|their|our|your|my|first|second|third|fourth|fifth|der|die|das|den|dem|des|ein|eine|einer|einem|einen|unser|unsere|ihr|ihre|sein|seine|le|la|les|l'|un|une|du|des|ce|cette|son|sa|ses|leur|il|lo|gli|i|un|uno|una|del|della|dei|delle|suo|sua|primo|prima|secondo|seconda|premier|première|deuxième|second|seconde|erste|erster|zweite|zweiter)\s+/i;

const ROLES = new Set(
  (
    // en
    'applicant applicants petitioner respondent respondents plaintiff plaintiffs defendant defendants claimant claimants appellant appellants accused ' +
    'victim victims witness witnesses complainant government court commission chamber grand chamber registrar registry judge judges justice prosecutor ' +
    'public prosecutor investigating judge police officer officers authorities authority state ministry minister secretary secretary of state board ' +
    'committee council tribunal agency office department parliament landlord landlords tenant tenants employer employee employees customer customers client clients ' +
    'patient patients doctor physician nurse lawyer counsel attorney representative parent parents mother father child children son daughter wife husband ' +
    'partner spouse colleague colleagues manager team staff user users member members applicant’s company firm bank insurer school hospital clinic ' +
    // de
    'beschwerdeführer beschwerdeführerin beschwerdegegner beschwerdegegnerin kläger klägerin beklagte beklagter gesuchsteller gesuchstellerin ' +
    'angeklagte angeklagter beschuldigte beschuldigter opfer zeuge zeugin gericht bundesgericht vorinstanz staatsanwaltschaft staatsanwalt staatsanwältin ' +
    'polizei behörde behörden regierung ministerium vermieter vermieterin mieter mieterin arbeitgeber arbeitgeberin arbeitnehmer arbeitnehmerin kunde kundin ' +
    'patient patientin arzt ärztin anwalt anwältin rechtsanwalt rechtsanwältin vertreter vertreterin eltern mutter vater kind sohn tochter ehefrau ehemann ' +
    // fr
    'requérant requérante requérants défendeur défenderesse demandeur demanderesse plaignant plaignante accusé accusée prévenu prévenue victime témoin ' +
    'gouvernement cour tribunal commission ministère ministre procureur juge police autorité autorités bailleur bailleresse locataire employeur employé employée ' +
    'client cliente patient patiente médecin avocat avocate représentant représentante parents mère père enfant fils fille épouse époux ' +
    // it
    'ricorrente ricorrenti convenuto convenuta attore attrice imputato imputata vittima testimone governo corte tribunale commissione ministero ministro ' +
    'procuratore giudice polizia autorità locatore locatrice inquilino inquilina datore di lavoro dipendente cliente paziente medico avvocato avvocata ' +
    'rappresentante genitori madre padre figlio figlia moglie marito'
  ).split(/\s+/),
);
const MULTI_ROLES = ['grand chamber', 'public prosecutor', 'investigating judge', 'secretary of state', 'datore di lavoro', 'police officer'];

const PRONOUNS = new Set(
  (
    'i me my mine he him his she her hers they them their theirs we us our you your it its ich mich mir er ihn ihm sie ihr wir uns du dich dir es ' +
    'je moi il elle ils elles nous vous lui leur on io me mi lui lei loro noi voi egli ella esso essa'
  ).split(' '),
);

const norm = (s: string) => s.trim().replace(/[.,;:!?'’"“”()]+$/g, '').replace(/^[“"'(]+/, '').replace(/\s+/g, ' ');

/** "the second applicant", "She", "die Beschwerdeführerin", "Ministry of Foreign Affairs" → true */
export function isRoleOrPronoun(text: string): boolean {
  let s = norm(text).toLowerCase();
  for (let i = 0; i < 3; i++) s = s.replace(LEAD, '');
  if (!s) return true;
  if (PRONOUNS.has(s) || ROLES.has(s) || MULTI_ROLES.includes(s)) return true;
  // "Ministry of X" / "Ministère de X" / "Department of X": a public body, not a personal identifier.
  if (/^(?:ministry|ministère|ministero|ministerium|department|département|dipartimento|departement|office|bureau)\s+(?:of|de|du|des|della|del|für)\s/.test(s)) return true;
  return false;
}

// Chat / greeting context in which lowercase names are normal: "[09:06] Customer: hi, this is steven murphy".
const CHAT_LINE = /(?:^|\n)[ \t]*(?:\[\d{1,2}:\d{2}(?::\d{2})?\]|\d{1,2}:\d{2}\s*[-–]|[\p{L} ]{2,20}:)/u;
const GREETING_NEAR = /(?:hi|hello|hey|hallo|hoi|salut|bonjour|ciao|grüezi|this is|hier ist|c'est|sono|thanks|danke|merci|grazie|regards|grüsse|gruss|i am|i'm|im|my name is|my name's|call me|ich bin|ich heisse|ich heiße|mein name ist|je suis|je m'appelle|moi c'est|mi chiamo|io sono|mr\.?|mrs\.?|ms\.?|herr|frau|mme|signor|signora)[,!]?\s*$/i;

/** Common words that are never part of a name ("who wrote it", "the client"). */
const FUNCTION_WORDS = new Set(
  (
    'who whom whose what which when where why how it its this that these those he she they them his her their we us our you your me my i a an the to of in on at for from by with and or ' +
    'wrote write writes written sent send says said is are was were be been has have had do does did will would can could should may might ' +
    'wer wen wem wessen was wann wo warum wie es er sie ihr ihm ihn wir uns du dich der die das ein eine und oder von zu mit für hat ist sind war schrieb ' +
    'qui que quoi quand où pourquoi comment il elle ils elles le la les un une et ou de du des à pour avec a est sont était écrit ' +
    'chi che cosa quando dove perché come lui lei loro il lo la gli le un una e o di da per con ha è sono era scritto'
  ).split(' '),
);

/** Text typed casually in lowercase ("i am maria keller and need …"): capitals carry no signal there. */
function isCasualLowercase(text: string): boolean {
  const words = text.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
  if (words.length < 4) return false;
  const capital = words.slice(1).filter((w) => w !== 'I' && /^\p{Lu}/u.test(w)).length;
  return capital / (words.length - 1) < 0.04;
}

function lineAround(text: string, start: number) {
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  return text.slice(ls, start);
}

/**
 * Keep a model detection? Applies to PERSON / ORG / LOCATION from models only.
 * - roles, pronouns and generic institutions are dropped
 * - spans starting lowercase are dropped unless they sit in a chat/greeting context
 */
export function passesProperNounGate(e: Entity, text: string): boolean {
  if (e.source !== 'ner' && e.source !== 'jev') return true;
  if (e.type !== 'PERSON' && e.type !== 'ORG' && e.type !== 'LOCATION') return true;
  if (isRoleOrPronoun(e.text)) return false;
  const first = norm(e.text)[0] ?? '';
  if (first && first === first.toLowerCase() && first !== first.toUpperCase()) {
    const before = lineAround(text, e.start);
    if (!CHAT_LINE.test('\n' + before) && !GREETING_NEAR.test(before) && !isCasualLowercase(text)) return false;
    // A lowercase "name" made of everyday words is a phrase, not a person: "who wrote it".
    if (norm(e.text).toLowerCase().split(/\s+/).some((w) => FUNCTION_WORDS.has(w.replace(/[.,;:!?'’]/g, '')))) return false;
  }
  return true;
}
