import type {
  SedimentationProposalRecord,
  SedimentationProposalStore,
} from '../../services/sedimentation-proposal-store.js';

export const SEDIMENTATION_VIEW_ACTION = 'sedimentation_view';
export const SEDIMENTATION_AUTHORIZE_ACTION = 'sedimentation_authorize';
export const SEDIMENTATION_REJECT_ACTION = 'sedimentation_reject';

const PROPOSAL_ID_RE = /^sp_[0-9a-f]{32}$/;
const NONCE_RE = /^[0-9a-f]{64}$/;

export interface SedimentationCardActionData {
  context?: { open_message_id?: string };
  operator?: { open_id?: string };
  action?: { value?: Record<string, unknown> };
}

export interface SedimentationCardHandlerDeps {
  store: SedimentationProposalStore;
  sendAuthorizationCard: (
    record: SedimentationProposalRecord,
    cardJson: string,
    uuid: string,
  ) => Promise<string>;
  startAuthorizedTurn: (record: SedimentationProposalRecord, operatorOpenId: string) => void;
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+.!|>~-])/g, '\\$1');
}

function actionValue(action: string, record: SedimentationProposalRecord): Record<string, string> {
  return { action, proposal_id: record.proposalId, nonce: record.nonce };
}

function actionButton(label: string, style: string, action: string, record: SedimentationProposalRecord): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: style,
    behaviors: [{ type: 'callback', value: actionValue(action, record) }],
  };
}

export function buildSedimentationCandidateElement(record: SedimentationProposalRecord): Record<string, unknown> {
  return {
    tag: 'column_set',
    element_id: 'botmux_sedimentation_candidate',
    flex_mode: 'none',
    background_style: 'grey-50',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '10px',
        elements: [{
          tag: 'markdown',
          content: `<text_tag color='blue'>可沉淀候选</text_tag> **发现 ${record.summaries.length} 条可复用结论**\n<font color='grey'>${escapeMd(record.estimatedChange)}</font>`,
        }],
      },
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [actionButton('查看沉淀建议', 'default', SEDIMENTATION_VIEW_ACTION, record)],
      },
    ],
  };
}

export function buildSedimentationAuthorizationCard(record: SedimentationProposalRecord): string {
  const summary = record.summaries.map(item => `- ${escapeMd(item)}`).join('\n');
  const evidence = record.evidence.map(item => `- ${escapeMd(item)}`).join('\n');
  return JSON.stringify({
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      enable_forward: false,
      summary: { content: '沉淀建议待确认' },
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '💡 沉淀建议待确认' },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        { tag: 'markdown', content: `**拟沉淀内容**\n${summary}` },
        { tag: 'markdown', content: `**证据**\n${evidence}` },
        {
          tag: 'markdown',
          content: [
            `**写入目标**  ${escapeMd(record.target.label)}`,
            `**预计变更**  ${escapeMd(record.estimatedChange)}`,
            `**审批人**  ${escapeMd(record.approver.name ?? '已解析的目标 owner')}（MR 创建后再 @）`,
          ].join('\n'),
        },
        {
          tag: 'markdown',
          content: "<font color='grey'>创建 MR 需要独立任务；本次点击只授权创建 MR，不授权合并。</font>",
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [
            { tag: 'column', width: 'auto', elements: [actionButton('创建沉淀 MR', 'primary', SEDIMENTATION_AUTHORIZE_ACTION, record)] },
            { tag: 'column', width: 'auto', elements: [actionButton('本次不沉淀', 'default', SEDIMENTATION_REJECT_ACTION, record)] },
          ],
        },
      ],
    },
  });
}

export function buildSedimentationDecisionCard(record: SedimentationProposalRecord): Record<string, unknown> {
  const authorized = record.status === 'authorized';
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill', enable_forward: false },
    header: {
      template: authorized ? 'green' : 'grey',
      title: {
        tag: 'plain_text',
        content: authorized ? '✅ 已授权创建沉淀 MR' : '已跳过本次沉淀',
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [{
        tag: 'markdown',
        content: authorized
          ? `已启动独立沉淀任务。MR 创建后将 @ ${escapeMd(record.approver.name ?? '目标 owner')} 审批；未授权自动合并。`
          : '未创建分支、commit 或 MR；原任务仍保持已完成。',
      }],
    },
  };
}

export function isSedimentationCardAction(action: unknown): boolean {
  return action === SEDIMENTATION_VIEW_ACTION
    || action === SEDIMENTATION_AUTHORIZE_ACTION
    || action === SEDIMENTATION_REJECT_ACTION;
}

function parseAction(value: unknown): { action: string; proposalId: string; nonce: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isSedimentationCardAction(record.action)) return undefined;
  if (typeof record.proposal_id !== 'string' || !PROPOSAL_ID_RE.test(record.proposal_id)) return undefined;
  if (typeof record.nonce !== 'string' || !NONCE_RE.test(record.nonce)) return undefined;
  return { action: record.action as string, proposalId: record.proposal_id, nonce: record.nonce };
}

function stale(): Record<string, unknown> {
  return { toast: { type: 'warning', content: '沉淀建议已失效，请重新生成。' } };
}

export async function handleSedimentationCardAction(
  data: SedimentationCardActionData,
  larkAppId: string,
  deps: SedimentationCardHandlerDeps,
): Promise<Record<string, unknown>> {
  const parsed = parseAction(data.action?.value);
  const operatorOpenId = data.operator?.open_id;
  const cardMessageId = data.context?.open_message_id;
  if (!parsed || !operatorOpenId || !cardMessageId) return stale();
  const record = deps.store.load(parsed.proposalId);
  if (!record || record.nonce !== parsed.nonce || record.larkAppId !== larkAppId) return stale();
  if (record.requesterOpenId !== operatorOpenId) {
    return { toast: { type: 'error', content: '仅本次任务请求者可决定是否沉淀。' } };
  }

  if (parsed.action === SEDIMENTATION_VIEW_ACTION) {
    if (record.completionMessageId !== cardMessageId) return stale();
    if (record.status === 'suspended') {
      return { toast: { type: 'info', content: '当前任务仍需完善；沉淀建议已保留，下次完成后会重新校验。' } };
    }
    if (record.status !== 'candidate') return stale();
    if (record.authorizationMessageId) {
      return { toast: { type: 'info', content: '沉淀授权卡已发送。' } };
    }
    const messageId = await deps.sendAuthorizationCard(
      record,
      buildSedimentationAuthorizationCard(record),
      `sedimentation-${record.proposalId}`,
    );
    deps.store.bindAuthorizationMessage(record.proposalId, record.nonce, messageId);
    return { toast: { type: 'success', content: '已展开沉淀建议。' } };
  }

  if (record.authorizationMessageId !== cardMessageId) return stale();
  if (record.status === 'suspended') {
    return { toast: { type: 'info', content: '当前任务仍需完善，暂不创建沉淀 MR。' } };
  }
  const decision = deps.store.decide({
    proposalId: record.proposalId,
    nonce: record.nonce,
    authorizationMessageId: cardMessageId,
    operatorOpenId,
    decision: parsed.action === SEDIMENTATION_AUTHORIZE_ACTION ? 'authorize' : 'reject',
  });
  if (decision.changed && decision.record.status === 'authorized') {
    deps.startAuthorizedTurn(decision.record, operatorOpenId);
  }
  return { card: { type: 'raw', data: buildSedimentationDecisionCard(decision.record) } };
}
