import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module.js';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true
    }),
    AiModule,
  ]
})
export class AppModule {}
