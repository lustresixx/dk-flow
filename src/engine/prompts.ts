/**
 * Step prompt assembly for adversarial review states, plus the context budget
 * rules ported from ACEHarness: step conclusions ≤ 2000 chars, evidence
 * summaries ≤ 8000 chars, per-state evidence ≤ 32000 chars.
 * @module dsh-ace-harness/engine
 */
import type { StateOutcome, StepContext, StepOutcome } from './types.js'

/** Maximum chars kept of one step's conclusion (verdict rationale). */
export const CONCLUSION_BUDGET = 2000
/** Maximum chars kept of one step's evidence summary. */
export const SUMMARY_BUDGET = 8000
/** Maximum chars of all prior-state evidence handed to one step. */
export const STATE_EVIDENCE_BUDGET = 32000

/** Truncate to a budget on a character boundary with an ellipsis marker. */
export function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text
  return `${text.slice(0, budget)}…（已截断，原文共 ${text.length} 字符）`
}

/** Render one step outcome as bounded evidence for later steps. */
export function summarizeStepEvidence(outcome: StepOutcome): string {
  const header = `[步骤 ${outcome.step}${outcome.role ? ` · ${outcome.role}` : ''}${outcome.agent ? ` · ${outcome.agent}` : ''}]`
  const verdict = outcome.verdict
    ? `\n结论: ${outcome.verdict.verdict} — ${truncate(outcome.verdict.rationale, CONCLUSION_BUDGET)}`
    : outcome.subworkflowOutcome
      ? `\n子工作流结果: ${outcome.subworkflowOutcome}`
      : ''
  return truncate(`${header}${verdict}\n产出摘要:\n${outcome.outputSummary}`, SUMMARY_BUDGET)
}

/** Render completed states as evidence, newest last, under the state budget. */
export function buildStateEvidence(stateOutcomes: readonly StateOutcome[]): string {
  const parts: string[] = []
  let total = 0
  for (const outcome of [...stateOutcomes].reverse()) {
    const text = `【状态 ${outcome.state} 结论】${outcome.verdict.verdict} — ${truncate(outcome.verdict.rationale, CONCLUSION_BUDGET)}`
    total += text.length + 2
    if (total > STATE_EVIDENCE_BUDGET) break
    parts.unshift(text)
  }
  return parts.join('\n\n')
}

/** Evidence from previous steps of the current state. */
export function buildStepEvidence(steps: readonly StepOutcome[]): string {
  if (steps.length === 0) return '（无本状态前置步骤产出）'
  return steps.map(summarizeStepEvidence).join('\n\n---\n\n')
}

const ROLE_INTRO: Record<'attacker' | 'defender' | 'judge' | 'neutral', string> = {
  defender: '你是本步骤的执行者（defender）。请完成分配的任务，产出可验证的交付物与证据。',
  attacker:
    '你是本步骤的挑战者（attacker）。请只基于提供的证据寻找反例、边界与风险，不要重复执行交付工作；每条质疑都要给出可验证的场景或依据。',
  judge:
    '你是本步骤的裁决者（judge）。请综合执行者的产出与挑战者的意见，基于证据给出裁决，不要重做交付工作。',
  neutral: '请完成分配的任务，产出可验证的交付物与证据。',
}

const JUDGE_OUTPUT_INSTRUCTION = [
  '最终必须单独输出一行裁决标签，格式严格为：',
  '<workflow-verdict>{"verdict":"success|fail","issues":[{"type":"design|implementation|test|performance|security","severity":"critical|major|minor","description":"..."}],"rationale":"..."}</workflow-verdict>',
  '其中 verdict 取值：success（成功，放行到下一状态）、fail（失败，走失败转移）。由你依据证据判断，不要机械照搬检查清单。',
]

const STEP_OUTPUT_INSTRUCTION = [
  '完成后请在最后单独输出一行结论标签：',
  '<step-conclusion>{"verdict":"success|fail","issues":[],"rationale":"结论摘要"}</step-conclusion>',
  'success 表示本步骤达成目标，fail 表示未达成。由你依据实际产出判断。',
]

/**
 * Build the user prompt delivered to one step's subagent.
 */
export function buildStepPrompt(input: {
  role: 'attacker' | 'defender' | 'judge' | 'neutral'
  task: string
  constraints: string[]
  ctx: StepContext
  evidence?: string
}): string {
  const sections = [
    `## 当前状态：${input.ctx.state}`,
    input.ctx.stateDescription ? `状态说明：${input.ctx.stateDescription}` : '',
    input.ctx.requirements ? `## 本次需求\n${input.ctx.requirements}` : '',
    input.ctx.projectRoot ? `工作目录：${input.ctx.projectRoot}` : '',
    input.ctx.priorStateEvidence ? `## 已完成状态的证据\n${input.ctx.priorStateEvidence}` : '',
    input.ctx.priorStepEvidence !== '（无本状态前置步骤产出）'
      ? `## 本状态前置步骤证据\n${input.ctx.priorStepEvidence}`
      : '',
    input.evidence ? `## 待评审证据（只读）\n${input.evidence}` : '',
    `## 本步骤任务\n${input.task}`,
    input.constraints.length > 0 ? `## 约束\n${input.constraints.map((item) => `- ${item}`).join('\n')}` : '',
    ROLE_INTRO[input.role],
    ...(input.role === 'judge' ? JUDGE_OUTPUT_INSTRUCTION : STEP_OUTPUT_INSTRUCTION),
  ]
  return sections.filter((section) => section !== '').join('\n\n')
}

/** Build the supervisor checkpoint prompt between states. */
export function buildSupervisorPrompt(input: {
  state: string
  requirements: string
  stateOutcome: StepOutcome[]
  experience?: string
  scoringEnabled?: boolean
}): string {
  const evidence = input.stateOutcome.map(summarizeStepEvidence).join('\n\n---\n\n')
  const scoring = input.scoringEnabled
    ? '\n输出要求：单独输出一行评分标签 `<supervisor-score>{"score": 1到10的整数, "advice": "检查点结论"}</supervisor-score>`，score 依据目标达成度、证据充分性和风险收敛程度。'
    : ''
  return [
    `## 阶段检查：${input.state}`,
    input.requirements ? `本次需求：${input.requirements}` : '',
    input.experience ? `## 历史经验（最近同类工作流的检查点结论，仅供参考）\n${input.experience}` : '',
    `该阶段已完成的步骤产出如下：\n${evidence}`,
    '请给出：当前阶段状态、已满足条件、待满足条件、建议的下一步，以及是否需要人工介入（需要时说明决策问题与可选项）。',
    scoring,
  ]
    .filter((section) => section !== '')
    .join('\n\n')
}
