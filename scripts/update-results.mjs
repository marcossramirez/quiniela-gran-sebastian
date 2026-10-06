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

const lotteries = [
  ['ciudad', 'Ciudad', /CIUDAD DE BS/],
  ['provincia', 'Provincia', /^PROVINCIA DE BS/],
  ['cordoba', 'Córdoba', /CORDOBA/],
  ['santafe', 'Santa Fe', /SANTA FE/],
  ['entrerios', 'Entre Ríos', /ENTRE RIOS/],
  ['montevideo', 'Montevideo', /MONTEVIDEO/]
];
const plain = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

function readNumbers(list) {
  const byPosition = new Map();
  for (const item of list ?? []) {
    const position = Number(item.pos);
    const value = String(item.val).trim();
    if (position >= 1 && position <= 20 && /^\d{4}$/.test(value)) byPosition.set(position, value);
  }
  return byPosition.size === 20 ? Array.from({ length: 20 }, (_, index) => byPosition.get(index + 1)) : null;
}

async function drawNumbers(id) {
  const raw = await getHtml(`${site}includes/resultados-data.php?sorteo=${id}`);
  // La respuesta es JavaScript ("window.RESULTADOS_DATA = [...];"), así que se recorta el JSON de adentro.
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error(`No pude leer los datos del sorteo ${id}: "${text(raw).slice(0, 200)}"`);
  }
  const entries = Array.isArray(data) ? data : [data];
  const entry = entries.find(item => Number(item?.sorteo) === Number(id));
  if (!entry) throw new Error(`La respuesta no incluye el sorteo ${id} (trae: ${entries.map(item => item?.sorteo).join(', ') || 'nada'})`);

  const jurisdictions = Object.values(entry.jurisdicciones ?? {});
  const found = {};
  for (const [key, label, pattern] of lotteries) {
    const jurisdiction = jurisdictions.find(item => pattern.test(plain(item?.nombre)));
    const numbers = jurisdiction ? readNumbers(jurisdiction.numeros) : null;
    if (!numbers) {
      if (key === 'ciudad') throw new Error(`El sorteo ${id} no trae los 20 números de Ciudad (hay: ${jurisdictions.map(item => item?.nombre).join(', ') || 'ninguna jurisdicción'})`);
      console.warn(`${label}: sin números válidos en el sorteo ${id}`);
    }
    found[key] = numbers ?? [];
  }

  // Control cruzado: la lista "Tradicional" del mismo sorteo es la de Ciudad y tiene que coincidir.
  const traditional = entry.numeros_juegos?.Tradicional;
  if (Array.isArray(traditional) && traditional.length >= 20 && !found.ciudad.every((value, index) => String(traditional[index]) === value)) {
    throw new Error(`Los números de Ciudad del sorteo ${id} no coinciden con la lista "Tradicional" del mismo JSON`);
  }
  return found;
}

function dateFor(offset) {
  const [day, month, year] = dayFormat.format(new Date()).split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset, 12));
  const iso = [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('-');
  return { label: dayFormat.format(date), iso };
}

async function buildDay(draws, offset) {
  const target = dateFor(offset);
  const others = lotteries.slice(1).map(([key]) => key);
  const day = { date: target.iso, draws: [], loterias: Object.fromEntries(others.map(key => [key, []])) };
  for (const [officialName, displayName] of modes) {
    const match = draws.find(draw => draw.label.includes(target.label) && draw.label.includes(officialName));
    let found = {};
    if (match) {
      try {
        found = await drawNumbers(match.id);
        const withNumbers = Object.values(found).filter(numbers => numbers.length).length;
        console.log(`${target.label} ${displayName}: sorteo ${match.id}, ${withNumbers} de ${lotteries.length} loterías con números`);
      } catch (error) {
        console.warn(`${target.label} ${displayName}: ERROR ${error.message}`);
      }
    } else {
      console.log(`${target.label} ${displayName}: todavía no publicado en la fuente`);
    }
    day.draws.push({ name: displayName, numbers: found.ciudad ?? [] });
    for (const key of others) day.loterias[key].push({ name: displayName, numbers: found[key] ?? [] });
  }
  return day;
}

const draws = await availableDraws();
const previous = JSON.parse(await readFile(new URL('../data/results.json', import.meta.url), 'utf8'));
const archiveUrl = new URL('../data/archive.json', import.meta.url);
const archive = JSON.parse(await readFile(archiveUrl, 'utf8'));

// Si un sorteo viene vacío pero ya teníamos sus números guardados (misma fecha), se conservan.
function keepOld(day) {
  const old = [previous.today, previous.yesterday, archive[day.date]].filter(item => item?.date === day.date);
  const restore = (list, pick) => {
    for (const draw of list) {
      if (draw.numbers.length) continue;
      for (const item of old) {
        const before = pick(item)?.find(d => d.name === draw.name);
        if (before?.numbers?.length) { draw.numbers = before.numbers; break; }
      }
    }
  };
  restore(day.draws, item => item.draws);
  for (const key of Object.keys(day.loterias)) restore(day.loterias[key], item => item.loterias?.[key]);
  return day;
}

const output = {
  updatedAt: new Date().toISOString(),
  today: keepOld(await buildDay(draws, 0)),
  yesterday: keepOld(await buildDay(draws, -1))
};

await writeFile(new URL('../data/results.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
// El archivo histórico guarda solo Ciudad (es lo que usa MIS JUGADAS) para que no crezca de más.
for (const item of [output.today, output.yesterday]) if (item.draws.some(draw => draw.numbers.length)) archive[item.date] = { date: item.date, draws: item.draws };
await writeFile(archiveUrl, `${JSON.stringify(archive, null, 2)}\n`);
console.log('Listo: results.json y archive.json actualizados');
