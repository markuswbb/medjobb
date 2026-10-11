// Kjøres av GitHub Actions: oppdaterer stillingene én gang om dagen (kl. 08 norsk tid) og sender e-post med nye treff.
const { scrape, load } = require('./scraper');

const REGION_TITLES = [['bergen', 'Bergen-området'], ['oslo', 'Oslo-området'], ['', 'Resten av landet']];
const osloTime = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo', dateStyle: 'short', timeStyle: 'short' }).format(d);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function emailHtml(jobs, siteUrl) {
  const sections = REGION_TITLES.map(([key, title]) => {
    const list = jobs.filter((j) => j.region === key);
    if (!list.length) return '';
    const items = list
      .map(
        (j) => `<li style="margin-bottom:12px"><a href="${esc(j.url)}" style="color:#0b6e5b;font-weight:600">${esc(j.title)}</a><br>
        <span style="color:#555">${esc([j.employer, j.location].filter(Boolean).join(' · '))}${j.deadline ? ` · Frist: ${esc(j.deadline)}` : ''}</span>
        ${j.keywords?.length ? `<br><span style="font-size:13px;color:#333">Nøkkelpunkter: ${esc(j.keywords.join(' · '))}</span>` : ''}</li>`
      )
      .join('');
    return `<h3 style="margin:22px 0 8px">${title} (${list.length})</h3><ul style="padding-left:18px;margin:0">${items}</ul>`;
  }).join('');
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#17201d;max-width:620px">
    <h2 style="margin:0">Nye stillinger for medisinstudenter</h2>${sections}
    ${siteUrl ? `<p style="margin-top:26px"><a href="${esc(siteUrl)}" style="color:#0b6e5b">Se alle stillingene på Medjobb</a></p>` : ''}</div>`;
}

async function sendMail(jobs) {
  const { SMTP_USER, SMTP_PASS, MAIL_TO, SITE_URL } = process.env;
  if (!SMTP_USER || !SMTP_PASS || !MAIL_TO) return console.log('E-post er ikke satt opp (mangler SMTP_USER, SMTP_PASS eller MAIL_TO) – hopper over.');
  const transport = require('nodemailer').createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } });
  await transport.sendMail({
    from: `Medjobb <${SMTP_USER}>`,
    to: MAIL_TO,
    subject: `${jobs.length} ${jobs.length === 1 ? 'ny stilling' : 'nye stillinger'} for medisinstudenter`,
    html: emailHtml(jobs, SITE_URL),
  });
  console.log(`E-post sendt med ${jobs.length} stillinger.`);
}

async function main() {
  const now = new Date();
  const [today, time] = osloTime(now).split(' ');
  const last = load().lastRun;
  if (!process.env.FORCE) {
    if (time < '08:00') return console.log(`Klokken er ${time} i Norge – venter til 08:00.`);
    if (last && osloTime(new Date(last)).startsWith(today)) return console.log('Allerede oppdatert i dag.');
  }
  const result = await scrape();
  // Bare annonser som er nye siden sist, og som retter seg direkte mot medisinstudenter.
  const fresh = result.jobs.filter((j) => j.firstSeen === result.lastRun && j.match === 'tittel');
  if (fresh.length) await sendMail(fresh);
  else console.log('Ingen nye relevante stillinger – sender ikke e-post.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
