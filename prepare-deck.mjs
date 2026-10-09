import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { JSDOM } from 'jsdom';

// One-time local conversion for the inspected HSK note model, not a general
// Anki template engine. Never execute imported templates, CSS, or JavaScript.
const root = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] ?? resolve(root, '../Mandarin_Vocabulary_HSK_1-5.apkg'));
const output = resolve(root, 'public/deck');
if ((await stat(source)).size > 500 * 1024 * 1024) throw new Error('Package exceeds the 500 MB conversion limit.');
const bytes = await readFile(source);
const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
const zip = await JSZip.loadAsync(bytes);
const database = zip.file('collection.anki21') ?? zip.file('collection.anki2');
if (!database || zip.file('collection.anki21b')) throw new Error('Unsupported Anki database format.');
const mediaFile = zip.file('media');
if (!mediaFile) throw new Error('Anki media manifest is missing.');
const mapping = JSON.parse(await mediaFile.async('string'));
const filenames = new Map();
for (const [key, name] of Object.entries(mapping)) {
  if (!/^\d+$/.test(key) || typeof name !== 'string' || filenames.has(name)) {
    throw new Error('Invalid or ambiguous media manifest.');
  }
  filenames.set(name, key);
}
const SQL = await initSqlJs();
const db = new SQL.Database(await database.async('uint8array'));
const dom = new JSDOM(''); // No scripts or network resources are enabled.
const mediaToWrite = new Map();
const warnings = [];

function query(sql) {
  const statement = db.prepare(sql);
  const rows = [];
  try { while (statement.step()) rows.push(statement.getAsObject()); }
  finally { statement.free(); }
  return rows;
}

function reference(name, kind) {
  const key = filenames.get(name);
  const extension = kind === 'image' ? 'jpg' : 'mp3';
  if (!name.toLowerCase().endsWith(`.${extension}`) || !key || !zip.file(key)) {
    warnings.push(`Unavailable ${kind}: ${name}`);
    return null;
  }
  // A generated filename prevents archive path traversal and URL injection.
  const safeName = `${createHash('sha256').update(name).digest('hex')}.${extension}`;
  mediaToWrite.set(safeName, key);
  return `media/${safeName}`;
}

function audio(field) {
  const matches = [...field.matchAll(/\[sound:([^\]]+)\]/g)];
  if (matches.length > 1) throw new Error('Multiple clips in one audio field need an explicit mapping.');
  return matches[0] ? reference(matches[0][1], 'audio') : null;
}

function images(field) {
  const container = dom.window.document.createElement('div');
  container.innerHTML = field;
  return [...container.querySelectorAll('img')]
    .map((image) => reference(image.getAttribute('src') ?? '', 'image'))
    .filter(Boolean);
}

try {
  const col = query('SELECT models FROM col')[0];
  if (!col) throw new Error('Missing Anki collection metadata.');
  const models = JSON.parse(col.models);
  const required = ['Key', 'Simplified', 'Homograph', 'Pinyin.1', 'Meaning', 'Part of speech', 'Audio', 'SentenceSimplified', 'SentencePinyin.1', 'SentenceMeaning', 'SentenceAudio', 'SentenceImage'];
  const rows = query('SELECT c.id AS cardId, c.ord, n.mid, n.flds, n.tags FROM cards c JOIN notes n ON n.id = c.nid ORDER BY c.id');
  if (!rows.length) throw new Error('Deck contains no cards.');
  const cards = rows.map((row) => {
    const model = models[String(row.mid)];
    if (model?.name !== 'HSK' || row.ord !== 0 || required.some((name) => !model.flds.some((f) => f.name === name))) {
      throw new Error('Unsupported note model or card variant. Only the inspected HSK recognition cards are supported.');
    }
    const values = row.flds.split('\x1f');
    const fields = Object.fromEntries(model.flds.map((f) => [f.name, values[f.ord] ?? '']));
    return {
      id: `hsk:${row.cardId}`,
      order: Number(fields.Key),
      level: row.tags.match(/\bHSK[1-5]\b/)?.[0] ?? 'HSK',
      word: fields.Simplified,
      homograph: fields.Homograph,
      pinyin: fields['Pinyin.1'],
      meaning: fields.Meaning,
      partOfSpeech: fields['Part of speech'],
      sentence: fields.SentenceSimplified,
      sentencePinyin: fields['SentencePinyin.1'],
      sentenceMeaning: fields.SentenceMeaning,
      wordAudio: audio(fields.Audio),
      sentenceAudio: audio(fields.SentenceAudio),
      englishAudio: null, // This model has no English audio field.
      images: images(fields.SentenceImage),
    };
  });
  if (cards.some((c) => !Number.isFinite(c.order))) throw new Error('Invalid HSK ordering key.');
  cards.sort((a, b) => a.order - b.order);
  const report = {
    cards: cards.length,
    missingEnglishAudio: cards.filter((c) => !c.englishAudio).length,
    missingWordAudio: cards.filter((c) => !c.wordAudio).length,
    missingSentenceAudio: cards.filter((c) => !c.sentenceAudio).length,
    missingImages: cards.filter((c) => !c.images.length).length,
    mediaFiles: mediaToWrite.size,
    sourceSha256,
  };
  await mkdir(resolve(output, 'media'), { recursive: true });
  let total = 0;
  for (const [safeName, key] of mediaToWrite) {
    const entry = await zip.file(key).async('nodebuffer');
    total += entry.length;
    if (entry.length > 20 * 1024 * 1024 || total > 1024 ** 3) throw new Error('Media extraction size limit exceeded.');
    await writeFile(resolve(output, 'media', safeName), entry);
  }
  const deck = { version: 1, id: 'mandarin-hsk-1-5', name: 'Mandarin Vocabulary · HSK 1–5', cards, report };
  // Write the manifest last so failed conversions never advertise incomplete media.
  await writeFile(resolve(output, 'deck.json'), JSON.stringify(deck));
  await writeFile(resolve(output, 'import-report.json'), JSON.stringify({ ...report, warnings }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Prepared ${cards.length} cards locally in public/deck. Original package unchanged.`);
} finally {
  db.close();
  dom.window.close();
}