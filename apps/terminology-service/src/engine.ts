import { createRequire } from "node:module";
import { DOMAIN_THRESHOLDS, type ContextDomain, type TerminologySystem } from "./rules.js";
import { VocabularyDb } from "./vocabulary-db.js";

const require = createRequire(import.meta.url);
const TfIdf = require("natural/lib/natural/tfidf/tfidf");
const { WordTokenizer } = require("natural/lib/natural/tokenizers");

export interface MapRequest {
  concept_text: string;
  source_system: TerminologySystem;
  target_system: TerminologySystem;
  context_domain: ContextDomain;
}

export interface MapCandidate {
  code: string;
  display: string;
  system: string;
  score: number;
}

export interface MapResponse {
  mapped_code: string;
  mapped_display: string;
  mapped_system: string;
  confidence: number;
  mapping_tier: "RULE" | "EMBED" | "LLM" | "UNMAPPABLE";
  flags: string[];
  candidates: MapCandidate[];
  release_id: string;
}

interface IndexedTerm {
  display: string;
  code: string;
  system: TerminologySystem;
  contextDomains: Set<ContextDomain>;
  vector: Record<string, number>;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(tokenizer: any, text: string): string[] {
  return tokenizer
    .tokenize(normalize(text))
    .map((token: string) => token.trim())
    .filter((token: string) => token.length > 1);
}

function cosineSimilarity(query: Record<string, number>, doc: Record<string, number>): number {
  const terms = new Set([...Object.keys(query), ...Object.keys(doc)]);
  let dot = 0;
  let queryNorm = 0;
  let docNorm = 0;

  for (const term of terms) {
    const q = query[term] ?? 0;
    const d = doc[term] ?? 0;
    dot += q * d;
    queryNorm += q * q;
    docNorm += d * d;
  }

  if (queryNorm === 0 || docNorm === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(queryNorm) * Math.sqrt(docNorm))));
}

function domainsForOmopDomain(domain: string): ContextDomain[] {
  const lower = domain.toLowerCase();
  if (lower === "condition") return ["diagnosis"];
  if (lower === "drug") return ["medication"];
  if (lower === "measurement") return ["lab", "vital"];
  if (lower === "procedure") return ["procedure"];
  if (lower === "observation") return ["administrative"];
  return ["administrative"];
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class TerminologyEngine {
  private readonly tokenizer = new WordTokenizer();
  private readonly tfidf = new TfIdf();
  private indexedTerms: IndexedTerm[] = [];
  private indexReady = false;

  constructor(
    private readonly db: VocabularyDb,
    private readonly releaseId: string,
    private readonly tier2Enabled: boolean,
    private readonly indexMaxRows: number
  ) {}

  async initializeIndex(): Promise<void> {
    this.indexReady = false;
    this.indexedTerms = [];
    this.tfidf.documents = [];

    const rows = await this.db.getIndexRows(this.indexMaxRows > 0 ? this.indexMaxRows : undefined);

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const tokens = tokenize(this.tokenizer, row.display);
      this.tfidf.addDocument(tokens);
      const docIndex = this.tfidf.documents.length - 1;
      const unique = [...new Set(tokens)];
      const vector: Record<string, number> = {};
      for (const term of unique) {
        vector[term] = this.tfidf.tfidf(term, docIndex);
      }

      this.indexedTerms.push({
        display: row.display,
        code: row.code,
        system: row.system,
        contextDomains: new Set(domainsForOmopDomain(row.domain)),
        vector
      });

      // Prevent long CPU-bound indexing from starving health/readiness handlers.
      if (i > 0 && i % 250 === 0) {
        await yieldToEventLoop();
      }
    }
    this.indexReady = true;
  }

  getReleaseId(): string {
    return this.releaseId;
  }

  async getStats(): Promise<Record<string, number>> {
    return this.db.getStats();
  }

  async ping(): Promise<void> {
    await this.db.ping();
  }

  async mapConcept(request: MapRequest): Promise<MapResponse> {
    const tier1 = await this.db.tier1MapByCode(request.concept_text, request.source_system, request.target_system);
    if (tier1) {
      return {
        mapped_code: tier1.mapped_code,
        mapped_display: tier1.mapped_display,
        mapped_system: tier1.mapped_system,
        confidence: 1,
        mapping_tier: "RULE",
        flags: [],
        candidates: [],
        release_id: this.releaseId
      };
    }

    if (!this.tier2Enabled) {
      return {
        mapped_code: "",
        mapped_display: "",
        mapped_system: request.target_system,
        confidence: 0,
        mapping_tier: "UNMAPPABLE",
        flags: ["MAPPING_NO_VIABLE_CANDIDATE"],
        candidates: [],
        release_id: this.releaseId
      };
    }

    if (!this.indexReady || this.indexedTerms.length === 0) {
      return {
        mapped_code: "",
        mapped_display: "",
        mapped_system: request.target_system,
        confidence: 0,
        mapping_tier: "UNMAPPABLE",
        flags: ["MAPPING_TIER2_INDEX_NOT_READY"],
        candidates: [],
        release_id: this.releaseId
      };
    }

    const queryTokens = tokenize(this.tokenizer, request.concept_text);
    const queryVector: Record<string, number> = {};
    for (const token of queryTokens) {
      queryVector[token] = (queryVector[token] ?? 0) + 1;
    }

    const candidates = this.indexedTerms
      .filter((row) => row.system === request.target_system && row.contextDomains.has(request.context_domain))
      .map((row) => ({
        code: row.code,
        display: row.display,
        system: row.system,
        score: Number(cosineSimilarity(queryVector, row.vector).toFixed(4))
      }))
      .sort((a, b) => b.score - a.score)
      .filter(
        (candidate, index, array) =>
          array.findIndex((row) => row.code === candidate.code && row.system === candidate.system) === index
      )
      .slice(0, 3);

    const top = candidates[0];
    const threshold = DOMAIN_THRESHOLDS[request.context_domain];

    if (!top || top.score < 0.4) {
      return {
        mapped_code: "",
        mapped_display: "",
        mapped_system: request.target_system,
        confidence: top?.score ?? 0,
        mapping_tier: "UNMAPPABLE",
        flags: ["MAPPING_NO_VIABLE_CANDIDATE"],
        candidates,
        release_id: this.releaseId
      };
    }

    if (top.score < threshold) {
      return {
        mapped_code: top.code,
        mapped_display: top.display,
        mapped_system: top.system,
        confidence: top.score,
        mapping_tier: "EMBED",
        flags: ["MAPPING_BELOW_THRESHOLD"],
        candidates,
        release_id: this.releaseId
      };
    }

    return {
      mapped_code: top.code,
      mapped_display: top.display,
      mapped_system: top.system,
      confidence: top.score,
      mapping_tier: "EMBED",
      flags: [],
      candidates,
      release_id: this.releaseId
    };
  }

  async mapBatch(requests: MapRequest[]): Promise<MapResponse[]> {
    const responses: MapResponse[] = [];
    for (const request of requests) {
      responses.push(await this.mapConcept(request));
    }
    return responses;
  }

  async lookupByCodeAndSystem(code: string, system: TerminologySystem) {
    return this.db.lookupByCodeAndSystem(code, system);
  }
}
