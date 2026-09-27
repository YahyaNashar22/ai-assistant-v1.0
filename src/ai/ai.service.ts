import { Injectable } from '@nestjs/common';

import { Pool } from 'pg';
import { GoogleGenAI } from '@google/genai';
import { ConfigService } from '@nestjs/config';

import { z } from 'zod';

const SupportAnswerSchema = z.object({
  answer: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  needsHuman: z.boolean(),
});

type SupportAnswer = z.infer<typeof SupportAnswerSchema>;

const supportAnswerJsonSchema = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'Answer to the user question',
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Confidence based on the provided context',
    },
    needsHuman: {
      type: 'boolean',
      description: 'Whether a human support agent should handle this question',
    },
  },
  required: ['answer', 'confidence', 'needsHuman'],
  additionalProperties: false,
};

@Injectable()
export class AiService {
  private readonly db: Pool;
  private readonly ai: GoogleGenAI;

  constructor(private readonly config: ConfigService) {
    this.db = new Pool({
      connectionString: this.config.get<string>('DATABASE_URL'),
    });

    this.ai = new GoogleGenAI({
      apiKey: this.config.get<string>('GEMINI_API_KEY'),
    });
  }

  async testGemini() {
    const response = await this.ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: 'Explain RAG in one sentence.',
    });

    return {
      answer: response.text,
    };
  }

  private async createEmbedding(text: string): Promise<number[]> {
    const response = await this.ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: text,
      config: {
        outputDimensionality: 768,
      },
    });

    const embedding = response.embeddings?.[0]?.values;

    if (!embedding) {
      throw new Error('Failed to generate embedding');
    }

    return embedding;
  }

  async addDocument(content: string) {
    const chunks = this.chunkText(content);

    for (const chunk of chunks) {
      const embedding = await this.createEmbedding(content);

      await this.db.query(
        `
            INSERT INTO documents (content, embedding)
            VALUES ($1, $2)
            `,
        [chunk, JSON.stringify(embedding)],
      );
    }

    return {
      chunksCreated: chunks.length,
    };
  }

  async search(question: string) {
    const embedding = await this.createEmbedding(question);
    const result = await this.db.query(
      `
        SELECT id, content, embedding <=> $1 AS distance FROM documents ORDER BY embedding <=> $1 LIMIT 3
        `,
      [JSON.stringify(embedding)],
    );

    return result.rows;
  }

  async ask(question: string) {
    const embedding = await this.createEmbedding(question);

    const result = await this.db.query(
      `SELECT content FROM documents ORDER BY embedding <=> $1 LIMIT 3`,
      [JSON.stringify(embedding)],
    );

    // similarity threshold ( to not always return 3 even if ntg is relevant )
    const relevantRows = result.rows.filter(
      (row) => Number(row.distance) < 0.6,
    );

    if (relevantRows.length === 0) {
      return {
        answer: 'I could not find relevant information in the knowledge base.',
        confidence: 'low',
        needsHuman: true,
        sources: [],
      };
    }

    const context = relevantRows.map((row) => row.content).join('\n\n');

    const prompt = `
    You are a customer support assistant.
    
    Answer the question using ONLY the context below.
    
    If the answer cannot be found in the context,
    say "I don't know based on the available documents."
    
    CONTEXT:
    
    ${context}
    
    QUESTION:
    
    ${question}
    `;

    const response = await this.ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: supportAnswerJsonSchema,
      },
    });

    if (!response.text) {
      throw new Error('Gemini returned no response');
    }

    const parsed = SupportAnswerSchema.parse(JSON.parse(response.text));

    return {
      ...parsed,

      sources: result.rows.map((row) => ({
        id: row.id,
        content: row.content,
        distance: row.distance,
      })),
    };
  }

  private chunkText(text: string, size = 1000, overlap = 200): string[] {
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += size - overlap) {
      chunks.push(text.slice(i, i + size));
    }

    return chunks;
  }
}
