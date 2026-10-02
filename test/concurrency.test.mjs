import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  createRuntime, emptyLedger, LedgerStore, LEDGER_FILENAME, resolveConfig,
  runMemoryPass, runObserver, runReflector, runDropper, scheduleMemoryPass
} from '../index.js'

const previousHome = process.env.DSH_HOME
const temporaryRoot = await realpath(tmpdir())
const home = await mkdtemp(join(temporaryRoot, 'om-concurrency-'))
process.env.DSH_HOME = home

test.after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  // Verify the exact resolved target before removing this suite's temporary tree.
  const target = await realpath(home)
  assert.equal(target, home)
  assert.equal(dirname(target), temporaryRoot)
  assert.ok(basename(target).startsWith('om-concurrency-'))
  await rm(target, { recursive: true, force: true })
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function sessionDir(id) {
  const dir = join(home, 'sessions', 'test-workspace', id)
  await mkdir(dir, { recursive: true })
  return dir
}

function agentFor(id) {
  const message = Object.freeze({
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: 'User confirmed the concurrency repair.' })])
  })
  const event = Object.freeze({ seq: 1, type: 'user/message', data: message })
  return {
    options: { provider: 'test', model: 'test' },
    session: {
      id,
      surface: { nodes: [1] },
      deriveMessages: () => [message],
      eventAt: (seq) => seq === 1 ? event : undefined
    }
  }
}

function runtimeFor(stream, config = {}) {
  return createRuntime({
    get: (key) => key === 'llm' ? { stream } : undefined,
    logger: { info() {}, warn() {} }
  }, resolveConfig({ observeAfterTokens: 1, reflectAfterTokens: 100000, callTimeoutMs: 10000, ...config }))
}

function gatedStream(reply) {
  const entered = deferred()
  const release = deferred()
  let signal
  return {
    entered, release,
    get signal() { return signal },
    async *stream(options) {
      signal = options.signal
      entered.resolve()
      // Deliberately ignore abort to simulate an uncooperative adapter.
      await release.promise
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('concurrent first loads share one mutable ledger and persist every update', async () => {
  const id = 'shared-first-load'
  const dir = await sessionDir(id)
  const store = new LedgerStore()
  const first = store.load(id).then((ledger) => {
    ledger.observations.push({ id: 'first', content: 'first reader update' })
    return ledger
  })
  const readers = Array.from({ length: 20 }, () => store.load(id))
  const [ledger, ...others] = await Promise.all([first, ...readers])
  for (const other of others) assert.strictEqual(other, ledger)
  assert.strictEqual(store.cache.get(id), ledger)
  assert.equal(store.loads.size, 0)
  others.at(-1).reflections.push({ id: 'second', content: 'another reader update', supportingIds: [] })
  await store.save(id)
  const persisted = JSON.parse(await readFile(join(dir, LEDGER_FILENAME), 'utf8'))
  assert.deepEqual(persisted.observations, ledger.observations)
  assert.deepEqual(persisted.reflections, ledger.reflections)
})

test('failed first-load flight is cleared and a later load retries', async () => {
  const store = new LedgerStore()
  const get = store.dirs.get.bind(store.dirs)
  let failures = 1
  store.dirs.get = (id) => {
    if (failures-- > 0) throw new Error('temporary directory lookup failure')
    return get(id)
  }
  const results = await Promise.allSettled([store.load('retry-load'), store.load('retry-load')])
  assert.ok(results.every((result) => result.status === 'rejected'))
  assert.equal(store.loads.size, 0)
  assert.equal(store.cache.has('retry-load'), false)
  const ledger = await store.load('retry-load')
  assert.strictEqual(await store.load('retry-load'), ledger)
})

test('late canceled pass cannot write the ledger or remove its replacement owner', async () => {
  const id = 'late-owner'
  const dir = await sessionDir(id)
  const oldWorker = gatedStream('[{"content":"obsolete worker result","sourceSeqs":[1]}]')
  const newWorker = gatedStream('[{"content":"replacement worker result","relevance":"high","sourceSeqs":[1]}]')
  let calls = 0
  const runtime = runtimeFor((options) => (++calls === 1 ? oldWorker : newWorker).stream(options))
  const agent = agentFor(id)
  scheduleMemoryPass(runtime, agent)
  const oldOwner = runtime.memoryPasses.get(id)
  await oldWorker.entered.promise
  oldOwner.startedAt -= runtime.config.passTimeoutMs + 1
  scheduleMemoryPass(runtime, agent)
  const newOwner = runtime.memoryPasses.get(id)
  await newWorker.entered.promise
  assert.notStrictEqual(newOwner, oldOwner)
  assert.equal(oldOwner.controller.signal.aborted, true)
  assert.equal(oldWorker.signal.aborted, true)
  assert.equal(runtime.stats.stalePassesReclaimed, 1)

  oldWorker.release.resolve()
  await assert.rejects(oldOwner.promise, /stale memory run/)
  assert.strictEqual(runtime.memoryPasses.get(id), newOwner, 'old finally must not delete the new lock')
  const ledger = await runtime.store.load(id)
  assert.equal(ledger.observations.length, 0)
  assert.equal(ledger.observedCount, 0)
  await assert.rejects(readFile(join(dir, LEDGER_FILENAME), 'utf8'), { code: 'ENOENT' })
  scheduleMemoryPass(runtime, agent)
  const joined = runMemoryPass(runtime, agent)
  assert.equal(calls, 2, 'scheduler skips and direct callers join the replacement')
  newWorker.release.resolve()
  assert.deepEqual(await joined, await newOwner.promise)
  assert.equal(runtime.memoryPasses.has(id), false)
  assert.equal(runtime.inflight.size, 0)
  assert.equal(ledger.observations.length, 1)
  assert.equal(ledger.observations[0].content, 'replacement worker result')
  assert.deepEqual(ledger.observations[0].sourceSeqs, [1])
  const persisted = JSON.parse(await readFile(join(dir, LEDGER_FILENAME), 'utf8'))
  assert.deepEqual(persisted.observations, ledger.observations)
})

test('synchronous abort-listener reentry joins the published replacement owner', async () => {
  const oldWorker = gatedStream('[{"content":"obsolete result","relevance":"high","sourceSeqs":[1]}]')
  const newWorker = gatedStream('[{"content":"replacement result","relevance":"high","sourceSeqs":[1]}]')
  let calls = 0
  const runtime = runtimeFor((options) => (++calls === 1 ? oldWorker : newWorker).stream(options))
  const agent = agentFor('abort-reentry')
  scheduleMemoryPass(runtime, agent)
  const oldOwner = runtime.memoryPasses.get(agent.session.id)
  await oldWorker.entered.promise
  oldOwner.startedAt -= runtime.config.passTimeoutMs + 1
  let nested
  let nestedOwner
  oldOwner.controller.signal.addEventListener('abort', () => {
    nested = runMemoryPass(runtime, agent)
    nestedOwner = runtime.memoryPasses.get(agent.session.id)
  }, { once: true })
  const outer = runMemoryPass(runtime, agent)
  const replacement = runtime.memoryPasses.get(agent.session.id)
  assert.strictEqual(nestedOwner, replacement, 'the abort callback must see the replacement, not the old owner')
  await newWorker.entered.promise
  assert.equal(calls, 2)
  assert.equal(runtime.stats.stalePassesReclaimed, 1)
  oldWorker.release.resolve()
  await assert.rejects(oldOwner.promise, /stale memory run/)
  assert.strictEqual(runtime.memoryPasses.get(agent.session.id), replacement)
  newWorker.release.resolve()
  assert.deepEqual(await nested, await outer)
  const ledger = await runtime.store.load(agent.session.id)
  assert.equal(ledger.observations.length, 1)
  assert.equal(ledger.observations[0].content, 'replacement result')
  assert.deepEqual(ledger.observations[0].sourceSeqs, [1])
  assert.equal(runtime.memoryPasses.size, 0)
})

test('direct pass callers share the scheduler owner and execute only once', async () => {
  const worker = gatedStream('[]')
  const runtime = runtimeFor(worker.stream)
  const agent = agentFor('direct-join')
  const first = runMemoryPass(runtime, agent)
  const second = runMemoryPass(runtime, agent)
  scheduleMemoryPass(runtime, agent)
  await worker.entered.promise
  assert.equal(runtime.stats.passesStarted, 1)
  worker.release.resolve()
  assert.deepEqual(await first, await second)
  assert.equal(runtime.stats.passesCompleted, 1)
  assert.equal(runtime.memoryPasses.size, 0)
})

for (const [kind, run, reply] of [
  ['observer', runObserver, '[{"content":"canceled observation","sourceSeqs":[1]}]'],
  ['reflector', runReflector, '[{"content":"canceled reflection","supportingIds":["seed"]}]'],
  ['dropper', runDropper, '["seed"]']
]) {
  test(`canceled ${kind} worker cannot mutate or persist a late valid answer`, async () => {
    const id = `cancel-${kind}`
    const dir = await sessionDir(id)
    const worker = gatedStream(reply)
    const runtime = runtimeFor(worker.stream, { reflectAfterTokens: 1, observationsPoolTargetTokens: 1 })
    const ledger = await runtime.store.load(id)
    if (kind !== 'observer') {
      ledger.observations.push({ id: 'seed', content: 'Existing load-bearing observation', timestamp: '2026-01-01', relevance: 'high', tokens: 10, evidence: 'source' })
    }
    await runtime.store.save(id)
    const before = JSON.stringify(ledger)
    const diskBefore = await readFile(join(dir, LEDGER_FILENAME), 'utf8')
    const controller = new AbortController()
    const running = run(runtime, agentFor(id), ledger, controller.signal)
    await worker.entered.promise
    controller.abort(new Error('worker canceled'))
    worker.release.resolve()
    await assert.rejects(running, /worker canceled/)
    assert.equal(JSON.stringify(ledger), before)
    assert.equal(await readFile(join(dir, LEDGER_FILENAME), 'utf8'), diskBefore)
  })
}

test('canceling a direct pass owner forwards abort to its worker and releases only its own lock', async () => {
  const worker = gatedStream('[{"content":"canceled direct pass","relevance":"high","sourceSeqs":[1]}]')
  const runtime = runtimeFor(worker.stream)
  const agent = agentFor('cancel-direct-owner')
  const controller = new AbortController()
  const running = runMemoryPass(runtime, agent, controller.signal)
  await worker.entered.promise
  controller.abort(new Error('direct owner canceled'))
  assert.equal(worker.signal.aborted, true)
  worker.release.resolve()
  await assert.rejects(running, /direct owner canceled/)
  const ledger = await runtime.store.load(agent.session.id)
  assert.equal(ledger.observations.length, 0)
  assert.equal(ledger.observedCount, 0)
  assert.equal(runtime.memoryPasses.size, 0)
  assert.equal(runtime.inflight.size, 0)
})

test('late ledger load from a reclaimed pass stops before reading any conversation', async () => {
  const runtime = runtimeFor(async function *() { throw new Error('no worker should run') })
  const oldLoad = deferred()
  const newLoad = deferred()
  const oldEntered = deferred()
  const newEntered = deferred()
  let loads = 0
  runtime.store.load = () => {
    if (++loads === 1) { oldEntered.resolve(); return oldLoad.promise }
    newEntered.resolve(); return newLoad.promise
  }
  const agent = agentFor('late-ledger-load')
  let reads = 0
  agent.session.deriveMessages = () => { reads += 1; return [] }
  agent.session.surface.nodes = []
  scheduleMemoryPass(runtime, agent)
  const oldOwner = runtime.memoryPasses.get(agent.session.id)
  await oldEntered.promise
  oldOwner.startedAt -= runtime.config.passTimeoutMs + 1
  scheduleMemoryPass(runtime, agent)
  const newOwner = runtime.memoryPasses.get(agent.session.id)
  await newEntered.promise
  oldLoad.resolve(emptyLedger(agent.session.id))
  await assert.rejects(oldOwner.promise, /stale memory run/)
  assert.equal(reads, 0)
  assert.strictEqual(runtime.memoryPasses.get(agent.session.id), newOwner)
  newLoad.resolve(emptyLedger(agent.session.id))
  await newOwner.promise
  assert.ok(reads > 0)
  assert.equal(runtime.memoryPasses.size, 0)
  assert.equal(runtime.inflight.size, 0)
})

test('abort after the last yielded chunk is checked before accepting the worker result', async () => {
  const controller = new AbortController()
  const runtime = runtimeFor(async function *() {
    yield { type: 'text-delta', text: '[{"content":"late terminal result","sourceSeqs":[1]}]' }
    yield { type: 'finish', reason: { kind: 'stop' } }
    controller.abort(new Error('canceled at stream end'))
  })
  const ledger = emptyLedger('abort-at-stream-end')
  await assert.rejects(runObserver(runtime, agentFor(ledger.sessionId), ledger, controller.signal), /canceled at stream end/)
  assert.equal(ledger.observations.length, 0)
  assert.equal(ledger.observedCount, 0)
})

test('an already canceled pass starts neither ledger I/O nor worker calls', async () => {
  let calls = 0
  const runtime = runtimeFor(async function *() { calls += 1 })
  runtime.store.load = async () => { calls += 1; throw new Error('load must not start') }
  const controller = new AbortController()
  controller.abort(new Error('canceled before start'))
  await assert.rejects(runMemoryPass(runtime, agentFor('pre-canceled-pass'), controller.signal), /canceled before start/)
  assert.equal(calls, 0)
  assert.equal(runtime.memoryPasses.size, 0)
  assert.equal(runtime.inflight.size, 0)
})

for (const finish of ['max-tokens', 'error', 'aborted']) {
  test(`explicit ${finish} finish rejects even parseable JSON without advancing coverage`, async () => {
    const runtime = runtimeFor(async function *() {
      yield { type: 'text-delta', text: '[{"content":"must not be accepted","sourceSeqs":[1]}]' }
      yield { type: 'finish', reason: { kind: finish } }
    })
    const ledger = emptyLedger(`finish-${finish}`)
    let saves = 0
    runtime.store.save = async () => { saves += 1 }
    await assert.rejects(runObserver(runtime, agentFor(ledger.sessionId), ledger), new RegExp(finish))
    assert.equal(ledger.observations.length, 0)
    assert.equal(ledger.observedCount, 0)
    assert.equal(saves, 0)
  })
}
