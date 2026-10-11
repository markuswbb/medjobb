// Henter stillinger for medisinstudenter fra åpne stillings-API-er og lagrer dem i docs/jobs.json.
const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, 'docs', 'jobs.json');
const UA = 'medjobb/1.0 (privat stillingsoversikt for medisinstudenter)';
const KEEP_DAYS = 60;

// Treff på disse regnes som relevante for medisinstudenter.
const RELEVANT = new RegExp(
  [
    '(?<!para)medisin(er)?[- ]?stud',
    'med[- ]?student',
    'legestudent',
    '(med|m/|m\\.) ?(midlertidig |student)?lisens',
    'stud\\.? ?med\\b',
    'student(er)? (med|m/|m\\.) ?lisens',
    'studentlisens',
    'medical student',
    'student(er)? innen[^.]{0,40}medisin',
  ].join('|'),
  'i'
);

// Bergen prioriteres først, deretter Oslo. Fylke fra NAV brukes der det finnes.
const REGIONS = [
  ['bergen', /bergen|haukeland|haraldsplass|askøy|øygarden|sotra|straume|bjørnafjorden|osøyro|alver|knarvik|vaksdal|samnanger|austevoll|voss|vestland/i],
  ['oslo', /oslo|akershus|ahus|lørenskog|nordbyhagen|bærum|sandvika|asker|lillestrøm|nordre follo|kolbotn|diakonhjemmet|lovisenberg/i],
];
const regionOf = (...parts) => REGIONS.find(([, re]) => re.test(parts.join(' ')))?.[0] || '';

// Nøkkelpunkter: hva arbeidsgiver ser etter og hva slags jobb det er.
const KEY_POINTS = [
  [/lisens/i, 'Lisens kreves'],
  [/(fullført|bestått|avsluttet|minimum|minst)[^.]{0,25}?(\d|første|andre|tredje|fjerde|femte|sjette)\.? ?(studie)?år/i, (m) => `Fullført ${{ første: 1, andre: 2, tredje: 3, fjerde: 4, femte: 5, sjette: 6 }[m[2].toLowerCase()] || m[2]}. studieår`],
  [/farmakologi/i, 'Bestått farmakologi'],
  [/norsk(kunnskaper| skriftlig| muntlig| språk)|behersker norsk/i, 'Gode norskkunnskaper'],
  [/ferievikar|sommervikar|sommerjobb|sommeren/i, 'Sommer-/ferievikar'],
  [/tilkalling|ekstravakt|ringevikar/i, 'Tilkallingsvikar'],
  [/helg/i, 'Helgearbeid'],
  [/natt(evakt|arbeid|tjeneste)?\b/i, 'Nattevakter'],
  [/vaktordning|vaktarbeid|turnus(?!lege|vent)|tredelt/i, 'Vakt/turnus'],
  [/akuttmottak|akuttmedisin|\\bmottak/i, 'Akuttmottak/mottak'],
  [/legevakt/i, 'Legevakt'],
  [/psykiatri|psykisk helse/i, 'Psykiatri'],
  [/rus(behandling|medisin|seksjon|-| og)/i, 'Rus'],
  [/kirurgi/i, 'Kirurgi'],
  [/indremedisin|medisinsk (avdeling|klinikk|sengepost)/i, 'Indremedisin'],
  [/sykehjem|helsehus/i, 'Sykehjem'],
  [/hjemmetjeneste|hjemmesykepleie/i, 'Hjemmetjeneste'],
  [/legekontor|legesenter|fastlege/i, 'Legekontor'],
  [/blodprøve/i, 'Blodprøvetaking'],
  [/telemetri|scopvakt|skopvakt/i, 'Telemetri/scopvakt'],
  [/forskning|forskerlinje/i, 'Forskning'],
  [/førerkort/i, 'Førerkort'],
  [/politiattest/i, 'Politiattest'],
  [/\bdips\b/i, 'DIPS-erfaring'],
  [/personlig egnethet/i, 'Personlig egnethet vektlegges'],
  [/samarbeidsevne|samarbeider godt|gode samarbeids/i, 'Samarbeidsevner'],
  [/selvstendig/i, 'Selvstendig'],
];

function keyPoints(text, tags = []) {
  const points = [];
  const percent = /(\d{1,3}(?:[,.]\d)?) ?%/.exec(text);
  if (percent) points.push(`${percent[1]} % stilling`);
  for (const [re, label] of KEY_POINTS) {
    const m = re.exec(text);
    if (m) points.push(typeof label === 'function' ? label(m) : label);
  }
  // NAV har egne stikkord per annonse – ta med dem som ikke allerede er dekket.
  for (const tag of tags) {
    if (points.length >= 10) break;
    if (!points.some((p) => p.toLowerCase().includes(tag.toLowerCase().slice(0, 6)))) points.push(tag);
  }
  return points.slice(0, 10);
}

// Relevans 1–10 for studenten siden er laget for: 6. studieår, bor i Bergen (Oslo som nr. 2),
// erfaring fra sengepost på sykehus (SUS) og fra hjemmetjenesten. Vil helst jobbe i akuttmottak/mottak.
const PROFILE = {
  studyYear: 6,
  regionBonus: { bergen: [2, 'Ligger i Bergen-området'], oslo: [1, 'Ligger i Oslo-området'] },
  wants: [/akuttmottak|akuttmedisin|\bmottak/i, 2, 'Akuttmottak/mottak – det du helst vil ha'],
  experience: [
    [/sengepost/i, 'Du har 13 ukers erfaring fra sengepost'],
    [/hjemmetjeneste|hjemmesykepleie|hjemmebasert/i, 'Du har erfaring fra hjemmetjenesten'],
    [/helse stavanger|stavanger universitetss/i, 'Du har jobbet ved Stavanger universitetssjukehus'],
  ],
};
const YEAR_WORDS = { første: 1, andre: 2, tredje: 3, fjerde: 4, femte: 5, sjette: 6 };
const YEAR_REQ = /(fullført|bestått|avsluttet|minimum|minst)[^.]{0,25}?(\d|første|andre|tredje|fjerde|femte|sjette)\.? ?(studie)?år/i;
const OTHER_ROLE = /overlege|spesialist|sykepleier|vernepleier|helsefagarbeider|leder|leiar|psykolog|fysioterapeut|sekretær|konsulent|rådgiver|terapeut|lærer/i;
const STUDENT_ROLE = /ferievikar|sommervikar|student|legevikar|tilkalling|assistent|ekstravakt/i;

function relevance(job, text) {
  const { title } = job;
  const inTitle = job.match === 'tittel';
  const all = `${title} ${job.employer} ${text}`;
  const reasons = [];
  let score;
  if (inTitle && /lisens/i.test(title)) {
    score = 7;
    reasons.push('Lisensstilling for medisinstudenter');
  } else if (inTitle) {
    score = 6;
    reasons.push('Retter seg direkte mot medisinstudenter');
  } else if (STUDENT_ROLE.test(title) && !OTHER_ROLE.test(title)) {
    score = 4;
    reasons.push('Student-/vikarstilling der medisinstudenter nevnes');
  } else if (!OTHER_ROLE.test(title)) {
    score = 2;
    reasons.push('Medisinstudenter nevnes bare i annonseteksten');
  } else {
    score = 1;
    reasons.push('Først og fremst for en annen yrkesgruppe');
  }
  // Bonusene teller bare for stillinger som faktisk kan passe.
  if (score >= 4) {
    const req = YEAR_REQ.exec(all);
    const year = req && (YEAR_WORDS[req[2].toLowerCase()] || Number(req[2]));
    if (year && year < PROFILE.studyYear) {
      score += 1;
      reasons.push(`Du oppfyller kravet om fullført ${year}. studieår`);
    } else if (year === PROFILE.studyYear) {
      score -= 1;
      reasons.push(`Krever fullført ${year}. studieår – aktuelt først etter dette året`);
    } else if (year > PROFILE.studyYear) {
      score -= 3;
      reasons.push(`Krever fullført ${year}. studieår`);
    }
    const exp = PROFILE.experience.filter(([re]) => re.test(all)).map(([, why]) => why);
    if (exp.length) {
      score += 1;
      reasons.push(...exp);
    }
    const [wanted, bonus, why] = PROFILE.wants;
    if (wanted.test(all)) {
      score += bonus;
      reasons.splice(1, 0, why);
    }
    const region = PROFILE.regionBonus[job.region];
    if (region) {
      score += region[0];
      reasons.push(region[1]);
    }
  }
  score = Math.max(1, Math.min(10, score));
  return { score, level: score >= 8 ? 'høy' : score >= 5 ? 'middels' : 'lav', reason: reasons.join(' · ') };
}

const NAV_QUERIES = ['medisinstudent', 'medisinstudenter', 'medisinerstudent', 'legestudent'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, options = {}, attempt = 1) {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...options.headers },
    signal: AbortSignal.timeout(45000),
  });
  // Vent og prøv igjen hvis kilden ber oss roe ned.
  if (res.status === 429 && attempt < 4) {
    await sleep(attempt * 20000);
    return getJson(url, options, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} fra ${new URL(url).host}`);
  return res.json();
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const titleCase = (s) => clean(s).toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());

// "09/10/2026" eller "09.10.2026" -> "2026-10-09"
function parseNorDate(s) {
  const m = /^(\d{2})[./](\d{2})[./](\d{4})/.exec(s || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (s || '').slice(0, 10);
}

// NAV Arbeidsplassen samler annonser fra bl.a. FINN, Talentech/Webcruiter, Easycruit og Jobbnorge.
async function fetchNav() {
  const jobs = new Map();
  for (const q of NAV_QUERIES) {
    for (let from = 0; from < 500; from += 100) {
      const url = `https://arbeidsplassen.nav.no/stillinger/api/search?q=${encodeURIComponent(q)}&size=100&from=${from}&sort=published`;
      if (jobs.size || from) await sleep(2000);
      const hits = (await getJson(url)).hits?.hits || [];
      for (const { _source: s } of hits) {
        if (jobs.has(s.uuid)) continue;
        const finn = s.medium === 'FINN' && /^\d+$/.test(s.reference || '');
        jobs.set(s.uuid, {
          id: `nav:${s.uuid}`,
          source: finn ? 'FINN' : 'NAV',
          origin: s.medium || '',
          reference: s.reference || '',
          title: clean(s.title),
          employer: clean(s.businessName || s.employer?.name),
          location: [...new Set((s.locationList || []).map((l) => titleCase(l.city || l.municipal || l.county)).filter(Boolean))].join(', '),
          region: regionOf(s.businessName, ...(s.locationList || []).flatMap((l) => [l.city, l.municipal, l.county])),
          published: (s.published || '').slice(0, 10),
          deadline: parseNorDate(s.properties?.applicationdue || s.expires),
          url: finn ? `https://www.finn.no/job/ad/${s.reference}` : `https://arbeidsplassen.nav.no/stillinger/stilling/${s.uuid}`,
          summary: clean(s.generatedSearchMetadata?.shortSummary),
          keywords: keyPoints(`${s.title} ${s.generatedSearchMetadata?.shortSummary || ''}`, s.properties?.searchtagsai || []),
          match: RELEVANT.test(`${s.title} ${(s.categoryList || []).map((c) => c.name).join(' ')}`) ? 'tittel' : 'tekst',
          text: `${s.generatedSearchMetadata?.shortSummary || ''} ${(s.properties?.searchtagsai || []).join(' ')}`,
        });
      }
      if (hits.length < 100) break;
    }
  }
  return [...jobs.values()];
}

async function fetchWebcruiter() {
  const jobs = [];
  for (let skip = 0, total = Infinity; skip < total && skip < 20000; skip += 1000) {
    const data = await getJson('https://candidate.webcruiter.com/api/odvert/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Take: 1000, Skip: skip }),
    });
    total = data.Total || 0;
    for (const a of data.Data || []) {
      const inTitle = RELEVANT.test(a.Heading || '');
      if (!inTitle && !RELEVANT.test(a.Presentation || '')) continue;
      jobs.push({
        id: `webcruiter:${a.Id}`,
        source: 'Webcruiter',
        origin: 'webcruiter',
        reference: String(a.Id),
        title: clean(a.Heading),
        employer: clean(a.CompanyName),
        location: clean(a.Workplace),
        region: regionOf(a.CompanyName, a.Workplace, ...(a.WorkPlaceFacet3 || [])),
        published: parseNorDate(a.PublishedDate),
        deadline: (a.ApplicationDeadline || '').slice(0, 10).replace(/^0001.*/, ''),
        url: (a.OpenAdvertUrl || '').replace('language=en', 'language=nb'),
        summary: clean(a.Presentation).slice(0, 260),
        keywords: keyPoints(`${a.Heading} ${a.Presentation || ''}`),
        match: inTitle ? 'tittel' : 'tekst',
        text: a.Presentation || '',
      });
    }
    if (!(data.Data || []).length) break;
  }
  return jobs;
}

async function fetchJobbnorge() {
  const data = await getJson('https://publicapi.jobbnorge.no/v3/Jobs?abroad=false&orderBy=Published');
  const jobs = [];
  for (const j of data.jobs || []) {
    const inTitle = RELEVANT.test(j.title || '');
    if (!inTitle && !RELEVANT.test(j.summary || '')) continue;
    jobs.push({
      id: `jobbnorge:${j.id}`,
      source: 'Jobbnorge',
      origin: 'jobbnorge',
      reference: String(j.id),
      title: clean(j.title),
      employer: clean(j.employer),
      location: [...new Set((j.locations || []).map((l) => l.municipality || l.area).filter(Boolean))].join(', '),
      region: regionOf(j.employer, ...(j.locations || []).flatMap((l) => [l.municipality, l.area, l.county])),
      published: parseNorDate(j.publicationDate),
      deadline: /^\d{2}\./.test(j.deadline || '') ? parseNorDate(j.deadline) : clean(j.deadline),
      url: j.link,
      summary: clean(j.summary).slice(0, 260),
      keywords: keyPoints(`${j.title} ${j.summary || ''}`),
      match: inTitle ? 'tittel' : 'tekst',
      text: j.summary || '',
    });
  }
  return jobs;
}

const SOURCES = { NAV: fetchNav, Webcruiter: fetchWebcruiter, Jobbnorge: fetchJobbnorge };

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { lastRun: null, sources: {}, jobs: [] };
  }
}

const dupeKey = (j) => `${j.title}|${j.employer}`.toLowerCase().replace(/[^\p{L}\p{N}|]/gu, '');

async function scrape() {
  const store = load();
  const now = new Date().toISOString();
  const known = new Map(store.jobs.map((j) => [j.id, j]));
  const results = await Promise.allSettled(Object.values(SOURCES).map((fn) => fn()));
  const sources = {};
  const fresh = [];

  Object.keys(SOURCES).forEach((name, i) => {
    const r = results[i];
    sources[name] = r.status === 'fulfilled' ? { ok: true, count: r.value.length } : { ok: false, error: String(r.reason?.message || r.reason) };
    if (r.status === 'fulfilled') fresh.push(...r.value);
    else console.error(`[${name}] feilet:`, sources[name].error);
  });

  // Samme annonse kan komme både direkte og via NAV – behold den første (NAV har best metadata).
  // Arbeidsgivernavnet skrives ulikt hos NAV og Webcruiter, så de matches på tittel + frist.
  const seenKeys = new Set();
  const viaNav = new Map();
  const navKey = (j) => `${j.title}|${j.deadline}`.toLowerCase();
  for (const j of fresh) if (j.id.startsWith('nav:')) viaNav.set(navKey(j), (viaNav.get(navKey(j)) || 0) + 1);
  let added = 0;
  for (const job of fresh) {
    const key = dupeKey(job);
    if (seenKeys.has(key)) continue;
    if (job.source === 'Webcruiter' && viaNav.get(navKey(job)) > 0) {
      viaNav.set(navKey(job), viaNav.get(navKey(job)) - 1);
      continue;
    }
    seenKeys.add(key);
    const old = known.get(job.id);
    if (!old) added++;
    const { text, ...rest } = job;
    known.set(job.id, { ...rest, relevance: relevance(job, text), firstSeen: old?.firstSeen || now, lastSeen: now });
  }

  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
  const jobs = [...known.values()]
    .filter((j) => j.lastSeen > cutoff)
    .sort((a, b) => b.published.localeCompare(a.published) || b.firstSeen.localeCompare(a.firstSeen));

  const out = { lastRun: now, sources, jobs };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 1));
  console.log(`[${now}] ${jobs.length} stillinger lagret, ${added} nye`, JSON.stringify(sources));
  return { ...out, added };
}

module.exports = { scrape, load };

if (require.main === module) scrape();
