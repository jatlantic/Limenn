// Terms the NER model likes to tag as ORG/PERSON/LOCATION but that are not personal data: software and
// products, big platforms and public institutions in general use. Only suppresses model detections (ner/jev),
// never regex or manual ones, so "my employer Microsoft Schweiz GmbH" is still caught by the legal-form rule.
const TERMS = [
  // software, platforms, devices
  'Microsoft Teams', 'Teams', 'Zoom', 'Slack', 'WhatsApp', 'Signal', 'Threema', 'Telegram', 'Skype', 'Webex', 'Google Meet', 'Outlook', 'Gmail', 'Excel',
  'Word', 'PowerPoint', 'OneDrive', 'SharePoint', 'Google Drive', 'Dropbox', 'iCloud', 'LinkedIn', 'Instagram', 'Facebook', 'TikTok', 'YouTube', 'X',
  'Twitter', 'SAP', 'SAP SuccessFactors', 'SuccessFactors', 'Salesforce', 'Workday', 'Abacus', 'Bexio', 'Jira', 'Confluence', 'Notion', 'Trello', 'Asana',
  'GitHub', 'GitLab', 'Windows', 'macOS', 'iOS', 'Android', 'iPhone', 'iPad', 'MacBook', 'MacBook Air', 'MacBook Pro', 'AirPods', 'Apple Watch', 'Galaxy',
  'ThinkPad', 'Surface', 'Kindle', 'PlayStation', 'Xbox', 'Nintendo Switch', 'Sonos', 'Logitech', 'Dell', 'Lenovo', 'HP', 'Samsung', 'Apple', 'Google',
  'Microsoft', 'Amazon', 'Netflix', 'Spotify', 'TWINT', 'Twint', 'PayPal', 'Revolut', 'Visa', 'Mastercard', 'SwissPass', 'Postfinance App', 'Claude',
  'ChatGPT', 'Copilot', 'Gemini', 'OpenAI', 'Anthropic', 'Perplexity', 'Mistral', 'DeepL', 'Grok', 'xAI',
  // countries and continents on their own say nothing about a person (cities and addresses stay protected)
  'Schweiz', 'Switzerland', 'Suisse', 'Svizzera', 'Svizra', 'Deutschland', 'Germany', 'Allemagne', 'Germania', 'Frankreich', 'France', 'Francia',
  'Italien', 'Italy', 'Italie', 'Italia', 'Österreich', 'Austria', 'Autriche', 'Liechtenstein', 'Europa', 'Europe', 'USA', 'United States',
  'Vereinigte Staaten', 'États-Unis', 'Stati Uniti', 'UK', 'United Kingdom', 'Grossbritannien', 'Großbritannien', 'Royaume-Uni', 'Regno Unito',
  'England', 'Spanien', 'Spain', 'Espagne', 'Spagna', 'Portugal', 'Niederlande', 'Netherlands', 'Pays-Bas', 'Paesi Bassi', 'Belgien', 'Belgium',
  'Belgique', 'Belgio', 'China', 'Chine', 'Cina', 'Japan', 'Japon', 'Giappone', 'Indien', 'India', 'Inde', 'Russland', 'Russia', 'Russie', 'Ukraine',
  'Ucraina', 'Kanada', 'Canada', 'Brasilien', 'Brazil', 'Brésil', 'Brasile', 'Asien', 'Asia', 'Asie', 'Afrika', 'Africa', 'Afrique', 'Amerika', 'America', 'Amérique',
  // public institutions in general use (CH + EU)
  'SUVA', 'Suva', 'AHV', 'IV', 'AVS', 'AI', 'EO', 'ALV', 'RAV', 'ORP', 'URC', 'SECO', 'BAG', 'OFSP', 'UFSP', 'ESTV', 'AFC', 'SEM', 'EDÖB', 'PFPDT', 'IFPDT',
  'FINMA', 'SNB', 'BNS', 'Swissmedic', 'Bundesgericht', 'Bundesverwaltungsgericht', 'Bundesstrafgericht', 'Tribunal fédéral', 'Tribunale federale',
  'Federal Supreme Court', 'Federal Court', 'Bundesrat', 'Conseil fédéral', 'Consiglio federale', 'Nationalrat', 'Ständerat', 'Parlament', 'Bundesamt',
  'Steueramt', 'Kantonales Steueramt', 'Betreibungsamt', 'Office des poursuites', 'Ufficio esecuzioni', 'Zivilstandsamt', 'Einwohnerkontrolle',
  'Migrationsamt', 'Strassenverkehrsamt', 'Polizei', 'Kantonspolizei', 'Police cantonale', 'Polizia cantonale', 'Stadtpolizei', 'KESB', 'APEA', 'ARP',
  'Schweizerische Post', 'Die Post', 'La Poste', 'La Posta', 'SBB', 'CFF', 'FFS', 'Swisscom', 'Salt', 'Sunrise', 'PostFinance', 'UBS', 'Credit Suisse',
  'Raiffeisen', 'ZKB', 'EU', 'European Union', 'Europäische Union', 'Union européenne', 'WHO', 'UNO', 'UN', 'OECD', 'ICD-10', 'DSGVO', 'GDPR', 'RGPD',
  'nDSG', 'DSG', 'LPD', 'OR', 'ZGB', 'CO', 'CC',
];

const PUBLIC = new Set(TERMS.map((t) => t.toLowerCase()));

/** "Hauptstadt der Schweiz", "capital of France", "nord de l'Italie": a description of a public place. */
const GEO_PHRASE =
  /^(?:(?:die|der|the|la|le|il|l')\s?)?(?:hauptstadt|landeshauptstadt|norden|süden|osten|westen|nordosten|südwesten|capital|north|south|east|west|capitale|nord|sud|est|ouest|centro|centre|center)\s+(?:der|des|von|vom|of|of the|de la|de l'|de|du|des|della|dell'|di|del)\s*(.+)$/i;

/** Is this detected span a known public term (exact, ignoring case and trailing punctuation)? */
export const isPublicTerm = (s: string): boolean => {
  const t = s.trim().replace(/[.,;:!?)]+$/, '');
  if (PUBLIC.has(t.toLowerCase())) return true;
  const geo = t.match(GEO_PHRASE);
  return !!geo && PUBLIC.has(geo[1].trim().toLowerCase());
};

/** A span that starts with a product/platform name followed only by model/version tokens: "MacBook Air 13", "Sonos Era 100". */
export function isProductLike(s: string): boolean {
  const words = s.trim().split(/\s+/);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    if (!PUBLIC.has(words.slice(0, n).join(' ').toLowerCase())) continue;
    return words.slice(n).every((w) => /^(?:[A-Z]{1,4}|\d+[A-Za-z]{0,3}|Pro|Max|Mini|Air|Plus|Ultra|Era|Master|Series|Edition|Business|Online)$/.test(w));
  }
  return false;
}
