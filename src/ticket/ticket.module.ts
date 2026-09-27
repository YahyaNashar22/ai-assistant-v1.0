import { Module } from "@nestjs/common";
import { TicketService } from "./ticket.service.js";

@Module({
    providers: [TicketService],
    exports: [TicketService]
})
export class TicketModule {}