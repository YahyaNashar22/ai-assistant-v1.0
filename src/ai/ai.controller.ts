import { Body, Controller, Get, Post } from '@nestjs/common';
import { AiService } from './ai.service.js';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
  ) {}
  @Get('test')
  test() {
    return this.aiService.testGemini();
  }

  @Post('documents')
  addDocument(@Body('content') content: string) {
    return this.aiService.addDocument(content);
  }

  @Post('search')
  search(@Body('question') question: string) {
    return this.aiService.search(question);
  }

  @Post('ask')
  ask(@Body('question') question: string) {
    return this.aiService.ask(question);
  }

  @Post('ticket-assistant')
  ticketAssistant(@Body('question') question: string) {
    return this.aiService.ticketAssistant(question)
  }
}
