import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { TicketModule } from '../ticket/ticket.module.js';

@Module({
  imports: [TicketModule],
  controllers: [AiController],
  providers: [AiService]
})
export class AiModule {}
