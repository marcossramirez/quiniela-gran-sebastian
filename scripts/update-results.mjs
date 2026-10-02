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
  const raw = await getHtml(`${site}includes/resultados-data.php?sorteo=${id}`);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`La respuesta del sorteo ${id} no es JSON: "${text(raw).slice(0, 200)}"`);
  }
  if (!new RegExp(`\\b${id}\\b`).test(raw)) console.warn(`Aviso: el JSON del sorteo ${id} no menciona ese número de sorteo`);

  // Busca, en cualquier parte del JSON, listas de 20 elementos con {pos, val}, y listas "Tradicional".
  const candidates = [];
  const tradicional = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      if (node.length === 20 && node.every(item => item && typeof item === 'object' && 'pos' in item && 'val' in item)) candidates.push({ path, list: node });
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'Tradicional' && Array.isArray(value)) tradicional.push(value.map(String));
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(data, '');

  let city = candidates.length === 1 ? candidates[0] : candidates.find(item => /ciudad|caba|buenos|bs ?as/i.test(item.path));
  if (!city) {
    throw new Error(`No pude identificar los números de Ciudad en el sorteo ${id} (candidatos: ${candidates.map(item => item.path).join(' | ') || 'ninguno'}; claves: ${Object.keys(data).join(', ')})`);
  }
  console.log(`Sorteo ${id}: números tomados de "${city.path || '(raíz)'}" (${candidates.length} candidatos)`);

  const byPosition = new Map();
  for (const item of city.list) {
    const position = Number(item.pos);
    const value = String(item.val).trim();
    if (position >= 1 && position <= 20 && /^\d{4}$/.test(value)) byPosition.set(position, value);
  }
  if (byPosition.size !== 20) throw new Error(`El sorteo ${id} no contiene los 20 números de Ciudad (encontré ${byPosition.size})`);
  const numbers = Array.from({ length: 20 }, (_, index) => byPosition.get(index + 1));

  // Control cruzado: si el JSON trae la lista "Tradicional", tiene que coincidir con la que usamos.
  if (tradicional.length && !tradicional.some(list => list.length === 20 && list.every((value, index) => value === numbers[index]))) {
    throw new Error(`Los números del sorteo ${id} no coinciden con la lista "Tradicional" del mismo JSON`);
  }
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
