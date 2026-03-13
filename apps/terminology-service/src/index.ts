import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { createTerminologyApp } from "./app.js";
import { getTerminologyServiceConfig } from "./config.js";
import { TerminologyEngine } from "./engine.js";
import { VocabularyDb } from "./vocabulary-db.js";

async function downloadAthenaZip(downloadUrl: string, outZipPath: string): Promise<void> {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Athena download failed with status ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(outZipPath), { recursive: true });
  fs.writeFileSync(outZipPath, bytes);
}

function extractZip(zipPath: string, destinationDir: string): void {
  const zip = new AdmZip(zipPath);
  fs.mkdirSync(destinationDir, { recursive: true });
  zip.extractAllTo(destinationDir, true);
}

const config = getTerminologyServiceConfig();

const vocabularyDb = new VocabularyDb({
  databaseUrl: config.databaseUrl,
  schema: config.dbSchema
});

await vocabularyDb.init();

if (config.autoLoadOnStart) {
  const loadState = await vocabularyDb.getLoadState();
  const needsLoad =
    loadState.conceptCount === 0 ||
    loadState.relationshipCount === 0 ||
    loadState.synonymCount === 0 ||
    loadState.loadMetadataCount === 0;

  if (needsLoad) {
    console.log(
      `terminology: load required (concept=${loadState.conceptCount}, relationship=${loadState.relationshipCount}, synonym=${loadState.synonymCount}, metadata=${loadState.loadMetadataCount})`
    );
    if (config.athenaDownloadUrl) {
      const zipPath = path.join(config.athenaVocabDir, "athena-vocabulary.zip");
      await downloadAthenaZip(config.athenaDownloadUrl, zipPath);
      extractZip(zipPath, config.athenaVocabDir);
    }

    await vocabularyDb.loadVocabularyFromDirectory(config.athenaVocabDir, config.releaseId);
    const postLoadState = await vocabularyDb.getLoadState();
    console.log(
      `terminology: load complete (concept=${postLoadState.conceptCount}, relationship=${postLoadState.relationshipCount}, synonym=${postLoadState.synonymCount}, metadata=${postLoadState.loadMetadataCount})`
    );
  }
}

const engine = new TerminologyEngine(
  vocabularyDb,
  config.releaseId,
  config.enableTier2Embedding,
  config.indexMaxRows
);
const app = createTerminologyApp(engine, config.serviceVersion);

app.listen(config.port, () => {
  console.log(`terminology-service listening on ${config.port}`);
});

void engine
  .initializeIndex()
  .then(() => {
    console.log("terminology: tier2 index ready");
  })
  .catch((error: unknown) => {
    console.error("terminology: tier2 index build failed", error);
  });
