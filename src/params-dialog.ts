/**
 * Missing-parameter interaction: when a workflow template's required
 * parameters were not supplied, ask the user through the DSH user-questions
 * dialog before the run continues.
 * @module dsh-ace-harness/params-dialog
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { WorkflowTemplateManifest } from './dsl/types.js'

/** Build one dialog question per missing parameter. */
export function buildParameterQuestions(
  manifest: WorkflowTemplateManifest,
  missingIds: readonly string[],
): AskUserQuestionItem[] {
  const byId = new Map((manifest.spec.parameters ?? []).map((parameter) => [parameter.id, parameter]))
  return missingIds.map((id) => {
    const parameter = byId.get(id)!
    return {
      id,
      header: '工作流参数',
      question: `请填写「${parameter.label}」${parameter.description ? `（${parameter.description}）` : ''}`,
      // Enum choices become selectable options; the value rides in the
      // description and is mapped back from the selected label.
      options:
        parameter.type === 'enum' && parameter.options
          ? parameter.options.map((option) => ({ label: option.label, description: option.value }))
          : undefined,
    }
  })
}

/** Map dialog answers (labels + custom text) back to parameter values. */
export function answersToValues(
  manifest: WorkflowTemplateManifest,
  questions: readonly AskUserQuestionItem[],
  answers: readonly { id: string; selected: string[]; custom?: string }[],
): Record<string, string> {
  const byId = new Map((manifest.spec.parameters ?? []).map((parameter) => [parameter.id, parameter]))
  const values: Record<string, string> = {}
  for (const question of questions) {
    const answer = answers.find((item) => item.id === question.id)
    if (!answer) continue
    const selected = answer.selected[0]
    const parameter = byId.get(question.id)
    if (parameter?.type === 'enum' && parameter.options && selected) {
      const option = parameter.options.find((candidate) => candidate.label === selected)
      if (option) {
        values[question.id] = option.value
        continue
      }
    }
    const custom = answer.custom ?? ''
    if (custom !== '') {
      values[question.id] = custom
    } else if (selected) {
      values[question.id] = selected
    }
  }
  return values
}

/**
 * Ask the user for missing required parameters and return the filled values.
 * Falls back to `null` when no interactive UI is available (headless), so
 * callers can keep their plain error text.
 */
export async function askMissingParameters(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  manifest: WorkflowTemplateManifest,
  missingIds: readonly string[],
): Promise<Record<string, string> | null> {
  const questions = buildParameterQuestions(manifest, missingIds)
  try {
    const answer = await ctx.userQuestions.ask({ questions, agent, signal })
    return answersToValues(manifest, questions, answer.answers)
  } catch {
    return null
  }
}
