/**
 * 后台任务登记：人格生成 / 修订、技能整理这类要跑几十秒的 LLM 调用。
 *
 * 控制台发起任务后立刻拿到任务 id，再轮询 `/api/jobs` 看结果；同一个 `key`
 * （例如同一个人格）同时只允许跑一个，避免连点两次各烧一份额度。
 */
import crypto from 'node:crypto'

const MAX_HISTORY = 40

export class JobRunner {
  constructor({ log } = {}) {
    this.log = log
    this.jobs = new Map()
    this.controllers = new Map()
    this.disposed = false
  }

  /**
   * @param {{kind:string, key?:string, label:string}} meta
   * @param {(ctx:{signal:AbortSignal, progress:(text:string)=>void}) => Promise<any>} run
   * @returns {{ok:true, job:object} | {ok:false, error:string, job?:object}}
   */
  start(meta, run) {
    if (this.disposed) return { ok: false, error: '插件正在卸载' }
    const key = meta.key ?? meta.kind
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.key === key) {
        return { ok: false, error: `「${job.label}」还在进行中`, job: publicJob(job) }
      }
    }
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      kind: meta.kind,
      key,
      label: meta.label,
      status: 'running',
      progress: '',
      startedAt: Date.now(),
      endedAt: null,
      result: null,
      error: null,
    }
    const controller = new AbortController()
    this.jobs.set(job.id, job)
    this.controllers.set(job.id, controller)
    this.#trim()
    const progress = text => {
      job.progress = String(text ?? '').slice(0, 200)
    }
    Promise.resolve()
      .then(() => {
        // 任务体还没开始就被取消了：直接按取消结束，不再调用它。
        controller.signal.throwIfAborted()
        return run({ signal: controller.signal, progress })
      })
      .then(result => {
        job.status = 'done'
        job.result = result ?? null
      })
      .catch(error => {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'
        job.error = String(error?.message ?? error)
        this.log?.warn(`[jobs] ${job.label} 失败：${job.error}`)
      })
      .finally(() => {
        job.endedAt = Date.now()
        this.controllers.delete(job.id)
      })
    return { ok: true, job: publicJob(job) }
  }

  cancel(id) {
    const controller = this.controllers.get(id)
    if (!controller) return false
    controller.abort(new Error('已取消'))
    return true
  }

  get(id) {
    const job = this.jobs.get(id)
    return job ? publicJob(job) : null
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(publicJob)
  }

  running() {
    return [...this.jobs.values()].filter(job => job.status === 'running').map(publicJob)
  }

  dispose() {
    this.disposed = true
    for (const controller of this.controllers.values()) controller.abort(new Error('插件卸载'))
    this.controllers.clear()
  }

  #trim() {
    if (this.jobs.size <= MAX_HISTORY) return
    const finished = [...this.jobs.values()].filter(job => job.status !== 'running').sort((a, b) => a.startedAt - b.startedAt)
    for (const job of finished) {
      if (this.jobs.size <= MAX_HISTORY) break
      this.jobs.delete(job.id)
    }
  }
}

function publicJob(job) {
  const { controller, ...rest } = job
  return { ...rest }
}
