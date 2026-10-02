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
  console.log(`GET ${url} -> ${response.status}`);
  if (!response.ok) throw new Error(`La fuente oficial respondió ${response.status}`);
  return response.text();
}

async function availableDraws() {
  const html = await getHtml(site);
  const $ = cheerio.load(html);
  const draws = [];
  $('li.custom-option, option').each((_, item) => {
    const label = text($(item).text()).toUpperCase();
    const id = ($(item).attr('data-value') || $(item).attr('value'))?.match(/\d{4,}/)?.[0];
    if (id && /SORTEO/.test(label)) draws.push({ id, label });
  });
  console.log(`HTML: ${html.length} caracteres, ${$('li.custom-option, option').length} opciones, ${draws.length} sorteos detectados`);
  if (!draws.length) {
    console.log('Primeros 600 caracteres recibidos:', text(html).slice(0, 600));
    throw new Error('No se detectó ningún sorteo en la fuente (bloqueo o cambio de formato)');
  }
  console.log('Ejemplo de sorteo detectado:', JSON.stringify(draws[0]));
  return draws;
}

async function cityNumbers(id) {
  const $ = cheerio.load(await getHtml(`${site}index.php?sorteo=${id}`));
  const content = $('#resultadosContent');
  const header = text(content.find('.sorteo-main-header').text());
  // Seguridad: la página tiene que ser realmente la del sorteo pedido (si no, se guardarían números de otro sorteo).
  if (!new RegExp(`\\b${id}\\b`).test(header)) {
    throw new Error(`La página no corresponde al sorteo ${id} (cabecera: "${header.slice(0, 80)}", bolillas: ${content.find('.bolilla-pill').length}, texto del contenedor: ${text(content.text()).length} caracteres)`);
  }
  const panel = content.find('.jur-panel--primary').first();
  const label = text(panel.find('.jur-label').text()).toUpperCase();
  if (!label.includes('CIUDAD')) throw new Error(`El panel principal no es CIUDAD (dice "${label}")`);
  const byPosition = new Map();
  panel.find('.bolilla-pill').each((_, pill) => {
    const position = Number(text($(pill).find('.bolilla-pos').text()));
    const value = text($(pill).find('.bolilla-val').text());
    if (position >= 1 && position <= 20 && /^\d{4}$/.test(value)) byPosition.set(position, value);
  });
  if (byPosition.size !== 20) throw new Error(`El sorteo ${id} no contiene los 20 números de Ciudad (encontré ${byPosition.size})`);
  return Array.from({ length: 20 }, (_, index) => byPosition.get(index + 1));
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
      try {
        numbers = await cityNumbers(match.id);
        console.log(`${target.label} ${displayName}: sorteo ${match.id}, ${numbers.length} números`);
      } catch (error) {
        console.warn(`${target.label} ${displayName}: ERROR ${error.message}`);
      }
    } else {
      console.log(`${target.label} ${displayName}: todavía no publicado en la fuente`);
    }
    results.push({ name: displayName, numbers });
  }
  return { date: target.iso, draws: results };
}

const draws = await availableDraws();
const previous = JSON.parse(await readFile(new URL('../data/results.json', import.meta.url), 'utf8'));
const archiveUrl = new URL('../data/archive.json', import.meta.url);
const archive = JSON.parse(await readFile(archiveUrl, 'utf8'));

// Si un sorteo viene vacío pero ya teníamos sus números guardados (misma fecha), se conservan.
function keepOld(day) {
  const old = [previous.today, previous.yesterday, archive[day.date]].filter(item => item?.date === day.date);
  for (const draw of day.draws) {
    if (draw.numbers.length) continue;
    for (const item of old) {
      const prev = item.draws?.find(d => d.name === draw.name);
      if (prev?.numbers?.length) { draw.numbers = prev.numbers; break; }
    }
  }
  return day;
}

const output = {
  updatedAt: new Date().toISOString(),
  today: keepOld(await buildDay(draws, 0)),
  yesterday: keepOld(await buildDay(draws, -1))
};

await writeFile(new URL('../data/results.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
for (const item of [output.today, output.yesterday]) if (item.draws.some(draw => draw.numbers.length)) archive[item.date] = item;
await writeFile(archiveUrl, `${JSON.stringify(archive, null, 2)}\n`);
console.log('Listo: results.json y archive.json actualizados');
