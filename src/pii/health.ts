// HEALTH detection: diagnoses, conditions and medication (special-category data under nDSG / GDPR art. 9).
// The NER model has no such label, so this is rules + a curated DE/FR/EN/IT lexicon:
//  1. labelled fields ("Diagnose: …", "Current medication: …") and trigger phrases ("leidet an …", "because of my …")
//  2. lexicon terms (conditions, medications), extended by a dose ("Sertralin 50 mg")
//  3. German/English medical word endings (-itis, -karzinom, -syndrom, -störung …)
import type { Entity } from './types';

const CONDITIONS = [
  // en
  'diabetes', 'type 1 diabetes', 'type 2 diabetes', 'hypertension', 'high blood pressure', 'asthma', 'copd', 'depression', 'major depressive disorder',
  'anxiety disorder', 'generalised anxiety disorder', 'generalized anxiety disorder', 'panic disorder', 'bipolar disorder', 'schizophrenia', 'ptsd',
  'post-traumatic stress disorder', 'burnout', 'adhd', 'autism', 'dementia', "alzheimer's disease", "parkinson's disease", 'multiple sclerosis', 'epilepsy',
  'migraine', 'cancer', 'breast cancer', 'prostate cancer', 'lung cancer', 'leukaemia', 'leukemia', 'lymphoma', 'melanoma', 'tumour', 'tumor', 'hiv',
  'hiv infection', 'aids', 'hepatitis', 'hepatitis b', 'hepatitis c', 'tuberculosis', 'covid-19', 'long covid', 'stroke', 'heart attack',
  'myocardial infarction', 'heart failure', 'atrial fibrillation', 'coronary heart disease', 'obesity', 'anorexia', 'bulimia', 'eating disorder',
  'alcohol dependence', 'alcoholism', 'addiction', 'substance use disorder', 'herniated disc', 'slipped disc', 'osteoporosis', 'arthritis',
  'rheumatoid arthritis', 'osteoarthritis', 'crohn\'s disease', 'ulcerative colitis', 'coeliac disease', 'celiac disease', 'psoriasis', 'chronic pain',
  'fibromyalgia', 'kidney failure', 'renal failure', 'pregnancy', 'miscarriage', 'infertility', 'concussion', 'torn ligament', 'fracture',
  'hypothyroidism', 'hyperthyroidism', 'sleep apnoea', 'sleep apnea', 'insomnia', 'tinnitus', 'glaucoma', 'cataract', 'antiretroviral therapy',
  'chemotherapy', 'radiotherapy', 'dialysis', 'psychotherapy', 'whiplash', 'sprained ankle', 'broken arm', 'broken leg', 'broken wrist', 'torn acl',
  'allergy', 'peanut allergy', 'pollen allergy', 'lactose intolerance', 'gluten intolerance', 'covid', 'flu', 'pneumonia', 'bronchitis', 'appendicitis', 'shingles',
  // de
  'diabetes mellitus', 'diabetes typ 1', 'diabetes typ 2', 'bluthochdruck', 'asthma bronchiale', 'depression', 'depressive episode', 'depressive störung',
  'rezidivierende depressive störung', 'angststörung', 'generalisierte angststörung', 'panikstörung', 'bipolare störung', 'schizophrenie', 'burn-out',
  'erschöpfungsdepression', 'demenz', 'alzheimer', 'parkinson', 'multiple sklerose', 'epilepsie', 'migräne', 'krebs', 'brustkrebs', 'prostatakrebs',
  'lungenkrebs', 'leukämie', 'tumor', 'hiv-infektion', 'hepatitis', 'tuberkulose', 'schlaganfall', 'herzinfarkt', 'herzinsuffizienz',
  'vorhofflimmern', 'adipositas', 'magersucht', 'essstörung', 'alkoholabhängigkeit', 'alkoholsucht', 'sucht', 'diskushernie', 'bandscheibenvorfall',
  'lumbale diskushernie', 'osteoporose', 'arthrose', 'rheuma', 'morbus crohn', 'colitis ulcerosa', 'zöliakie', 'schuppenflechte', 'chronische schmerzen',
  'fibromyalgie', 'niereninsuffizienz', 'schwangerschaft', 'fehlgeburt', 'unfruchtbarkeit', 'gehirnerschütterung', 'kreuzbandriss', 'meniskusriss',
  'schilddrüsenunterfunktion', 'schilddrüsenüberfunktion', 'schlafapnoe', 'schlafstörung', 'grauer star', 'grüner star', 'chemotherapie',
  'strahlentherapie', 'dialyse', 'psychotherapie', 'armbruch', 'beinbruch', 'handgelenksbruch', 'schleudertrauma', 'prellung', 'verstauchung', 'bänderriss',
  'nussallergie', 'pollenallergie', 'heuschnupfen', 'laktoseintoleranz', 'glutenunverträglichkeit', 'lungenentzündung', 'grippe', 'gürtelrose', 'blinddarmentzündung',
  // fr
  'diabète', 'diabète de type 1', 'diabète de type 2', 'hypertension artérielle', 'asthme', 'asthme bronchique', 'bpco', 'dépression',
  'épisode dépressif', 'trouble anxieux', 'trouble anxieux généralisé', 'trouble panique', 'trouble bipolaire', 'schizophrénie', 'épuisement professionnel',
  'démence', 'maladie d\'alzheimer', 'maladie de parkinson', 'sclérose en plaques', 'épilepsie', 'migraine', 'cancer du sein', 'cancer de la prostate',
  'entorse', 'contusion', 'coup du lapin', 'fracture du poignet', 'allergie aux arachides', 'rhume des foins', 'intolérance au lactose', 'pneumonie', 'zona', 'appendicite', 'grippe',
  'leucémie', 'lymphome', 'mélanome', 'tumeur', 'infection vih', 'vih', 'sida', 'hépatite', 'tuberculose', 'avc', 'accident vasculaire cérébral',
  'infarctus', 'insuffisance cardiaque', 'fibrillation auriculaire', 'obésité', 'anorexie', 'boulimie', 'trouble alimentaire', 'alcoolisme',
  'dépendance à l\'alcool', 'hernie discale', 'ostéoporose', 'arthrose', 'polyarthrite rhumatoïde', 'maladie de crohn', 'maladie cœliaque',
  'douleurs chroniques', 'fibromyalgie', 'insuffisance rénale', 'grossesse', 'fausse couche', 'infertilité', 'commotion cérébrale',
  'rupture des ligaments croisés', 'hypothyroïdie', 'hyperthyroïdie', 'apnée du sommeil', 'insomnie', 'chimiothérapie', 'radiothérapie', 'dialyse',
  // it
  'diabete', 'diabete di tipo 2', 'ipertensione', 'asma', 'depressione', 'disturbo d\'ansia', 'disturbo bipolare', 'schizofrenia', 'demenza',
  'morbo di parkinson', 'sclerosi multipla', 'epilessia', 'emicrania', 'cancro', 'tumore', 'leucemia', 'infezione da hiv', 'epatite', 'tubercolosi',
  'ictus', 'infarto', 'insufficienza cardiaca', 'obesità', 'anoressia', 'bulimia', 'alcolismo', 'ernia del disco', 'osteoporosi', 'artrosi',
  'artrite reumatoide', 'morbo di crohn', 'celiachia', 'gravidanza', 'aborto spontaneo', 'commozione cerebrale', 'rottura del legamento crociato',
  'ipotiroidismo', 'insonnia', 'chemioterapia', 'radioterapia', 'dialisi', 'crociato rotto', 'frattura', 'distorsione', 'colpo di frusta', 'contusione',
  'allergia', 'allergia alle arachidi', 'febbre da fieno', 'intolleranza al lattosio', 'polmonite', 'fuoco di sant\'antonio', 'appendicite', 'influenza',
];

const MEDICATIONS = [
  'sertralin', 'sertraline', 'escitalopram', 'citalopram', 'fluoxetin', 'fluoxetine', 'paroxetin', 'paroxetine', 'venlafaxin', 'venlafaxine',
  'duloxetin', 'duloxetine', 'mirtazapin', 'mirtazapine', 'bupropion', 'trazodon', 'trazodone', 'lithium', 'quetiapin', 'quetiapine', 'olanzapin',
  'olanzapine', 'risperidon', 'risperidone', 'aripiprazol', 'aripiprazole', 'haloperidol', 'clozapin', 'clozapine', 'lamotrigin', 'lamotrigine',
  'valproat', 'valproate', 'levetiracetam', 'carbamazepin', 'carbamazepine', 'methylphenidat', 'methylphenidate', 'ritalin', 'concerta', 'elvanse',
  'lorazepam', 'diazepam', 'alprazolam', 'temesta', 'xanax', 'valium', 'zolpidem', 'metformin', 'metformine', 'insulin', 'insuline', 'insulina',
  'glibenclamid', 'sitagliptin', 'empagliflozin', 'jardiance', 'ozempic', 'semaglutid', 'semaglutide', 'liraglutid', 'liraglutide', 'mounjaro',
  'tirzepatid', 'tirzepatide', 'levothyroxin', 'levothyroxine', 'euthyrox', 'eltroxin', 'ramipril', 'lisinopril', 'enalapril', 'amlodipin',
  'amlodipine', 'bisoprolol', 'metoprolol', 'losartan', 'valsartan', 'candesartan', 'hydrochlorothiazid', 'torasemid', 'furosemid', 'furosemide',
  'atorvastatin', 'atorvastatine', 'simvastatin', 'rosuvastatin', 'aspirin cardio', 'clopidogrel', 'rivaroxaban', 'xarelto', 'apixaban', 'eliquis',
  'marcoumar', 'phenprocoumon', 'warfarin', 'symbicort', 'seretide', 'ventolin', 'salbutamol', 'budesonid', 'budesonide', 'montelukast',
  'prednison', 'prednisone', 'prednisolon', 'methotrexat', 'methotrexate', 'adalimumab', 'humira', 'infliximab', 'tamoxifen', 'letrozol',
  'letrozole', 'truvada', 'biktarvy', 'tenofovir', 'emtricitabin', 'emtricitabine', 'dolutegravir', 'methadon', 'methadone', 'buprenorphin',
  'buprenorphine', 'subutex', 'naltrexon', 'naltrexone', 'disulfiram', 'antabus', 'oxycodon', 'oxycodone', 'morphin', 'morphine', 'tramadol',
  'fentanyl', 'tapentadol', 'pregabalin', 'lyrica', 'gabapentin', 'sumatriptan', 'antidepressiva', 'antidepressants', 'antidépresseurs',
  'antidepressivi', 'neuroleptika', 'benzodiazepine',
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const byLength = (xs: string[]) => [...new Set(xs)].sort((a, b) => b.length - a.length).map(esc);

const DOSE = String.raw`(?:\s?\d+(?:[.,]\d+)?\s?(?:mg|µg|mcg|g|ml|IE|I\.E\.|IU|E)(?:\/\w+)?(?:\s?(?:1-0-1|1-0-0|0-0-1|1-1-1|\d+x\s?(?:täglich|daily|par jour|al giorno)))?)?`;
const TERM_RE = new RegExp(`${B}(?:${byLength(CONDITIONS).join('|')})${E}|${B}(?:${byLength(MEDICATIONS).join('|')})${E}${DOSE}`, 'giu');

// Unknown drug name + dose: "Quviviq 50 mg", "escitalopram 10 mg"
const DRUG_DOSE = /(?<![\p{L}\p{N}])[A-Za-zäöüé][a-zäöüé]{4,}(?:[- ][A-Za-z][a-z]+)?\s?\d+(?:[.,]\d+)?\s?(?:mg|µg|mcg|IE|IU)(?![\p{L}])/gu;

// Medical word endings that are (almost) never ordinary words.
const SUFFIX_RE =
  /(?<![\p{L}])[\p{L}-]{3,}(?:itis|karzinom|carcinoma|syndrom|syndrome|störung|insuffizienz|hernie|fraktur|riss|pathie|plegie|ämie|aemia|anämie|sklerose|algie)(?![\p{L}])/giu;
const SUFFIX_STOP = new Set(['Störung', 'störung', 'Riss', 'riss', 'Verriss', 'Abriss', 'Grundriss', 'Umriss', 'Betriebsstörung', 'Netzwerkstörung', 'Lieferstörung', 'Systemstörung', 'Ruhestörung', 'Akademie', 'akademie']);

// Labelled fields: everything up to the end of the line / sentence is the diagnosis or medication.
const FIELD_LABELS = [
  'Diagnose', 'Diagnosen', 'Hauptdiagnose', 'Nebendiagnosen?', 'Befund', 'Diagnosis', 'Diagnoses', 'Primary diagnosis', 'Diagnostic', 'Diagnostics',
  'Diagnostic principal', 'Diagnosi', 'Medikation', 'Aktuelle Medikation', 'Dauermedikation', 'Medikamente', 'Current medication', 'Medication',
  'Medications', 'Traitement actuel', 'Traitement', 'Médication', 'Médicaments', 'Terapia', 'Terapia attuale', 'Farmaci', 'Therapie', 'Allergien',
  'Allergies', 'Allergie', 'Vorerkrankungen', 'Medical history', 'Antécédents', 'Anamnesi', 'Krankheit', 'Illness', 'Maladie', 'Malattia',
];
const FIELD_RE = new RegExp(`(?:^|[\\n|•·]\\s*|\\b)(?:${FIELD_LABELS.join('|')})\\s?:\\s*([^\\n|.;]{3,120})`, 'giu');

// Phrases that introduce a condition in running text.
const TRIGGERS = [
  'allergisch auf', 'allergisch gegen', 'allergie auf', 'allergie gegen', 'allergic to', 'allergy to', 'allergique à', 'allergique au', 'allergico a', 'allergica a', 'allergia a', 'allergia al',
  'hat sich', 'brach sich', 'broke his', 'broke her', 'broke my', "s'est cassé", "s'est fracturé", 'si è rotto', 'si è rotta', 'ha il', 'ha la',
  'leidet an', 'leidet unter', 'leide an', 'leide unter', 'erkrankt an', 'diagnostiziert mit', 'wegen meiner', 'wegen meines', 'wegen meinem', 'wegen seiner',
  'wegen ihrer', 'aufgrund meiner', 'aufgrund seiner', 'aufgrund ihrer', 'laut arztzeugnis', 'arztzeugnis:', 'suffers from', 'suffering from', 'suffer from',
  'diagnosed with', 'because of my', 'because of his', 'because of her', 'due to my', 'due to his', 'due to her', 'treated for', 'atteint de', 'atteinte de',
  'souffre de', 'souffre d\'', 'diagnostiqué', 'diagnostiquée', 'en raison de mon', 'en raison de ma', 'à cause de mon', 'à cause de ma', 'certificat médical :',
  'certificat médical:', 'soffre di', 'affetto da', 'affetta da', 'a causa della mia', 'a causa del mio', 'diagnosticato', 'diagnosticata', "she's on", "he's on",
  'sie nimmt', 'er nimmt', 'elle prend', 'il prend',
];
const TRIGGER_RE = new RegExp(`${B}(?:${byLength(TRIGGERS).join('|')})\\s+([^\\n|.;:()]{3,90})`, 'giu');
// Sick-leave notes in brackets: "(on sick leave, generalised anxiety disorder)", "(en arrêt maladie, diabète de type 2)"
const SICK_RE = /\((?:on sick leave|sick leave|krankgeschrieben|krank|en arrêt maladie|arrêt maladie|in malattia|malattia)\s*[,:–-]\s*([^)\n]{3,90})\)/giu;

// Where a phrase captured after a trigger ends: a verb/conjunction that starts the rest of the sentence.
const PHRASE_END =
  /\s(?:kann|könnte|muss|bin|ist|war|habe|hat|werde|wird|und ich|seit|ab|bis|I|i|can|could|cannot|can't|will|won't|am|is|was|have|has|since|until|from|je|ne|suis|est|peux|dois|depuis|jusqu|non|posso|sono|è|da|fino|per|but|aber|mais|ma)\s/u;

function trimPhrase(start: number, raw: string): [number, number] | null {
  let s = raw;
  const cut = PHRASE_END.exec(s);
  if (cut) s = s.slice(0, cut.index);
  s = s.replace(/[\s,–-]+$/, '');
  // Drop leading articles / possessives.
  const lead = /^(?:an |einer |einem |einen |eine |ein |der |die |das |a |an |the |de la |du |des |d'|un |une |una |un |il |la |lo |di )/i.exec(s);
  const off = lead ? lead[0].length : 0;
  s = s.slice(off);
  const words = s.split(/\s+/).filter(Boolean);
  if (!s || words.length > 10 || !/\p{L}{3}/u.test(s)) return null;
  return [start + off, start + off + s.length];
}

const ent = (text: string, start: number, end: number, score: number): Entity => ({ start, end, text: text.slice(start, end), type: 'HEALTH', source: 'regex', score });

export function detectHealth(text: string): Entity[] {
  const out: Entity[] = [];
  for (const re of [FIELD_RE, TRIGGER_RE, SICK_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const g = m[1];
      const r = trimPhrase(m.index! + m[0].lastIndexOf(g), g);
      if (r) out.push(ent(text, r[0], r[1], 0.9));
    }
  }
  for (const re of [TERM_RE, DRUG_DOSE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push(ent(text, m.index!, m.index! + m[0].trimEnd().length, 0.95));
  }
  SUFFIX_RE.lastIndex = 0;
  for (const m of text.matchAll(SUFFIX_RE)) {
    if (SUFFIX_STOP.has(m[0]) || m[0].length < 7) continue;
    out.push(ent(text, m.index!, m.index! + m[0].length, 0.8));
  }
  return out;
}

/** Lexicon hit anywhere in a string (used by the leak guard on cleaned text). */
export const hasHealthTerm = (s: string) => {
  TERM_RE.lastIndex = 0;
  return TERM_RE.test(s);
};
