import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { INestApplication } from '@nestjs/common';

export function setupBullBoard(app: INestApplication, queues: Queue[]): void {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/bull-board');

  const bullBoardQueues = queues.map((queue) => new BullMQAdapter(queue));

  createBullBoard({
    queues: bullBoardQueues,
    serverAdapter,
  });

  app.use('/admin/bull-board', serverAdapter.getRouter());
}
