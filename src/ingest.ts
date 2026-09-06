// src/ingest.ts
import { pool, VECTOR_DIMS } from './db';
import { chunkDocument } from './chunker';
import { parseDocument } from './parsers';
import { embedTexts } from './embeddings';
import { config } from './config';
import { readdir } from 'fs/promises';
import path from 'path';

const SUPPORTED_EXTS = ['.pdf', '.docx', '.doc', '.txt', '.md', '.html', '.htm'];

async function ingestFile(filePath: string, tags: string[] = ['public']) {
  console.log(`Processing ${filePath}`);
  const { text, lang } = await parseDocument(filePath, true);
  if (text.length < 10) {
    console.log(`Skipping ${filePath} (too short)`);
    return;
  }

  const chunks = chunkDocument(
    text,
    path.basename(filePath),
    path.basename(filePath),
    { language: lang, original_filename: path.basename(filePath) },
  );

  if (!chunks.length) {
    console.log(`Skipping ${filePath} (no chunks produced)`);
    return;
  }

  const texts = chunks.map(c => c.content);
  const embeddings = await embedTexts(texts);

  const res = await pool.query<{ id: string }>(
    `INSERT INTO documents (source, title, metadata)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [path.basename(filePath), path.basename(filePath), JSON.stringify({ language: lang })],
  );

  const docId = res.rows[0].id;

  for (let i = 0; i < chunks.length; i++) {
    const emb = embeddings[i];
    const vecStr = '[' + emb.slice(0, VECTOR_DIMS).map((v: number) => parseFloat(v.toFixed(6))).join(',') + ']';

    await pool.query(
      `INSERT INTO chunks (doc_id, content, hash, metadata, embedding, access_tags, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::vector, $6, NOW(), NOW())
       ON CONFLICT (hash) DO NOTHING`,
      [docId, chunks[i].content, chunks[i].hash, JSON.stringify(chunks[i].metadata), vecStr, tags],
    );
  }

  console.log(`Indexed ${path.basename(filePath)}: ${chunks.length} chunks (doc_id=${docId})`);
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkDir(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    if (command === '--reindex') {
      console.log('Reindexing all chunks...');

      const chunks = await pool.query<{ id: string; content: string }>(
        'SELECT id, content FROM chunks WHERE content IS NOT NULL',
      );

      const total = chunks.rowCount;
      console.log(`Found ${total} chunks to reindex`);

      let processed = 0;
      const batchSize = 64;

      for (let i = 0; i < (chunks.rowCount ?? 0); i += batchSize) {
        const batch = chunks.rows.slice(i, i + batchSize);
        const texts = batch.map(c => c.content);
        const embeddings = await embedTexts(texts);

        for (let j = 0; j < batch.length; j++) {
          const emb = embeddings[j];
          const vecStr = '[' + emb.slice(0, VECTOR_DIMS).map((v: number) => parseFloat(v.toFixed(6))).join(',') + ']';
          await pool.query(
            'UPDATE chunks SET embedding = $1::vector, updated_at = NOW() WHERE id = $2',
            [vecStr, batch[j].id],
          );
        }

        processed += batch.length;
        console.log(`Processed ${processed}/${total}`);
      }

      console.log(`Reindexing complete: ${processed} chunks`);
    } else if (command === '--source' && args[1]) {
      const dir = args[1];
      const tags = args.includes('--tags') ? args[args.indexOf('--tags') + 1]?.split(',') ?? ['public'] : ['public'];
      const files = await walkDir(dir);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (SUPPORTED_EXTS.includes(ext)) {
          await ingestFile(file, tags);
        }
      }
    } else if (command === '--file' && args[1]) {
      await ingestFile(args[1]);
    } else {
      console.log('Usage: ts-node src/ingest.ts --source <dir> | --file <file> | --reindex');
    }
  } catch (err) {
    console.error('Ingest failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
