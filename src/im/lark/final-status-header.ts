import type { ReplyCardHeader } from './reply-card-style.js';

export type FinalAnswerStatus = 'completed' | 'failed' | 'interrupted';

const STATUS_HEADER: Record<FinalAnswerStatus, {
  template: 'green' | 'red' | 'grey';
  title: string;
}> = {
  completed: { template: 'green', title: '✅ 任务已完成' },
  failed: { template: 'red', title: '❌ 任务执行失败' },
  interrupted: { template: 'grey', title: '⏹️ 任务已中止' },
};

export function parseFinalAnswerStatus(value: unknown): FinalAnswerStatus | undefined {
  return value === 'completed' || value === 'failed' || value === 'interrupted'
    ? value
    : undefined;
}

export function buildFinalStatusHeader(status: FinalAnswerStatus): ReplyCardHeader {
  const spec = STATUS_HEADER[status];
  return {
    template: spec.template,
    title: { tag: 'plain_text', content: spec.title },
  };
}
