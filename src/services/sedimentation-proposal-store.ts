import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

const STORE_DIR = 'sedimentation-proposals';
const PROPOSAL_ID_RE = /^sp_[0-9a-f]{32}$/;
const NONCE_RE = /^[0-9a-f]{64}$/;
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{8,128}$/;
const MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]{8,256}$/;
const SENSITIVE_TEXT_RE = /(?:authorization\s*[:=]|bearer\s+\S{8,}|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{8,})/i;

export type SedimentationTargetKind = 'wiki' | 'workspace' | 'cli' | 'repository';
export type SedimentationProposalStatus = 'candidate' | 'suspended' | 'authorized' | 'rejected';

export interface SedimentationCandidateInput {
  summaries: string[];
  evidence: string[];
  target: {
    kind: SedimentationTargetKind;
    label: string;
    workingDir: string;
  };
  estimatedChange: string;
  approver: { openId: string; name?: string };
}

export interface SedimentationProposalRecord extends SedimentationCandidateInput {
  schemaVersion: 1;
  proposalId: string;
  nonce: string;
  status: SedimentationProposalStatus;
  requesterOpenId: string;
  larkAppId: string;
  sessionId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  scope: 'thread' | 'chat';
  anchor: string;
  createdAt: string;
  updatedAt: string;
  completionMessageId?: string;
  authorizationMessageId?: string;
  decision?: {
    operatorOpenId: string;
    decidedAt: string;
  };
}

export interface PrepareSedimentationProposalInput {
  candidate: unknown;
  requesterOpenId: string;
  larkAppId: string;
  sessionId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  scope: 'thread' | 'chat';
  anchor: string;
  now?: Date;
}

function safeText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${path}_invalid`);
  const text = value.trim();
  if (!text || text.length > max || text.includes('\0')) throw new Error(`${path}_invalid`);
  if (SENSITIVE_TEXT_RE.test(text)) throw new Error(`${path}_sensitive`);
  return text;
}

function safeList(value: unknown, path: string, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${path}_invalid`);
  return value.map((item, index) => safeText(item, `${path}_${index}`, 240));
}

function isTargetKind(value: unknown): value is SedimentationTargetKind {
  return value === 'wiki' || value === 'workspace' || value === 'cli' || value === 'repository';
}

export function normalizeSedimentationCandidateInput(raw: unknown): SedimentationCandidateInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('sedimentation_candidate_invalid');
  const input = raw as Record<string, unknown>;
  const target = input.target;
  const approver = input.approver;
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('sedimentation_target_invalid');
  if (!approver || typeof approver !== 'object' || Array.isArray(approver)) throw new Error('sedimentation_approver_invalid');
  const targetRecord = target as Record<string, unknown>;
  const approverRecord = approver as Record<string, unknown>;
  if (!isTargetKind(targetRecord.kind)) throw new Error('sedimentation_target_kind_invalid');
  const workingDir = safeText(targetRecord.workingDir, 'sedimentation_working_dir', 1024);
  if (!isAbsolute(workingDir)) throw new Error('sedimentation_working_dir_invalid');
  const openId = safeText(approverRecord.openId, 'sedimentation_approver_open_id', 160);
  if (!OPEN_ID_RE.test(openId)) throw new Error('sedimentation_approver_open_id_invalid');
  return {
    summaries: safeList(input.summaries, 'sedimentation_summaries', 1, 3),
    evidence: safeList(input.evidence, 'sedimentation_evidence', 1, 3),
    target: {
      kind: targetRecord.kind,
      label: safeText(targetRecord.label, 'sedimentation_target_label', 160),
      workingDir,
    },
    estimatedChange: safeText(input.estimatedChange, 'sedimentation_estimated_change', 240),
    approver: {
      openId,
      ...(approverRecord.name === undefined
        ? {}
        : { name: safeText(approverRecord.name, 'sedimentation_approver_name', 80) }),
    },
  };
}

function proposalPath(dataDir: string, proposalId: string): string {
  if (!PROPOSAL_ID_RE.test(proposalId)) throw new Error('sedimentation_proposal_id_invalid');
  return join(dataDir, STORE_DIR, `${proposalId}.json`);
}

function parseRecord(raw: unknown): SedimentationProposalRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('sedimentation_proposal_corrupt');
  const value = raw as SedimentationProposalRecord;
  if (value.schemaVersion !== 1 || !PROPOSAL_ID_RE.test(value.proposalId) || !NONCE_RE.test(value.nonce)) {
    throw new Error('sedimentation_proposal_corrupt');
  }
  if (!OPEN_ID_RE.test(value.requesterOpenId) || !value.larkAppId || !value.sessionId || !value.chatId || !value.anchor) {
    throw new Error('sedimentation_proposal_corrupt');
  }
  if ((value.chatType !== 'group' && value.chatType !== 'p2p') || (value.scope !== 'thread' && value.scope !== 'chat')) {
    throw new Error('sedimentation_proposal_corrupt');
  }
  if (value.completionMessageId && !MESSAGE_ID_RE.test(value.completionMessageId)) throw new Error('sedimentation_proposal_corrupt');
  if (value.authorizationMessageId && !MESSAGE_ID_RE.test(value.authorizationMessageId)) throw new Error('sedimentation_proposal_corrupt');
  if (value.status !== 'candidate' && value.status !== 'suspended' && value.status !== 'authorized' && value.status !== 'rejected') {
    throw new Error('sedimentation_proposal_corrupt');
  }
  normalizeSedimentationCandidateInput(value);
  return value;
}

function writeRecord(path: string, record: SedimentationProposalRecord): void {
  atomicWriteFileSync(path, JSON.stringify(record), {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

export class SedimentationProposalStore {
  constructor(private readonly dataDir: string) {
    mkdirSync(join(dataDir, STORE_DIR), { recursive: true, mode: 0o700 });
  }

  prepare(input: PrepareSedimentationProposalInput): SedimentationProposalRecord {
    const candidate = normalizeSedimentationCandidateInput(input.candidate);
    if (!OPEN_ID_RE.test(input.requesterOpenId)) throw new Error('sedimentation_requester_invalid');
    const now = (input.now ?? new Date()).toISOString();
    const record: SedimentationProposalRecord = {
      schemaVersion: 1,
      proposalId: `sp_${randomBytes(16).toString('hex')}`,
      nonce: randomBytes(32).toString('hex'),
      status: 'candidate',
      requesterOpenId: input.requesterOpenId,
      larkAppId: safeText(input.larkAppId, 'sedimentation_lark_app_id', 256),
      sessionId: safeText(input.sessionId, 'sedimentation_session_id', 256),
      chatId: safeText(input.chatId, 'sedimentation_chat_id', 256),
      chatType: input.chatType,
      scope: input.scope,
      anchor: safeText(input.anchor, 'sedimentation_anchor', 256),
      createdAt: now,
      updatedAt: now,
      ...candidate,
    };
    const path = proposalPath(this.dataDir, record.proposalId);
    if (existsSync(path)) throw new Error('sedimentation_proposal_conflict');
    writeRecord(path, record);
    return structuredClone(record);
  }

  load(proposalId: string): SedimentationProposalRecord | undefined {
    const path = proposalPath(this.dataDir, proposalId);
    if (!existsSync(path)) return undefined;
    return parseRecord(JSON.parse(readFileSync(path, 'utf8')));
  }

  bindCompletionMessage(proposalId: string, nonce: string, messageId: string): SedimentationProposalRecord {
    if (!MESSAGE_ID_RE.test(messageId)) throw new Error('sedimentation_message_id_invalid');
    return this.mutate(proposalId, nonce, record => {
      if (record.completionMessageId && record.completionMessageId !== messageId) throw new Error('sedimentation_message_conflict');
      return { ...record, completionMessageId: messageId, updatedAt: new Date().toISOString() };
    });
  }

  bindAuthorizationMessage(proposalId: string, nonce: string, messageId: string): SedimentationProposalRecord {
    if (!MESSAGE_ID_RE.test(messageId)) throw new Error('sedimentation_message_id_invalid');
    return this.mutate(proposalId, nonce, record => {
      if (record.status !== 'candidate') return record;
      if (record.authorizationMessageId && record.authorizationMessageId !== messageId) throw new Error('sedimentation_message_conflict');
      return { ...record, authorizationMessageId: messageId, updatedAt: new Date().toISOString() };
    });
  }

  applyFeedbackGate(
    larkAppId: string,
    completionMessageId: string,
    semantic: 'positive' | 'progress' | 'negative',
  ): SedimentationProposalRecord | undefined {
    if (!MESSAGE_ID_RE.test(completionMessageId)) return undefined;
    const dir = join(this.dataDir, STORE_DIR);
    const candidate = readdirSync(dir)
      .filter(name => /^sp_[0-9a-f]{32}\.json$/.test(name))
      .map(name => this.load(name.slice(0, -5)))
      .find(record => record?.larkAppId === larkAppId && record.completionMessageId === completionMessageId);
    if (!candidate || (candidate.status !== 'candidate' && candidate.status !== 'suspended')) return candidate;
    return this.mutate(candidate.proposalId, candidate.nonce, record => ({
      ...record,
      status: semantic === 'positive' ? 'candidate' : 'suspended',
      updatedAt: new Date().toISOString(),
    }));
  }

  decide(input: {
    proposalId: string;
    nonce: string;
    authorizationMessageId: string;
    operatorOpenId: string;
    decision: 'authorize' | 'reject';
    now?: Date;
  }): { record: SedimentationProposalRecord; changed: boolean } {
    let changed = false;
    const record = this.mutate(input.proposalId, input.nonce, current => {
      const record = current;
      if (record.authorizationMessageId !== input.authorizationMessageId) throw new Error('sedimentation_message_mismatch');
      if (record.requesterOpenId !== input.operatorOpenId) throw new Error('sedimentation_operator_denied');
      if (record.status !== 'candidate') return record;
      const now = (input.now ?? new Date()).toISOString();
      changed = true;
      return {
        ...record,
        status: input.decision === 'authorize' ? 'authorized' : 'rejected',
        decision: { operatorOpenId: input.operatorOpenId, decidedAt: now },
        updatedAt: now,
      };
    });
    return { record, changed };
  }

  private mutate(
    proposalId: string,
    nonce: string,
    fn: (record: SedimentationProposalRecord) => SedimentationProposalRecord,
  ): SedimentationProposalRecord {
    if (!NONCE_RE.test(nonce)) throw new Error('sedimentation_nonce_invalid');
    const path = proposalPath(this.dataDir, proposalId);
    return withFileLockSync(path, () => {
      if (!existsSync(path)) throw new Error('sedimentation_proposal_missing');
      const current = parseRecord(JSON.parse(readFileSync(path, 'utf8')));
      if (current.nonce !== nonce) throw new Error('sedimentation_nonce_invalid');
      const next = fn(current);
      parseRecord(next);
      if (JSON.stringify(next) !== JSON.stringify(current)) writeRecord(path, next);
      return structuredClone(next);
    });
  }
}
