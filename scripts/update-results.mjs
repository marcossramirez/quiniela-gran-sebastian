import * as cheerio from 'cheerio';
import { readFile, writeFile } from 'node:fs/promises';

const site = 'https://quiniela.loteriadelaciudad.gob.ar/';
const modes = [
  ['PREVIA', 'La Previa'], ['PRIMERA', 'La Primera'], ['MATUTINA', 'Matutina'],
  ['VESPERTINA', 'Vespertina'], ['NOCTURNA', 'Nocturna']
];
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric'
});
const text = value => value.replace(/\s+/g, ' ').trim();

async function getHtml(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'quiniela-abuelo-resultados/1.0' } });
  if (!response.ok) throw new Error(`La fuente oficial respondió ${response.status}`);
  return response.text();
}

async function availableDraws() {
  const $ = cheerio.load(await getHtml(site));
  const draws = [];
  $('option').each((_, option) => {
    const label = text($(option).text()).toUpperCase();
    const id = $(option).attr('value')?.match(/\d{4,}/)?.[0];
    if (id && /SORTEO/.test(label)) draws.push({ id, label });
  });
  return draws;
}

async function cityNumbers(id) {
  const $ = cheerio.load(await getHtml(`${site}extractoOficial.php?sorteo=${id}`));
  const table = $('#e1').first();
  const headers = table.find('tr').first().find('th,td').map((_, cell) => text($(cell).text()).toUpperCase()).get();
  const cityIndex = headers.indexOf('CIUDAD');
  if (cityIndex < 0) throw new Error(`No se encontró la columna CIUDAD para el sorteo ${id}`);
  const numbers = table.find('tr').slice(1).map((_, row) => {
    const cells = $(row).find('td').map((_, cell) => text($(cell).text())).get();
    return cells[cityIndex] || null;
  }).get().filter(value => /^\d{4}$/.test(value));
  if (numbers.length !== 20) throw new Error(`El sorteo ${id} no contiene los 20 números de Ciudad`);
  return numbers;
}

function dateFor(offset) {
  const [day, month, year] = dayFormat.format(new Date()).split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset, 12));
  const iso = [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('-');
  return { label: dayFormat.format(date), iso };
}

async function buildDay(draws, offset) {
  const target = dateFor(offset);
  const results = [];
  for (const [officialName, displayName] of modes) {
    const match = draws.find(draw => draw.label.includes(target.label) && draw.label.includes(officialName));
    let numbers = [];
    if (match) {
      try { numbers = await cityNumbers(match.id); }
      catch (error) { console.warn(`${displayName}: ${error.message}`); }
    }
    results.push({ name: displayName, numbers });
  }
  return { date: target.iso, draws: results };
}

const draws = await availableDraws();
const previous = JSON.parse(await readFile(new URL('../data/results.json', import.meta.url), 'utf8'));
const output = {
  updatedAt: new Date().toISOString(),
  today: await buildDay(draws, 0),
  yesterday: await buildDay(draws, -1)
};
if (!output.today.draws.some(draw => draw.numbers.length) && previous.today?.date === output.today.date) output.today = previous.today;
await writeFile(new URL('../data/results.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
const archiveUrl = new URL('../data/archive.json', import.meta.url);
const archive = JSON.parse(await readFile(archiveUrl, 'utf8'));
for (const item of [output.today, output.yesterday]) if (item.draws.some(draw => draw.numbers.length)) archive[item.date] = item;
await writeFile(archiveUrl, `${JSON.stringify(archive, null, 2)}\n`);
