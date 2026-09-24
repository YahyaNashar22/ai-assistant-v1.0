import { Injectable } from '@nestjs/common';

import { Pool } from 'pg';
import { GoogleGenAI } from '@google/genai';
import { ConfigService } from '@nestjs/config';

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
    const embedding = await this.createEmbedding(content);

    await this.db.query(
        `
        INSERT INTO documents (content, embedding)
        VALUES ($1, $2)
        `,
        [content, JSON.stringify(embedding)]
    );

    return {
        message: 'Document added'
    }
  }
}
