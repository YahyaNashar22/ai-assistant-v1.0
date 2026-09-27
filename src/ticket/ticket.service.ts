import { Injectable } from "@nestjs/common";

@Injectable()
export class TicketService {
    getStatus(ticketId: number) {
        const tickets: Record<number, string> = {
            123: 'in_progress',
            456: 'resolved',
            789: 'waiting_for_customer'
        };

        return {
            ticketId,
            status: tickets[ticketId] ?? 'not_found'
        }
    }
}