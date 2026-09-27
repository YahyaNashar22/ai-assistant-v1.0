import { Injectable } from '@nestjs/common';

import { Pool } from 'pg';
import { Content, FunctionDeclaration, GoogleGenAI, Type } from '@google/genai';
import { ConfigService } from '@nestjs/config';

import { z } from 'zod';
import { TicketService } from '../ticket/ticket.service.js';

const SupportAnswerSchema = z.object({
  answer: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  needsHuman: z.boolean(),
});

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

const getTicketStatusFunction: FunctionDeclaration = {
  name: 'get_ticket_status',

  description:
    'Get the current status of a support ticket using its ticket ID.',

  parameters: {
    type: Type.OBJECT,

    properties: {
      ticketId: {
        type: Type.NUMBER,

        description: 'The numeric ID of the support ticket.',
      },
    },

    required: ['ticketId'],
  },
};

const TicketArgsSchema = z.object({
  ticketId: z.coerce.number().int().positive(),
});

@Injectable()
export class AiService {
  private readonly db: Pool;
  private readonly ai: GoogleGenAI;
  private readonly ticketService: TicketService;

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

  async ticketAssistant(question: string) {
    // 1. Ask gemini
    const response = await this.ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: question,
      config: {
        tools: [
          {
            functionDeclarations: [getTicketStatusFunction],
          },
        ],
      },
    });

    // 2. did gemini request a function ?
    const functionCall = response.functionCalls?.[0];

    if (!functionCall) {
      return {
        answer: response.text,
      };
    }

    // 3. execute requested function
    let result: unknown;

    switch (functionCall.name) {
      case 'get_ticket_status': {
        const ticketId = Number(functionCall.args?.ticketId);
        result = this.ticketService.getStatus(ticketId);
        break;
      }
      default:
        throw new Error(`Unknown function: ${functionCall.name}`);
    }

    // 4.build conversation

    const modelContent = response.candidates?.[0].content;

    if (!modelContent) {
      throw new Error('Gemini returned no model content');
    }

    const contents = [
      {
        role: 'user',
        parts: [
          {
            text: question,
          },
        ],
      },

      modelContent,

      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: functionCall.name,

              response: {
                result,
              },
            },
          },
        ],
      },
    ];

    // 5. give tool result back to gemini
    const finalResponse = await this.ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents,
      config: {
        tools: [
          {
            functionDeclarations: [getTicketStatusFunction],
          },
        ],
      },
    });

    // 6. final answer
    return {
      answer: finalResponse.text,
    };
  }

  async chat(question: string) {
    const embedding = await this.createEmbedding(question);

    const result = await this.db.query(
      `
       SELECT id, content, embedding <=> $1 AS distance
       FROM documents
       ORDER BY embedding <=> $1
       LIMIT 3 
        `,
      [JSON.stringify(embedding)],
    );

    const relevantRows = result.rows.filter(
      (row) => Number(row.distance) < 0.6,
    );

    const context = relevantRows.map((row) => row.content).join('\n\n');

    const prompt = `
        You are a customer support assistant.

        You have two sources of information:

        1. KNOWLEDGE BASE
        Use the provided context for questions about
        policies, documentation and company information.

        2. TOOLS
        Use available tools when the user asks about
        live application data such as ticket status.

        Do not invent information.

        If neither the knowledge base nor the available
        tools can answer the question, say that you
        don't have enough information.

        KNOWLEDGE BASE:

        ${context || 'No relevant documents found.'}

        USER QUESTION:

        ${question}
        `;

    const response = await this.ai.models.generateContent({
      model: 'gemini-3.8-flash',

      contents: prompt,

      config: {
        tools: [
          {
            functionDeclarations: [getTicketStatusFunction],
          },
        ],
      },
    });

    const functionCall = response.functionCalls?.[0];

    // PATH A
    if (!functionCall) {
      return {
        answer: response.text,

        sources: relevantRows.map((row) => ({
          id: row.id,
          content: row.content,
          distance: row.distance,
        })),
      };
    }

    // PATH B
    let toolResult: unknown;

    switch (functionCall.name) {
      case 'get_ticket_status': {
        const args = TicketArgsSchema.parse(functionCall.args);

        toolResult = this.ticketService.getStatus(args.ticketId);

        break;
      }

      default:
        throw new Error(`Unknown function: ${functionCall.name}`);
    }

    const modelContent = response.candidates?.[0].content;
    if (!modelContent) {
      throw new Error('Gemini returned no model content');
    }
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          {
            text: prompt,
          },
        ],
      },

      modelContent,

      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: functionCall.name,

              response: {
                result: toolResult,
              },
            },
          },
        ],
      },
    ];

    const finalResponse = await this.ai.models.generateContent({
      model: 'gemini-3.8-flash',

      contents,

      config: {
        tools: [
          {
            functionDeclarations: [getTicketStatusFunction],
          },
        ],
      },
    });

    return {
      answer: finalResponse.text,
      tool: functionCall.name,
      sources: relevantRows.map((row) => ({
        id: row.id,
        content: row.content,
        distance: row.distance,
      })),
    };
  }
}
