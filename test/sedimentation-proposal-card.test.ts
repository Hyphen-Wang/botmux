import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSedimentationAuthorizationCard,
  buildSedimentationCandidateElement,
  handleSedimentationCardAction,
} from '../src/im/lark/sedimentation-proposal-card.js';
import {
  SedimentationProposalStore,
  normalizeSedimentationCandidateInput,
} from '../src/services/sedimentation-proposal-store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-sedimentation-'));
  dirs.push(dataDir);
  const store = new SedimentationProposalStore(dataDir);
  const record = store.prepare({
    candidate: {
      summaries: ['任务卡完成后展示低干扰的沉淀候选入口'],
      evidence: ['botmux@2722174f 与 380 项定向测试'],
      target: { kind: 'repository', label: 'Botmux 仓库', workingDir: '/tmp/botmux' },
      estimatedChange: '预计 1 个 MR，修改 3–5 个文件',
      approver: { openId: 'ou_approver12345', name: '审批人' },
    },
    requesterOpenId: 'ou_requester12345',
    larkAppId: 'cli_app',
    sessionId: 'session-1',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    anchor: 'om_threadroot1',
    now: new Date('2026-09-01T00:00:00.000Z'),
  });
  store.bindCompletionMessage(record.proposalId, record.nonce, 'om_completion1');
  return { store, record: store.load(record.proposalId)! };
}

function action(messageId: string, actionName: string, record: ReturnType<typeof setup>['record'], operator = 'ou_requester12345') {
  return {
    context: { open_message_id: messageId },
    operator: { open_id: operator },
    action: { value: { action: actionName, proposal_id: record.proposalId, nonce: record.nonce } },
  };
}

describe('sedimentation proposal interaction', () => {
  it('validates a compact candidate and rejects unresolved approvers', () => {
    expect(normalizeSedimentationCandidateInput({
      summaries: ['one'], evidence: ['evidence'],
      target: { kind: 'repository', label: 'repo', workingDir: '/tmp/repo' },
      estimatedChange: 'one MR',
      approver: { openId: 'ou_approver12345' },
    })).toMatchObject({ summaries: ['one'], target: { kind: 'repository' } });
    expect(() => normalizeSedimentationCandidateInput({
      summaries: ['one'], evidence: ['evidence'],
      target: { kind: 'repository', label: 'repo', workingDir: '/tmp/repo' },
      estimatedChange: 'one MR',
      approver: { openId: 'unknown' },
    })).toThrow(/approver/);
    expect(() => normalizeSedimentationCandidateInput({
      summaries: ['token=super-secret-value'], evidence: ['evidence'],
      target: { kind: 'repository', label: 'repo', workingDir: '/tmp/repo' },
      estimatedChange: 'one MR',
      approver: { openId: 'ou_approver12345' },
    })).toThrow(/sensitive/);
  });

  it('keeps the completion status and exposes a low-noise candidate entry', () => {
    const { record } = setup();
    const candidate = JSON.stringify(buildSedimentationCandidateElement(record));
    expect(candidate).toContain('可沉淀候选');
    expect(candidate).toContain('查看沉淀建议');
    expect(candidate).toContain(record.proposalId);
    expect(candidate).not.toContain(record.target.workingDir);
  });

  it('renders summary, evidence, MR cost and approver without private paths', () => {
    const { record } = setup();
    const card = buildSedimentationAuthorizationCard(record);
    expect(card).toContain('创建沉淀 MR');
    expect(card).toContain('本次不沉淀');
    expect(card).toContain(record.approver.name!);
    expect(card).not.toContain(record.approver.openId);
    expect(card).toContain(record.estimatedChange);
    expect(card).not.toContain(record.target.workingDir);
  });

  it('sends one authorization card and rejects a different operator', async () => {
    const { store, record } = setup();
    const sent: string[] = [];
    const deps = {
      store,
      sendAuthorizationCard: async (_record: unknown, card: string) => { sent.push(card); return 'om_authorization1'; },
      startAuthorizedTurn: () => { throw new Error('must not start'); },
    };
    const denied = await handleSedimentationCardAction(action('om_completion1', 'sedimentation_view', record, 'ou_intruder12345'), 'cli_app', deps);
    expect(denied.toast).toMatchObject({ type: 'error' });
    expect(sent).toHaveLength(0);

    const first = await handleSedimentationCardAction(action('om_completion1', 'sedimentation_view', record), 'cli_app', deps);
    expect(first.toast).toMatchObject({ type: 'success' });
    expect(sent).toHaveLength(1);
    const duplicate = await handleSedimentationCardAction(action('om_completion1', 'sedimentation_view', record), 'cli_app', deps);
    expect(duplicate.toast).toMatchObject({ type: 'info' });
    expect(sent).toHaveLength(1);
  });

  it('keeps the candidate discoverable but suspends authorization after non-positive feedback', async () => {
    const { store, record } = setup();
    const sent: string[] = [];
    const deps = {
      store,
      sendAuthorizationCard: async (_record: unknown, card: string) => { sent.push(card); return 'om_authorization1'; },
      startAuthorizedTurn: () => { throw new Error('must not start'); },
    };
    expect(store.applyFeedbackGate('cli_app', 'om_completion1', 'progress')?.status).toBe('suspended');
    const suspended = await handleSedimentationCardAction(action('om_completion1', 'sedimentation_view', record), 'cli_app', deps);
    expect(suspended.toast).toMatchObject({ type: 'info' });
    expect(JSON.stringify(suspended)).toContain('仍需完善');
    expect(sent).toHaveLength(0);

    expect(store.applyFeedbackGate('cli_app', 'om_completion1', 'positive')?.status).toBe('candidate');
    const resumed = await handleSedimentationCardAction(action('om_completion1', 'sedimentation_view', record), 'cli_app', deps);
    expect(resumed.toast).toMatchObject({ type: 'success' });
    expect(sent).toHaveLength(1);
  });

  it('keeps an already-open authorization card inert while feedback is non-positive', async () => {
    const { store, record } = setup();
    store.bindAuthorizationMessage(record.proposalId, record.nonce, 'om_authorization1');
    store.applyFeedbackGate('cli_app', 'om_completion1', 'negative');
    const started: string[] = [];
    const result = await handleSedimentationCardAction(
      action('om_authorization1', 'sedimentation_authorize', record),
      'cli_app',
      {
        store,
        sendAuthorizationCard: async () => 'om_authorization1',
        startAuthorizedTurn: () => started.push('started'),
      },
    );
    expect(result.toast).toMatchObject({ type: 'info' });
    expect(started).toHaveLength(0);
    expect(store.load(record.proposalId)?.status).toBe('suspended');
  });

  it('authorizes exactly one new sedimentation turn and never grants merge', async () => {
    const { store, record } = setup();
    store.bindAuthorizationMessage(record.proposalId, record.nonce, 'om_authorization1');
    const started: string[] = [];
    const deps = {
      store,
      sendAuthorizationCard: async () => 'om_authorization1',
      startAuthorizedTurn: (approved: typeof record) => started.push(approved.proposalId),
    };
    const first = await handleSedimentationCardAction(action('om_authorization1', 'sedimentation_authorize', record), 'cli_app', deps);
    expect(JSON.stringify(first)).toContain('已授权创建沉淀 MR');
    expect(JSON.stringify(first)).toContain('未授权自动合并');
    expect(started).toEqual([record.proposalId]);

    await handleSedimentationCardAction(action('om_authorization1', 'sedimentation_authorize', record), 'cli_app', deps);
    expect(started).toEqual([record.proposalId]);
    expect(store.load(record.proposalId)?.status).toBe('authorized');
  });

  it('rejects without starting work or changing the completed task', async () => {
    const { store, record } = setup();
    store.bindAuthorizationMessage(record.proposalId, record.nonce, 'om_authorization1');
    const started: string[] = [];
    const result = await handleSedimentationCardAction(
      action('om_authorization1', 'sedimentation_reject', record),
      'cli_app',
      {
        store,
        sendAuthorizationCard: async () => 'om_authorization1',
        startAuthorizedTurn: () => started.push('started'),
      },
    );
    expect(JSON.stringify(result)).toContain('已跳过本次沉淀');
    expect(started).toHaveLength(0);
    expect(store.load(record.proposalId)?.status).toBe('rejected');
  });
});
