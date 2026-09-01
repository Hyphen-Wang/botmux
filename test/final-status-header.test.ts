import { describe, expect, it } from 'vitest';

import {
  buildFinalStatusHeader,
  parseFinalAnswerStatus,
} from '../src/im/lark/final-status-header.js';

describe('final answer status header', () => {
  it('maps fixed terminal states to semantic CardKit headers', () => {
    expect(buildFinalStatusHeader('completed')).toEqual({
      template: 'green',
      title: { tag: 'plain_text', content: '✅ 任务已完成' },
    });
    expect(buildFinalStatusHeader('failed')).toMatchObject({ template: 'red' });
    expect(buildFinalStatusHeader('interrupted')).toMatchObject({ template: 'grey' });
  });

  it('rejects arbitrary header values instead of reflecting them into cards', () => {
    expect(parseFinalAnswerStatus('completed')).toBe('completed');
    expect(parseFinalAnswerStatus('green')).toBeUndefined();
    expect(parseFinalAnswerStatus('<script>')).toBeUndefined();
  });
});
