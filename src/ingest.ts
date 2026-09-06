// src/ingest.ts
import { pool } from './db';
import { chunkDocument } from './chunker';
import { parseDocument } from './parsers';
import { config } from './config';
import { indexDocument, reindexAllEmbeddings, backfillSearchText } from './indexer';
import { readdir } from 'fs/promises';
import path from 'path';

const SUPPORTED_EXTS = ['.pdf', '.docx', '.doc', '.txt', '.md', '.html', '.htm'];

async function ingestFile(filePath: string, tags: string[] = ['public']) {
  console.log(`Processing ${filePath}`);
  const { text, lang } = await parseDocument(filePath, config.SCRUB_PII);
  if (text.length < 10) {
    console.log(`Skipping ${filePath} (too short)`);
    return;
  }

  const base = path.basename(filePath);
  const chunks = chunkDocument(text, base, base, {
    language: lang,
    original_filename: base,
  });

  if (!chunks.length) {
    console.log(`Skipping ${filePath} (no chunks produced)`);
    return;
  }

  try {
    const result = await indexDocument({
      source: base,
      title: base,
      language: lang,
      metadata: { original_filename: base },
      chunks,
      accessTags: tags,
    });

    console.log(
      `Indexed ${base}: ${result.chunksInserted}/${result.chunksTotal} chunks ` +
      `(doc_id=${result.docId})`,
    );
  } catch (err) {
    console.error(`Failed to index ${base}: ${(err as Error).message}`);
  }
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
    if (command === '--backfill-text') {
      console.log('Backfilling search_text for legacy chunks...');
      const processed = await backfillSearchText();
      console.log(`Backfill complete: ${processed} chunks`);
    } else if (command === '--reindex') {
      console.log('Reindexing all chunks...');
      const processed = await reindexAllEmbeddings();
      console.log(`Reindexing complete: ${processed} chunks`);
    } else if (command === '--source' && args[1]) {
      const dir = args[1];
      const tags = args.includes('--tags')
        ? args[args.indexOf('--tags') + 1]?.split(',') ?? ['public']
        : ['public'];
      const files = await walkDir(dir);

      const targets = files.filter(f => SUPPORTED_EXTS.includes(path.extname(f).toLowerCase()));
      if (!targets.length) {
        console.warn(`No supported documents found under ${dir}`);
      }

      for (const file of targets) {
        await ingestFile(file, tags);
      }
    } else if (command === '--file' && args[1]) {
      await ingestFile(args[1]);
    } else {
      console.log(
        'Usage: ts-node src/ingest.ts --source <dir> | --file <file> | --reindex | --backfill-text',
      );
    }
  } catch (err) {
    console.error('Ingest failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
