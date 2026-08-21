import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createRunState, runStateMachine } from '../src/engine/runner.js'
import type { EngineRunOptions, RunState, StepExecutor, StepOutcome } from '../src/engine/types.js'
import type { StepVerdict, WorkflowConfig } from '../src/dsl/types.js'

const SID = 'session-1' as unknown as SessionId
const fakeParent = {
  id: SID,
  session: { header: { cwd: '/ws' } },
} as unknown as Agent

const V = (verdict: StepVerdict['verdict'], rationale = ''): StepVerdict => ({
  verdict,
  issues: [],
  rationale,
})

/** A scripted executor: keyed by `<state>/<step>`, fallback output is a pass verdict. */
function scriptedExecutor(
  script: Record<string, StepVerdict | string>,
  calls: string[],
): StepExecutor {
  return {
    async runAgentStep(input) {
      const key = `${input.ctx.state}/${input.stepName}`
      calls.push(key)
      const entry = script[key]
      if (entry === undefined) {
        return { outputSummary: `ok ${key}`, verdict: V('pass') }
      }
      if (typeof entry === 'string') return { outputSummary: entry }
      return { outputSummary: entry.rationale, verdict: entry }
    },
    async runLlmStep(input) {
      const key = `${input.ctx.state}/${input.stepName}`
      calls.push(`llm:${key}`)
      const entry = script[key]
      if (entry === undefined) {
        return { outputSummary: `ok llm ${key}`, verdict: V('pass') }
      }
      if (typeof entry === 'string') return { outputSummary: entry }
      return { outputSummary: entry.rationale, verdict: entry }
    },
    async runSubworkflowStep(input) {
      calls.push(`sub:${input.stepName}`)
      return { outcome: 'completed', verdict: V('pass') }
    },
  }
}

interface Harness {
  result: Awaited<ReturnType<typeof runStateMachine>>
  calls: string[]
  persisted: RunState[]
}

function redBlueConfig(overrides: Partial<WorkflowConfig['workflow']> = {}): WorkflowConfig {
  return {
    workflow: {
      name: '红蓝评审',
      mode: 'state-machine',
      maxTransitions: 50,
      supervisor: {
        enabled: true,
        agent: 'default-supervisor',
        stageReviewEnabled: true,
        checkpointAdviceEnabled: true,
        scoringEnabled: true,
        experienceEnabled: true,
      },
      states: [
        {
          name: '方案',
          steps: [
            { name: '方案设计', agent: 'architect', role: 'defender', task: '设计' },
            { name: '方案挑战', agent: 'solution-breaker', role: 'attacker', task: '挑战' },
            { name: '方案裁决', agent: 'design-judge', role: 'judge', task: '裁决' },
          ],
          transitions: [
            { to: '执行', condition: { verdict: 'pass' }, priority: 10 },
            { to: '方案', condition: { verdict: 'conditional_pass' }, priority: 20 },
          ],
          isInitial: true,
          isFinal: false,
        },
        {
          name: '执行',
          steps: [{ name: '任务执行', agent: 'developer', role: 'defender', task: '执行' }],
          transitions: [
            { to: '验收', condition: { verdict: 'pass' }, priority: 10 },
            { to: '方案', condition: { verdict: 'fail' }, priority: 30 },
          ],
          isInitial: false,
          isFinal: false,
        },
        {
          name: '验收',
          steps: [{ name: '验收验证', agent: 'tester', role: 'defender', task: '验证' }],
          transitions: [{ to: '完成', condition: { verdict: 'pass' }, priority: 10 }],
          isInitial: false,
          isFinal: false,
        },
        {
          name: '完成',
          steps: [{ name: '交付汇总', agent: 'documentation-writer', role: 'defender', task: '汇总' }],
          transitions: [],
          isInitial: false,
          isFinal: true,
        },
      ],
      ...overrides,
    },
  }
}

async function run(config: WorkflowConfig, script: Record<string, StepVerdict | string>, persisted?: RunState): Promise<Harness> {
  const calls: string[] = []
  const persistedStates: RunState[] = []
  const executor = scriptedExecutor(script, calls)
  const options: EngineRunOptions = {
    config,
    runId: 'run-1',
    configFile: 'red-blue.yaml',
    inputs: {},
    parent: fakeParent,
    signal: new AbortController().signal,
    executor,
    persist: async (state) => {
      persistedStates.push(JSON.parse(JSON.stringify(state)) as RunState)
    },
    load: async () => (persisted ? (JSON.parse(JSON.stringify(persisted)) as RunState) : null),
    resolveSubworkflow: async () => config,
    askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
  }
  const result = await runStateMachine(options)
  return { result, calls, persisted: persistedStates }
}

/** Run one config with a custom executor; returns the terminal result. */
function runWith(
  config: WorkflowConfig,
  executor: StepExecutor,
  controller: AbortController = new AbortController(),
  inputs: Record<string, string> = {},
): Promise<Awaited<ReturnType<typeof runStateMachine>>> {
  const options: EngineRunOptions = {
    config,
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    configFile: 'x.yaml',
    inputs,
    parent: fakeParent,
    signal: controller.signal,
    executor,
    persist: async () => {},
    load: async () => null,
    resolveSubworkflow: async () => config,
    askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
  }
  return runStateMachine(options)
}

function singleStepConfig(
  step: WorkflowConfig['workflow']['states'][number]['steps'][number],
  workflow: Partial<WorkflowConfig['workflow']> = {},
): WorkflowConfig {
  return {
    workflow: {
      name: '单步',
      mode: 'state-machine',
      states: [
        { name: '主', steps: [step], transitions: [], isInitial: true, isFinal: true },
      ],
      ...workflow,
    },
  }
}

describe('runStateMachine', () => {
  it('walks the happy path to completion', async () => {
    const { result, calls } = await run(redBlueConfig(), {
      '方案/方案裁决': V('pass'),
      '执行/任务执行': V('pass'),
      '验收/验收验证': V('pass'),
      '完成/交付汇总': V('pass'),
    })
    expect(result.status).toBe('completed')
    expect(result.verdict).toBe('pass')
    expect(calls).toContain('方案/方案设计')
    expect(calls).toContain('方案/方案挑战')
    expect(calls).toContain('方案/方案裁决')
    expect(result.stateOutcomes.map((o) => o.state)).toEqual(['方案', '执行', '验收', '完成'])
  })

  it('follows the adversarial evidence order: defender, attacker, judge', async () => {
    const { calls } = await run(redBlueConfig(), {
      '方案/方案裁决': V('pass'),
      '执行/任务执行': V('pass'),
      '验收/验收验证': V('pass'),
    })
    const planState = calls.filter((c) => c.startsWith('方案/'))
    expect(planState).toEqual(['方案/方案设计', '方案/方案挑战', '方案/方案裁决'])
  })

  it('re-enters the state on conditional_pass and continues on pass', async () => {
    let planJudges = 0
    const executor: StepExecutor = {
      async runAgentStep(input) {
        if (input.ctx.state === '方案' && input.stepName === '方案裁决') {
          planJudges += 1
          return { outputSummary: '', verdict: planJudges === 1 ? V('conditional_pass') : V('pass') }
        }
        return { outputSummary: '', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('该测试不应启动 LLM 步骤')
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
    }
    const persisted: RunState[] = []
    const options: EngineRunOptions = {
      config: redBlueConfig(),
      runId: 'run-2',
      configFile: 'red-blue.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async (state) => {
        persisted.push(JSON.parse(JSON.stringify(state)) as RunState)
      },
      load: async () => null,
      resolveSubworkflow: async () => redBlueConfig(),
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const runResult = await runStateMachine(options)
    expect(planJudges).toBe(2)
    expect(runResult.status).toBe('completed')
    expect(runResult.stateOutcomes[0]!.verdict.verdict).toBe('conditional_pass')
    expect(runResult.stateOutcomes[1]!.verdict.verdict).toBe('pass')
  })

  it('returns to an earlier state on fail', async () => {
    let executions = 0
    const executor: StepExecutor = {
      async runAgentStep(input) {
        if (input.ctx.state === '执行') {
          executions += 1
          return { outputSummary: '', verdict: executions === 1 ? V('fail') : V('pass') }
        }
        return { outputSummary: '', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('该测试不应启动 LLM 步骤')
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
    }
    const options: EngineRunOptions = {
      config: redBlueConfig(),
      runId: 'run-3',
      configFile: 'red-blue.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => redBlueConfig(),
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const runResult = await runStateMachine(options)
    expect(executions).toBe(2)
    expect(runResult.status).toBe('completed')
  })

  it('trips the maxTransitions fuse', async () => {
    const config = redBlueConfig({ maxTransitions: 3 })
    const executor: StepExecutor = {
      async runAgentStep(input) {
        // 执行 state keeps failing, bouncing back to 方案 forever.
        if (input.ctx.state === '执行') return { outputSummary: '', verdict: V('fail') }
        return { outputSummary: '', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('该测试不应启动 LLM 步骤')
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
    }
    const options: EngineRunOptions = {
      config,
      runId: 'run-4',
      configFile: 'red-blue.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('熔断')
  })

  it('resumes mid-state and skips completed steps', async () => {
    const config = redBlueConfig()
    const stepOutcome = (key: string): StepOutcome => ({
      key,
      state: '方案',
      step: '方案设计',
      type: 'agent',
      agent: 'architect',
      role: 'defender',
      outputSummary: '已完成',
      verdict: V('pass'),
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:01:00Z',
    })
    const persisted = createRunState({
      runId: 'run-5',
      workflowName: config.workflow.name,
      configFile: 'red-blue.yaml',
      config,
      inputs: {},
      parentSessionId: SID,
    })
    persisted.status = 'running'
    persisted.currentState = '方案'
    persisted.pendingState = { name: '方案', completedSteps: [stepOutcome('方案/方案设计')] }
    const { calls } = await run(
      config,
      {
        '方案/方案挑战': V('pass'),
        '方案/方案裁决': V('pass'),
        '执行/任务执行': V('pass'),
        '验收/验收验证': V('pass'),
        '完成/交付汇总': V('pass'),
      },
      persisted,
    )
    expect(calls).not.toContain('方案/方案设计')
    expect(calls).toContain('方案/方案挑战')
  })

  it('resumes a waiting-human no-match decision from the persisted state', async () => {
    const config = redBlueConfig()
    let humanCalls = 0
    const executor: StepExecutor = {
      async runAgentStep(input) {
        // Live executions pass; the persisted state already carries the
        // historical 验收 fail that produced the waiting-human decision point.
        return { outputSummary: '', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('该测试不应启动 LLM 步骤')
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
    }
    // Simulate a run that reached 验收, got a fail with no matching edge, and
    // persisted its waiting-human decision point before the process died.
    const persisted = createRunState({
      runId: 'run-6',
      workflowName: config.workflow.name,
      configFile: 'red-blue.yaml',
      config,
      inputs: {},
      parentSessionId: SID,
    })
    persisted.status = 'waiting-human'
    persisted.currentState = '验收'
    persisted.pendingHuman = { kind: 'no-match', state: '验收', candidates: ['方案', '执行', '验收'] }
    persisted.stateOutcomes = [
      { state: '方案', verdict: V('pass'), steps: [], finishedAt: '2026-01-01T00:00:00Z' },
      { state: '执行', verdict: V('pass'), steps: [], finishedAt: '2026-01-01T00:01:00Z' },
      { state: '验收', verdict: V('fail'), steps: [], finishedAt: '2026-01-01T00:02:00Z' },
    ]
    const options: EngineRunOptions = {
      config,
      runId: 'run-6',
      configFile: 'red-blue.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => JSON.parse(JSON.stringify(persisted)) as RunState,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => {
        humanCalls += 1
        return candidates[0] ?? ''
      },
    }
    const second = await runStateMachine(options)
    expect(humanCalls).toBe(1)
    expect(second.status).toBe('completed')
  })

  it('runs subworkflow steps and maps their outcome', async () => {
    const config: WorkflowConfig = {
      workflow: {
        name: '子流',
        mode: 'state-machine',
        states: [
          {
            name: '主',
            steps: [
              { name: '子工作流', type: 'subworkflow', workflow: 'child.yaml' },
              { name: '汇总', agent: 'documentation-writer', role: 'defender', task: '汇总' },
            ],
            transitions: [],
            isInitial: true,
            isFinal: true,
          },
        ],
      },
    }
    const calls: string[] = []
    const executor: StepExecutor = {
      async runAgentStep(input) {
        calls.push(`${input.ctx.state}/${input.stepName}`)
        return { outputSummary: '', verdict: V('pass') }
      },
      async runSubworkflowStep(input) {
        calls.push(`sub:${input.stepName}`)
        return { outcome: 'completed', verdict: V('pass') }
      },
    }
    const options: EngineRunOptions = {
      config,
      runId: 'run-7',
      configFile: 'p.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    expect(result.status).toBe('completed')
    expect(calls).toContain('sub:子工作流')
    expect(calls).toContain('主/汇总')
  })

  it('records supervisor scores and notes on state outcomes', async () => {
    const config = redBlueConfig({
      supervisor: { enabled: true, agent: 'default-supervisor', checkpointPolicy: 'all' },
    })
    const executor: StepExecutor = {
      async runAgentStep() {
        return { outputSummary: '', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('该测试不应启动 LLM 步骤')
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
      async supervisorAdvice(input) {
        if (input.ctx.state === '方案') return { advice: '方案证据充分', score: 8 }
        return { advice: '', score: null }
      },
    }
    const options: EngineRunOptions = {
      config,
      runId: 'run-score',
      configFile: 'red-blue.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    const plan = result.stateOutcomes.find((outcome) => outcome.state === '方案')!
    expect(plan.supervisorScore).toBe(8)
    expect(plan.supervisorNote).toBe('方案证据充分')
    const exec = result.stateOutcomes.find((outcome) => outcome.state === '执行')!
    expect(exec.supervisorScore).toBeUndefined()
    expect(exec.supervisorNote).toBeUndefined()
  })

  it('runs a script-only pipeline end to end with binary transitions', async () => {
    const config: WorkflowConfig = {
      workflow: {
        name: '脚本流水线',
        mode: 'state-machine',
        maxTransitions: 10,
        states: [
          {
            name: '检查',
            steps: [{ name: '校验输入', type: 'script', script: 'return { output: "通过", success: context.requirements !== "" }' }],
            transitions: [
              { to: '转换', condition: { verdict: 'success' }, priority: 10 },
              { to: '失败', condition: { verdict: 'fail' }, priority: 20 },
            ],
            isInitial: true,
            isFinal: false,
          },
          {
            name: '转换',
            steps: [{ name: '大写', type: 'script', script: 'return { output: context.priorStepEvidence.toUpperCase().slice(0, 40), success: true }' }],
            transitions: [{ to: '完成', condition: { verdict: 'success' }, priority: 10 }],
            isInitial: false,
            isFinal: false,
          },
          {
            name: '失败',
            steps: [{ name: '记录', type: 'script', script: 'return { output: "失败", success: true }' }],
            transitions: [],
            isInitial: false,
            isFinal: true,
          },
          {
            name: '完成',
            steps: [{ name: '汇总', type: 'script', script: 'return { output: "完成", success: true }' }],
            transitions: [],
            isInitial: false,
            isFinal: true,
          },
        ],
      },
    }
    const executor: StepExecutor = {
      async runAgentStep() {
        throw new Error('脚本流水线不应启动 Agent 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('脚本流水线不应启动子工作流')
      },
    }
    const options: EngineRunOptions = {
      config,
      runId: 'run-script-ok',
      configFile: 'script.yaml',
      inputs: { requirements: 'hello' },
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const success = await runStateMachine(options)
    expect(success.status).toBe('completed')
    expect(success.verdict).toBe('success')
    expect(success.stateOutcomes.map((o) => o.state)).toEqual(['检查', '转换', '完成'])
    expect(success.failedStates).toEqual([])

    const failOptions: EngineRunOptions = { ...options, runId: 'run-script-fail', inputs: { requirements: '' } }
    const failed = await runStateMachine(failOptions)
    expect(failed.status).toBe('completed')
    expect(failed.stateOutcomes.map((o) => o.state)).toEqual(['检查', '失败'])
    // 终态是失败分支的成功，但失败状态必须被显式标记出来。
    expect(failed.verdict).toBe('success')
    expect(failed.failedStates).toEqual(['检查'])
  })

  it('skips supervisor checkpoints on success-forward states under the risks policy', async () => {
    let checkpoints = 0
    const executor: StepExecutor = {
      async runAgentStep() {
        return { outputSummary: '', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('该测试不应启动 LLM 步骤')
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
      async supervisorAdvice() {
        checkpoints += 1
        return { advice: '', score: null }
      },
    }
    const options: EngineRunOptions = {
      config: redBlueConfig(),
      runId: 'run-checkpoints',
      configFile: 'red-blue.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => redBlueConfig(),
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    expect(result.status).toBe('completed')
    expect(checkpoints).toBe(0)
  })

  it('runs supervisor checkpoints for failed states under the risks policy', async () => {
    let executions = 0
    let checkpoints = 0
    const executor: StepExecutor = {
      async runAgentStep(input) {
        if (input.ctx.state === '执行') {
          executions += 1
          return { outputSummary: '', verdict: executions === 1 ? V('fail') : V('pass') }
        }
        return { outputSummary: '', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('该测试不应启动 LLM 步骤')
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
      async supervisorAdvice(input) {
        if (input.ctx.state === '执行') checkpoints += 1
        return { advice: '', score: null }
      },
    }
    const options: EngineRunOptions = {
      config: redBlueConfig(),
      runId: 'run-checkpoint-fail',
      configFile: 'red-blue.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => redBlueConfig(),
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    expect(result.status).toBe('completed')
    expect(checkpoints).toBe(1)
  })

  it('runs every supervisor checkpoint under the all policy', async () => {
    let checkpoints = 0
    const executor: StepExecutor = {
      async runAgentStep() {
        return { outputSummary: '', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('该测试不应启动 LLM 步骤')
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
      async supervisorAdvice() {
        checkpoints += 1
        return { advice: '', score: null }
      },
    }
    const config = redBlueConfig({ supervisor: { enabled: true, agent: 'default-supervisor', checkpointPolicy: 'all' } })
    const options: EngineRunOptions = {
      config,
      runId: 'run-checkpoint-all',
      configFile: 'red-blue.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    expect(result.status).toBe('completed')
    expect(checkpoints).toBe(3)
  })

  it('dispatches llm steps to runLlmStep and flows binary transitions', async () => {
    const config: WorkflowConfig = {
      workflow: {
        name: 'LLM 判定',
        mode: 'state-machine',
        maxTransitions: 10,
        states: [
          {
            name: '判定',
            steps: [
              {
                name: '快速判定',
                type: 'llm',
                model: 'fast-model',
                task: '判断输入是否合法',
                role: 'judge',
              },
            ],
            transitions: [
              { to: '通过', condition: { verdict: 'success' }, priority: 10 },
              { to: '拒绝', condition: { verdict: 'fail' }, priority: 20 },
            ],
            isInitial: true,
            isFinal: false,
          },
          {
            name: '通过',
            steps: [{ name: '记录', type: 'script', script: 'return { output: "通过", success: true }' }],
            transitions: [],
            isInitial: false,
            isFinal: true,
          },
          {
            name: '拒绝',
            steps: [{ name: '记录', type: 'script', script: 'return { output: "拒绝", success: true }' }],
            transitions: [],
            isInitial: false,
            isFinal: true,
          },
        ],
      },
    }
    const { result, calls } = await run(config, {
      '判定/快速判定': V('success', '输入合法'),
    })
    expect(result.status).toBe('completed')
    expect(result.verdict).toBe('success')
    expect(calls).toContain('llm:判定/快速判定')
    expect(calls).not.toContain('判定/快速判定')
    expect(result.stateOutcomes.map((o) => o.state)).toEqual(['判定', '通过'])
  })

  it('routes llm steps to the fail branch on a fail verdict', async () => {
    const config: WorkflowConfig = {
      workflow: {
        name: 'LLM 判定失败',
        mode: 'state-machine',
        maxTransitions: 10,
        states: [
          {
            name: '判定',
            steps: [{ name: '快速判定', type: 'llm', task: '判断' }],
            transitions: [
              { to: '通过', condition: { verdict: 'success' }, priority: 10 },
              { to: '拒绝', condition: { verdict: 'fail' }, priority: 20 },
            ],
            isInitial: true,
            isFinal: false,
          },
          {
            name: '通过',
            steps: [{ name: '记录', type: 'script', script: 'return { output: "通过", success: true }' }],
            transitions: [],
            isInitial: false,
            isFinal: true,
          },
          {
            name: '拒绝',
            steps: [{ name: '记录', type: 'script', script: 'return { output: "拒绝", success: true }' }],
            transitions: [],
            isInitial: false,
            isFinal: true,
          },
        ],
      },
    }
    const { result } = await run(config, {
      '判定/快速判定': V('fail', '输入非法'),
    })
    expect(result.status).toBe('completed')
    expect(result.stateOutcomes.map((o) => o.state)).toEqual(['判定', '拒绝'])
  })
  it('runs parallel segments concurrently', async () => {
    const config: WorkflowConfig = {
      workflow: {
        name: '并行',
        mode: 'state-machine',
        states: [
          {
            name: '分析',
            steps: [
              { name: 'a', agent: 'researcher', role: 'defender', task: 'a', parallelGroup: 'g' },
              { name: 'b', agent: 'architect', role: 'attacker', task: 'b', parallelGroup: 'g' },
              { name: 'c', agent: 'code-judge', role: 'judge', task: 'c' },
            ],
            transitions: [],
            isInitial: true,
            isFinal: true,
          },
        ],
      },
    }
    const active: string[] = []
    const executor: StepExecutor = {
      async runAgentStep(input) {
        active.push(input.stepName)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active.splice(active.indexOf(input.stepName), 1)
        return { outputSummary: '', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('该测试不应启动 LLM 步骤')
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
    }
    let maxConcurrent = 0
    let inFlight = 0
    const wrapped: StepExecutor = {
      ...executor,
      async runAgentStep(input) {
        inFlight += 1
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        try {
          return await executor.runAgentStep(input)
        } finally {
          inFlight -= 1
        }
      },
    }
    const options: EngineRunOptions = {
      config,
      runId: 'run-8',
      configFile: 'p.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor: wrapped,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    expect(result.status).toBe('completed')
    expect(maxConcurrent).toBeGreaterThanOrEqual(2)
  })

  it('carries script data to downstream scripts and AI steps', async () => {
    const config: WorkflowConfig = {
      workflow: {
        name: '数据流转',
        mode: 'state-machine',
        maxTransitions: 10,
        states: [
          {
            name: '计算',
            steps: [
              { name: '产出', type: 'script', script: 'return { output: "算好了", success: true, data: { answer: 42 } }' },
            ],
            transitions: [{ to: '消费', condition: { verdict: 'success' }, priority: 10 }],
            isInitial: true,
            isFinal: false,
          },
          {
            name: '消费',
            steps: [
              { name: '脚本消费', type: 'script', script: 'const d = context.stepData["计算/产出"]; return { output: "answer=" + d.answer, success: true }' },
              { name: 'AI消费', agent: 'architect', role: 'defender', task: '汇总' },
            ],
            transitions: [],
            isInitial: false,
            isFinal: true,
          },
        ],
      },
    }
    const captured: Record<string, unknown>[] = []
    const executor: StepExecutor = {
      async runAgentStep(input) {
        captured.push(input.ctx.stepData)
        return { outputSummary: 'ok', verdict: V('pass') }
      },
      async runLlmStep(input) {
        captured.push(input.ctx.stepData)
        return { outputSummary: 'ok', verdict: V('pass') }
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
    }
    const options: EngineRunOptions = {
      config,
      runId: 'run-data',
      configFile: 'data.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    expect(result.status).toBe('completed')
    const producer = result.stateOutcomes.find((outcome) => outcome.state === '计算')!
    expect(producer.steps[0]!.data).toEqual({ answer: 42 })
    const consumer = result.stateOutcomes.find((outcome) => outcome.state === '消费')!
    const scriptStep = consumer.steps.find((step) => step.step === '脚本消费')!
    expect(scriptStep.outputSummary).toBe('answer=42')
    // The AI step received the structured payload under its `<state>/<step>` key.
    expect(captured[0]!['计算/产出']).toEqual({ answer: 42 })
  })

  it('retries transient step errors with backoff and records attempts', async () => {
    const config = singleStepConfig(
      { name: 'AI', agent: 'researcher', role: 'defender', task: '分析', retry: { maxRetries: 2, backoffMs: 1 } },
    )
    let calls = 0
    const executor: StepExecutor = {
      async runAgentStep() {
        calls += 1
        if (calls < 3) throw new Error(`瞬时失败 ${calls}`)
        return { outputSummary: '第三次成功', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const result = await runWith(config, executor)
    expect(result.status).toBe('completed')
    expect(calls).toBe(3)
    expect(result.stateOutcomes[0]!.steps[0]!.attempts).toBe(3)
  })

  it('applies the workflow-level stepRetry default', async () => {
    const config = singleStepConfig(
      { name: 'AI', agent: 'researcher', role: 'defender', task: '分析' },
      { stepRetry: { maxRetries: 1, backoffMs: 1 } },
    )
    let calls = 0
    const executor: StepExecutor = {
      async runAgentStep() {
        calls += 1
        if (calls === 1) throw new Error('第一次失败')
        return { outputSummary: '成功', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const result = await runWith(config, executor)
    expect(result.status).toBe('completed')
    expect(calls).toBe(2)
  })

  it('does not retry a fail verdict', async () => {
    const config = singleStepConfig(
      { name: 'AI', agent: 'code-judge', role: 'judge', task: '裁决', retry: { maxRetries: 3, backoffMs: 1 } },
    )
    let calls = 0
    const executor: StepExecutor = {
      async runAgentStep() {
        calls += 1
        return { outputSummary: '裁决失败', verdict: V('fail') }
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const result = await runWith(config, executor)
    expect(result.status).toBe('completed')
    expect(calls).toBe(1)
    expect(result.stateOutcomes[0]!.verdict.verdict).toBe('fail')
  })

  it('fails the run after retries are exhausted', async () => {
    const config = singleStepConfig(
      { name: 'AI', agent: 'researcher', role: 'defender', task: '分析', retry: { maxRetries: 1, backoffMs: 1 } },
    )
    const executor: StepExecutor = {
      async runAgentStep() {
        throw new Error('一直失败')
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const result = await runWith(config, executor)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('一直失败')
  })

  it('records failed steps with their retry count and persists them (P0-B)', async () => {
    const config = singleStepConfig(
      { name: 'AI', agent: 'researcher', role: 'defender', task: '分析', retry: { maxRetries: 1, backoffMs: 1 } },
    )
    const persisted: RunState[] = []
    const executor: StepExecutor = {
      async runAgentStep() {
        throw new Error('一直失败')
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const options: EngineRunOptions = {
      config,
      runId: 'run-fail-record',
      configFile: 'x.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor,
      persist: async (state) => {
        persisted.push(JSON.parse(JSON.stringify(state)) as RunState)
      },
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    expect(result.status).toBe('failed')
    const last = persisted[persisted.length - 1]!
    expect(last.failedSteps).toHaveLength(1)
    expect(last.failedSteps![0]).toMatchObject({
      key: '主/AI',
      state: '主',
      step: 'AI',
      type: 'agent',
      error: '一直失败',
      attempts: 2, // first attempt + one retry (maxRetries: 1)
    })
  })

  it('does not record deliberately aborted steps as failures (stopped, not failed)', async () => {
    const config = singleStepConfig(
      { name: 'AI', agent: 'researcher', role: 'defender', task: '分析', retry: { maxRetries: 5, backoffMs: 30 } },
    )
    const persisted: RunState[] = []
    const executor: StepExecutor = {
      async runAgentStep() {
        throw new Error('持续失败')
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 20)
    const options: EngineRunOptions = {
      config,
      runId: 'run-abort-record',
      configFile: 'x.yaml',
      inputs: {},
      parent: fakeParent,
      signal: controller.signal,
      executor,
      persist: async (state) => {
        persisted.push(JSON.parse(JSON.stringify(state)) as RunState)
      },
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
    }
    const result = await runStateMachine(options)
    expect(result.status).toBe('stopped')
    expect(persisted[persisted.length - 1]?.failedSteps ?? []).toHaveLength(0)
  })

  it('threads step timeoutMinutes to the executor in ms', async () => {
    const config = singleStepConfig(
      { name: 'AI', agent: 'researcher', role: 'defender', task: '分析', timeoutMinutes: 5 },
    )
    const seen: (number | undefined)[] = []
    const executor: StepExecutor = {
      async runAgentStep(input) {
        seen.push(input.timeoutMs)
        return { outputSummary: 'ok', verdict: V('pass') }
      },
      async runLlmStep(input) {
        seen.push(input.timeoutMs)
        return { outputSummary: 'ok', verdict: V('pass') }
      },
      async runSubworkflowStep() {
        return { outcome: 'completed', verdict: V('pass') }
      },
    }
    const result = await runWith(config, executor)
    expect(result.status).toBe('completed')
    expect(seen).toEqual([300_000])
  })

  it('stops the run when aborted during a retry backoff', async () => {
    const config = singleStepConfig(
      { name: 'AI', agent: 'researcher', role: 'defender', task: '分析', retry: { maxRetries: 5, backoffMs: 100 } },
    )
    const executor: StepExecutor = {
      async runAgentStep() {
        throw new Error('持续失败')
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 50)
    const result = await runWith(config, executor, controller)
    expect(result.status).toBe('stopped')
  })

  it('measures agent steps with wall-clock brackets around the real execution (P1-E)', async () => {
    const config = singleStepConfig(
      { name: '慢AI', agent: 'researcher', role: 'defender', task: '慢' },
    )
    const executor: StepExecutor = {
      async runAgentStep() {
        await new Promise((resolve) => setTimeout(resolve, 15))
        return { outputSummary: 'done', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const result = await runWith(config, executor)
    const step = result.stateOutcomes[0]!.steps[0]!
    expect(step.startedAt).not.toBe(step.finishedAt)
    expect(Date.parse(step.finishedAt)).toBeGreaterThanOrEqual(Date.parse(step.startedAt))
    // Monotonic duration must cover the actual 15ms execution.
    expect(step.durationMs).toBeGreaterThanOrEqual(10)
  })

  it('stamps script steps around their real execution, not after it (F7 pre-defect)', async () => {
    const config = singleStepConfig(
      { name: '慢脚本', type: 'script', script: 'const t = Date.now(); while (Date.now() - t < 15) {}; return { output: "slow", success: true }' },
    )
    const executor: StepExecutor = {
      async runAgentStep() {
        throw new Error('不应调用 Agent 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const result = await runWith(config, executor)
    const step = result.stateOutcomes[0]!.steps[0]!
    expect(step.type).toBe('script')
    // Before the fix both stamps were taken after execution (startedAt ==
    // finishedAt, duration 恒 0); the brackets must now span the execution.
    expect(step.startedAt).not.toBe(step.finishedAt)
    expect(step.durationMs).toBeGreaterThanOrEqual(10)
  })

  it('falls back to run-time inputs when the workflow left requirements empty', async () => {
    const config = singleStepConfig(
      { name: 'AI', agent: 'researcher', role: 'defender', task: '分析' },
    )
    const seen: string[] = []
    const executor: StepExecutor = {
      async runAgentStep(input) {
        seen.push(input.ctx.requirements)
        return { outputSummary: 'ok', verdict: V('pass') }
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM 步骤')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const result = await runWith(config, executor, new AbortController(), { requirements: '运行时需求' })
    expect(result.status).toBe('completed')
    expect(seen).toEqual(['运行时需求'])
  })

  it('runs a scriptFile step through the engine', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ace-runner-script-'))
    try {
      writeFileSync(join(dir, 'check.js'), 'return { output: "checked: " + context.requirements, success: true }')
      const config: WorkflowConfig = {
        workflow: {
          name: '文件脚本',
          mode: 'state-machine',
          states: [
            {
              name: '检查',
              steps: [{ name: '导入脚本', type: 'script', scriptFile: 'check.js' }],
              transitions: [],
              isInitial: true,
              isFinal: true,
            },
          ],
        },
        context: { projectRoot: dir },
      }
      const executor: StepExecutor = {
        async runAgentStep() {
          throw new Error('不应调用 Agent 步骤')
        },
        async runLlmStep() {
          throw new Error('不应调用 LLM 步骤')
        },
        async runSubworkflowStep() {
          throw new Error('不应调用子工作流')
        },
      }
      const options: EngineRunOptions = {
        config,
        runId: 'run-file-script',
        configFile: 'x.yaml',
        inputs: { requirements: 'payload' },
        parent: fakeParent,
        signal: new AbortController().signal,
        executor,
        persist: async () => {},
        load: async () => null,
        resolveSubworkflow: async () => config,
        askHumanTransition: async ({ candidates }) => candidates[0] ?? '',
      }
      const result = await runStateMachine(options)
      expect(result.status).toBe('completed')
      expect(result.stateOutcomes[0]!.steps[0]!.outputSummary).toBe('checked: payload')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
