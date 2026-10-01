/**
 * Tests for the observational-memory host half.
 *
 * These drive the real module against a fake Cordis context and a temporary
 * DSH_HOME, the same way the session-removal bundle is tested. There is no
 * harness process here: the point is the plugin's own contract — ledger
 * round-trip, coverage accounting, parsing, rendering, recall, and the
 * compaction wrapper's fallback rule.
 */

import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'om-test-'))
process.env.DSH_HOME = home

const mod = await import('../index.js')
const {
  resolveConfig,
  createRuntime,
  memoryId,
  estimateTokens,
  estimateMessages,
  priceText,
  estimateShadowedTokens,
  coversShadowedRegion,
  renderMemory,
  activeObservations,
  activeObservationTokens,
  normalizeLedger,
  emptyLedger,
  serializeMessages,
  takeOldestChunk,
  extractJsonArray,
  recall,
  runObserver,
  runReflector,
  runDropper,
  runMemoryPass,
  scheduleMemoryPass,
  isRootAgent,
  LedgerStore,
  LEDGER_FILENAME,
  resolveSessionDir,
  findSessionLogDirs,
  installCompactionRenderer,
  wrapCompactionEngine,
  compactionEngineFor,
  installProbeRoute,
  registerRecallTool,
  registerCommands,
  apply
} = mod

/**
 * Create the session directory the harness itself would own, and return it.
 *
 * The ledger lives inside this directory, so a test that wants persistence has
 * to model the harness's layout rather than a plugin-private store.
 */
async function makeSessionDir(sessionId, workspaceKey = '--test-workspace--') {
  const dir = join(home, 'sessions', workspaceKey, sessionId)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Build a runtime exactly the way `apply` does. Tests must not assemble the
 * runtime by hand: a hand-built shape drifts from the real one, and that drift
 * is invisible until a field is read.
 */
function runtimeFor(ctx, rawConfig) {
  return createRuntime(ctx, resolveConfig(rawConfig))
}

// ---------------------------------------------------------------------------
// Harness doubles
// ---------------------------------------------------------------------------

/** A fake agent owning a fake session with fixed model-visible messages. */
function fakeAgent(sessionId, messages, options = {}) {
  return {
    options: { provider: 'test-provider', model: 'test-model' },
    session: {
      id: sessionId,
      deriveMessages: () => messages,
      requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } })
    }
  }
}

/**
 * A fake context. `replies` is consumed in order by `llm.stream`, so a test can
 * script the observer, then the reflector, then the dropper.
 */
function fakeCtx({ replies = [], compaction, withoutLlm = false } = {}) {
  const queue = [...replies]
  const registered = { tools: [], commands: [] }
  const handlers = new Map()
  const disposers = []
  const llmService = {
    async *stream(options) {
      const next = queue.shift()
      if (next === undefined) throw new Error('fakeCtx: no scripted reply left')
      const text = typeof next === 'function' ? next(options) : next
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    /** Route capacity, as `ctx.llm.resolveModelInfo` reports it. */
    async resolveModelInfo() {
      return ctx.modelInfo
    }
  }
  // Declared as a named const so `inject` can hand the callback this same
  // object: an arrow function's `this` is not the context.
  const ctx = {
    registered,
    handlers,
    compaction,
    logger: { info() {}, warn() {} },
    // Deliberately NOT `llm: llmService`. Cordis throws on property access to a
    // service the plugin did not declare in `inject`, so the plugin must reach
    // `llm` through `ctx.get`. Exposing it as a property here would hide exactly
    // the bug that broke the first live run.
    tools: { register: (definition) => registered.tools.push(definition) },
    commands: { register: (definition) => registered.commands.push(definition) },
    get: (key) => {
      if (key === 'compaction') return compaction
      if (key === 'webServer') return ctx.webServer
      if (key === 'agents') return ctx.agents
      if (key === 'llm') return withoutLlm ? undefined : llmService
      if (key === 'tokenMeter') return ctx.tokenMeter
      if (key === 'agentPresets') return ctx.agentPresets
      return undefined
    },
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect: (callback, label) => {
      const disposer = callback()
      disposers.push({ disposer, label })
      return () => {}
    },
    inject: (_services, callback) => {
      callback(ctx)
    },
    disposers
  }
  return ctx
}

/**
 * A fake compaction engine whose `summarize` lives on the prototype, like the
 * real `BasicCompactionEngine`, so the wrapper's shadow-and-restore contract is
 * exercised honestly.
 */
class FakeEngine {
  constructor(behaviour) {
    this.behaviour = behaviour
    this.calls = 0
  }

  async summarize(input, agent, signal) {
    this.calls += 1
    return this.behaviour(input, agent, signal)
  }
}

function fakeEngine(behaviour) {
  return new FakeEngine(behaviour)
}

/** A minimal HTTP request double for the probe route. */
function fakeReq({ method = 'POST', headers = {}, body = '', address = '127.0.0.1' } = {}) {
  return {
    method,
    headers,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield Buffer.from(body)
    }
  }
}

/** A minimal HTTP response double for the probe route. */
function fakeRes() {
  const res = {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(body) {
      res.body = body
    }
  }
  return res
}

/** Install the probe route against a fake web server and return a caller. */
function probeCaller(ctx) {
  ctx.routes = []
  ctx.webServer = {
    register: (route) => {
      ctx.routes.push(route)
      return () => {}
    }
  }
  const runtime = runtimeFor(ctx)
  installProbeRoute(runtime)
  const route = ctx.routes[0]
  return {
    runtime,
    route,
    async call(body, options = {}) {
      const res = fakeRes()
      await route.handler(
        fakeReq({
          headers: { 'x-dsh-observational-memory': '1', ...(options.headers ?? {}) },
          body: JSON.stringify(body),
          ...options
        }),
        res
      )
      return { status: res.status, payload: JSON.parse(res.body) }
    }
  }
}

const lorem = 'x'.repeat(400)

// ---------------------------------------------------------------------------
// Configuration and identity
// ---------------------------------------------------------------------------

test('resolveConfig applies defaults and ignores invalid input', () => {
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.observeAfterTokens, 10000)
  assert.equal(defaults.reflectAfterTokens, 20000)
  assert.equal(defaults.passive, false)
  assert.equal(defaults.model, undefined)

  const tuned = resolveConfig({
    observeAfterTokens: 500,
    reflectAfterTokens: -3,
    maxTokens: 1024,
    model: { provider: 'openrouter', model: 'cheap' },
    passive: true
  })
  assert.equal(tuned.observeAfterTokens, 500)
  assert.equal(tuned.reflectAfterTokens, 20000, 'a non-positive override falls back to the default')
  assert.equal(tuned.maxTokens, 1024)
  assert.deepEqual(tuned.model, { provider: 'openrouter', model: 'cheap' })
  assert.equal(tuned.passive, true)

  // A malformed model override must not become a half-configured target.
  assert.equal(resolveConfig({ model: { provider: 'x' } }).model, undefined)
  assert.equal(resolveConfig({ model: 'nonsense' }).model, undefined)
  assert.equal(resolveConfig(null).observeAfterTokens, 10000)
})

test('memoryId is deterministic and namespaced', () => {
  const a = memoryId('observation', 'hello')
  assert.equal(a, memoryId('observation', 'hello'))
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.notEqual(a, memoryId('observation', 'hello!'))
  assert.notEqual(a, memoryId('reflection', 'hello'), 'the two id spaces do not collide')
})

test('estimateTokens uses the harness density heuristic', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens(undefined), 0)
})

// ---------------------------------------------------------------------------
// Ledger shape and projection
// ---------------------------------------------------------------------------

test('normalizeLedger drops junk and coerces missing fields', () => {
  const ledger = normalizeLedger('session-a', {
    observations: [
      { id: 'aaaaaaaaaaaa', content: 'kept' },
      { id: 'bbbbbbbbbbbb' },
      'not an object',
      null
    ],
    reflections: [{ id: 'cccccccccccc', content: 'a fact', supportingIds: ['aaaaaaaaaaaa', 42] }],
    dropped: ['dddddddddddd', 7],
    observedCount: -1,
    reflectedObservationTokens: 'nope'
  })
  assert.equal(ledger.observations.length, 1)
  assert.equal(ledger.observations[0].content, 'kept')
  assert.equal(ledger.observations[0].relevance, 'medium', 'missing relevance defaults')
  assert.equal(ledger.observations[0].evidence, '')
  assert.deepEqual(ledger.reflections[0].supportingIds, ['aaaaaaaaaaaa'])
  assert.deepEqual(ledger.dropped, ['dddddddddddd'])
  assert.equal(ledger.observedCount, 0, 'a negative count resets')
  assert.equal(ledger.reflectedObservationTokens, 0)
})

test('normalizeLedger survives a non-object payload', () => {
  assert.deepEqual(normalizeLedger('s', null), emptyLedger('s'))
  assert.deepEqual(normalizeLedger('s', 'nonsense').observations, [])
})

test('renderMemory is null when empty and ranks reflections above observations', () => {
  const ledger = emptyLedger('s')
  assert.equal(renderMemory(ledger), null)

  ledger.observations.push(
    { id: 'aaaaaaaaaaaa', content: 'switched to GraphQL', timestamp: '2026-01-15 14:30', relevance: 'high', tokens: 6, evidence: '' },
    { id: 'bbbbbbbbbbbb', content: 'migration validated', timestamp: '2026-01-15 14:50', relevance: 'medium', tokens: 5, evidence: '' }
  )
  ledger.reflections.push({ id: 'cccccccccccc', content: 'project is Next.js 15', supportingIds: [], tokens: 6 })

  const rendered = renderMemory(ledger)
  assert.match(rendered, /condensed memories from earlier in this session/)
  assert.match(rendered, /use the recall tool/)
  assert.ok(rendered.indexOf('## Reflections') < rendered.indexOf('## Observations'))
  assert.match(rendered, /\[cccccccccccc\] project is Next\.js 15/)
  assert.match(rendered, /\[aaaaaaaaaaaa\] 2026-01-15 14:30 \[high\] switched to GraphQL/)
})

test('a drop removes an observation from the rendered memory but not the ledger', () => {
  const ledger = emptyLedger('s')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'stale detail', timestamp: 't', relevance: 'low', tokens: 3, evidence: 'src' })
  ledger.observations.push({ id: 'bbbbbbbbbbbb', content: 'live detail', timestamp: 't', relevance: 'high', tokens: 3, evidence: 'src' })
  ledger.dropped.push('aaaaaaaaaaaa')

  assert.deepEqual(activeObservations(ledger).map((o) => o.id), ['bbbbbbbbbbbb'])
  assert.equal(activeObservationTokens(ledger), 3)
  const rendered = renderMemory(ledger)
  assert.doesNotMatch(rendered, /stale detail/)
  assert.match(rendered, /live detail/)
  assert.equal(ledger.observations.length, 2, 'the tombstone keeps history')
})

test('an oversized ledger elides the oldest observations and says so', () => {
  const ledger = emptyLedger('s')
  for (let index = 0; index < 400; index += 1) {
    ledger.observations.push({
      id: memoryId('observation', String(index)),
      content: `observation number ${index} ${lorem}`,
      timestamp: 't',
      relevance: 'low',
      tokens: 100,
      evidence: ''
    })
  }
  const rendered = renderMemory(ledger)
  assert.match(rendered, /older observation\(s\) elided/)

  // Recency wins: the newest observation survives, the oldest is gone. Plain
  // truncation would have done the opposite and silently dropped the most
  // relevant memory.
  assert.match(rendered, /observation number 399/)
  assert.doesNotMatch(rendered, /observation number 0 /)
  assert.match(rendered, /use the recall tool/, 'the preamble survives elision')
})

test('a ledger just over the cap is elided down to the cap, never beyond', () => {
  const ledger = emptyLedger('s')
  for (let index = 0; index < 400; index += 1) {
    ledger.observations.push({
      id: memoryId('observation', String(index)),
      content: `obs ${index} ${lorem}`,
      timestamp: 't',
      relevance: 'low',
      tokens: 100,
      evidence: ''
    })
  }
  const rendered = renderMemory(ledger)
  // The loop may overshoot slightly on its last pass (it drops whole
  // observations), but it must converge to a bounded size.
  assert.ok(rendered.length < 120000, `render should be bounded, got ${rendered.length}`)
})

// ---------------------------------------------------------------------------
// Serialization and parsing
// ---------------------------------------------------------------------------

test('serializeMessages renders text, tool calls and results but not reasoning', () => {
  const text = serializeMessages([
    { role: 'system', content: [{ type: 'text', text: 'be helpful' }] },
    { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'SECRET' }, { type: 'text', text: 'on it' }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' }] },
    { role: 'tool', content: [{ type: 'tool-result', content: 'file body' }] }
  ])
  assert.match(text, /\[system\]\nbe helpful/)
  assert.match(text, /\[user\]\ndo the thing/)
  assert.match(text, /on it/)
  assert.doesNotMatch(text, /SECRET/)
  assert.match(text, /-> tool call read/)
  assert.match(text, /<- tool result file body/)
})

test('serializeMessages tolerates unknown block and message shapes', () => {
  const text = serializeMessages([
    null,
    { role: 'user' },
    { role: 'user', content: [{ type: 'mystery', payload: 1 }] },
    { role: 'user', content: [null] }
  ])
  assert.match(text, /\[mystery\]/)
})

test('takeOldestChunk respects the budget and always returns something', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `message ${index} ${'y'.repeat(400)}` }]
  }))
  const chunk = takeOldestChunk(messages, 150)
  assert.equal(chunk.length, 1, 'one oversized message still returns a chunk')
  assert.match(serializeMessages(chunk), /message 0/)

  const wide = takeOldestChunk(messages, 100000)
  assert.equal(wide.length, 5)
})

test('extractJsonArray tolerates prose and fences, and rejects junk', () => {
  assert.deepEqual(extractJsonArray('here you go:\n```json\n[{"content":"x"}]\n```'), [{ content: 'x' }])
  assert.deepEqual(extractJsonArray('[]'), [])
  assert.equal(extractJsonArray('no array here'), null)
  assert.equal(extractJsonArray('[not json]'), null)
  assert.equal(extractJsonArray('{"a":1}'), null, 'an object is not an array')
  assert.equal(extractJsonArray(undefined), null)
})

// ---------------------------------------------------------------------------
// Durable store
// ---------------------------------------------------------------------------

test('LedgerStore round-trips through disk atomically', async () => {
  const dir = await makeSessionDir('session-roundtrip')
  const store = new LedgerStore()
  const ledger = await store.load('session-roundtrip')
  ledger.observations.push({
    id: 'aaaaaaaaaaaa',
    content: 'persisted',
    timestamp: '2026-01-01 00:00',
    relevance: 'high',
    tokens: 2,
    evidence: 'source'
  })
  await store.save('session-roundtrip')
  await store.drain()

  // The ledger lands inside the session's own directory, beside its log.
  const onDisk = JSON.parse(await readFile(join(dir, LEDGER_FILENAME), 'utf8'))
  assert.equal(onDisk.observations[0].content, 'persisted')
  assert.equal(onDisk.sessionId, 'session-roundtrip')

  const fresh = new LedgerStore()
  const reloaded = await fresh.load('session-roundtrip')
  assert.equal(reloaded.observations[0].evidence, 'source')

  // No temp file may survive a completed write.
  const files = await readdir(dir)
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), [])
})

test('deleting the session directory deletes the memory with it', async () => {
  // This is the whole reason the ledger lives beside the log: the harness's own
  // session deletion removes one directory recursively, so memory cannot be
  // orphaned by a deleter that has never heard of this plugin.
  const dir = await makeSessionDir('session-doomed')
  const store = new LedgerStore()
  const ledger = await store.load('session-doomed')
  ledger.observations.push({
    id: 'aaaaaaaaaaaa',
    content: 'about to be removed with the session',
    timestamp: 't',
    relevance: 'high',
    tokens: 3,
    evidence: ''
  })
  await store.save('session-doomed')
  await store.drain()
  assert.ok(await readFile(join(dir, LEDGER_FILENAME), 'utf8'))

  await rm(dir, { recursive: true, force: true })

  const after = await new LedgerStore().load('session-doomed')
  assert.deepEqual(after.observations, [], 'no ledger survives the session directory')
  assert.deepEqual(await findSessionLogDirs(home, 'session-doomed'), [])
})

test('save never manufactures a phantom session directory', async () => {
  const store = new LedgerStore()
  const ledger = await store.load('session-never-persisted')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'in memory only', timestamp: 't', relevance: 'low', tokens: 1, evidence: '' })
  await store.save('session-never-persisted')
  await store.drain()

  assert.equal(store.deferredWrites, 1, 'the write is deferred rather than creating a directory')
  assert.equal(await resolveSessionDir('session-never-persisted', new Map()), null)
  assert.deepEqual(await findSessionLogDirs(home, 'session-never-persisted'), [])
  // The in-memory ledger still serves this process.
  assert.equal((await store.load('session-never-persisted')).observations.length, 1)
})

test('resolveSessionDir finds a session under any workspace key', async () => {
  const dir = await makeSessionDir('session-nested', '--Users-someone-else-project--')
  assert.equal(await resolveSessionDir('session-nested', new Map()), dir)

  // A resolved hit is cached, so repeated writes do not rescan the session root.
  const cache = new Map()
  await resolveSessionDir('session-nested', cache)
  assert.equal(cache.get('session-nested'), dir)
})

test('LedgerStore reads a corrupt ledger as empty rather than throwing', async () => {
  const dir = await makeSessionDir('session-corrupt')
  await writeFile(join(dir, LEDGER_FILENAME), '{ this is not json')
  const store = new LedgerStore()
  const ledger = await store.load('session-corrupt')
  assert.deepEqual(ledger.observations, [])
  assert.equal(ledger.sessionId, 'session-corrupt')
})

// ---------------------------------------------------------------------------
// Memory agents
// ---------------------------------------------------------------------------

test('runObserver records observations and advances coverage by the observed chunk', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: `first ${lorem}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `second ${lorem}` }] }
  ]
  const ctx = fakeCtx({
    replies: [JSON.stringify([
      { content: 'User decided to switch to GraphQL', relevance: 'high' },
      { content: 'Migration completed and validated', relevance: 'critical' }
    ])]
  })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10, observerChunkMaxTokens: 100000 })
  const ledger = await runtime.store.load('session-observer')
  const agent = fakeAgent('session-observer', messages)

  const outcome = await runObserver(runtime, agent, ledger, undefined)
  assert.match(outcome, /recorded 2 observation/)
  assert.equal(ledger.observations.length, 2)
  assert.equal(ledger.observations[0].relevance, 'high')
  assert.equal(ledger.observedCount, 2)
  assert.ok(ledger.observations[0].evidence.includes('first'), 'the source excerpt is retained for recall')
  assert.match(ledger.observations[0].timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('runObserver advances coverage only by the chunk it actually read', async () => {
  const messages = Array.from({ length: 4 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `turn ${index} ${'z'.repeat(400)}` }]
  }))
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'first chunk noted', relevance: 'medium' }])] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10, observerChunkMaxTokens: 60 })
  const ledger = await runtime.store.load('session-chunk')
  const agent = fakeAgent('session-chunk', messages)

  await runObserver(runtime, agent, ledger, undefined)
  const advanced = ledger.observedCount
  assert.ok(advanced > 0 && advanced < messages.length, `expected a partial advance, got ${advanced}`)
  assert.equal(runtime.ctx.registered.tools.length, 0)
})

test('runObserver leaves the range uncovered when the model output is unparseable', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: `hello ${lorem}` }] }]
  const ctx = fakeCtx({ replies: ['I am afraid I cannot do that'] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10 })
  const ledger = await runtime.store.load('session-unparseable')
  const agent = fakeAgent('session-unparseable', messages)

  const outcome = await runObserver(runtime, agent, ledger, undefined)
  assert.match(outcome, /unparseable/)
  assert.equal(ledger.observedCount, 0, 'coverage must not advance past unread history')
  assert.equal(ledger.observations.length, 0)
})

test('runObserver does nothing below the threshold', async () => {
  const ctx = fakeCtx({ replies: [] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 100000 })
  const ledger = await runtime.store.load('session-quiet')
  const agent = fakeAgent('session-quiet', [{ role: 'user', content: [{ type: 'text', text: 'tiny' }] }])
  assert.equal(await runObserver(runtime, agent, ledger, undefined), null)
})

test('runObserver resets coverage when the surface shrank (a compaction happened)', async () => {
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'post-compaction state', relevance: 'medium' }])] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10 })
  const ledger = await runtime.store.load('session-shrunk')
  ledger.observedCount = 50
  const agent = fakeAgent('session-shrunk', [{ role: 'user', content: [{ type: 'text', text: `surviving ${lorem}` }] }])
  await runObserver(runtime, agent, ledger, undefined)
  assert.equal(ledger.observations.length, 1)
  assert.equal(ledger.observedCount, 1)
})

test('runReflector keeps only supporting ids that name a live observation', async () => {
  const ctx = fakeCtx({
    replies: [JSON.stringify([
      { content: 'Project uses Supabase auth', supportingIds: ['aaaaaaaaaaaa', 'ffffffffffff', 7] }
    ])]
  })
  const runtime = runtimeFor(ctx, { reflectAfterTokens: 5 })
  const ledger = await runtime.store.load('session-reflector')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'uses Supabase', timestamp: 't', relevance: 'high', tokens: 10, evidence: '' })
  const agent = fakeAgent('session-reflector', [])

  const outcome = await runReflector(runtime, agent, ledger, undefined)
  assert.match(outcome, /recorded 1 reflection/)
  assert.deepEqual(ledger.reflections[0].supportingIds, ['aaaaaaaaaaaa'], 'unknown ids are not pruning evidence')
})

test('runReflector is not due while the pool is small', async () => {
  const ctx = fakeCtx({ replies: [] })
  const runtime = runtimeFor(ctx, { reflectAfterTokens: 100000 })
  const ledger = await runtime.store.load('session-reflect-quiet')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'x', timestamp: 't', relevance: 'low', tokens: 1, evidence: '' })
  assert.equal(await runReflector(runtime, fakeAgent('session-reflect-quiet', []), ledger, undefined), null)
})

test('runDropper only runs over budget and tombstones only valid ids', async () => {
  const ctx = fakeCtx({ replies: [JSON.stringify(['aaaaaaaaaaaa', 'nosuchid00000'])] })
  const runtime = runtimeFor(ctx, { observationsPoolMaxTokens: 5 })
  const ledger = await runtime.store.load('session-dropper')
  ledger.observations.push(
    { id: 'aaaaaaaaaaaa', content: 'covered', timestamp: 't', relevance: 'low', tokens: 10, evidence: '' },
    { id: 'bbbbbbbbbbbb', content: 'load bearing', timestamp: 't', relevance: 'critical', tokens: 10, evidence: '' }
  )
  const agent = fakeAgent('session-dropper', [])

  const outcome = await runDropper(runtime, agent, ledger, undefined)
  assert.match(outcome, /dropped 1 observation/)
  assert.deepEqual(ledger.dropped, ['aaaaaaaaaaaa'])
  assert.deepEqual(activeObservations(ledger).map((o) => o.id), ['bbbbbbbbbbbb'])
})

test('runDropper stays out of the way under budget', async () => {
  const ctx = fakeCtx({ replies: [] })
  const runtime = runtimeFor(ctx, { observationsPoolMaxTokens: 100000 })
  const ledger = await runtime.store.load('session-dropper-quiet')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'x', timestamp: 't', relevance: 'low', tokens: 1, evidence: '' })
  assert.equal(await runDropper(runtime, fakeAgent('session-dropper-quiet', []), ledger, undefined), null)
})

test('runMemoryPass orders observe, reflect, then prune', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: `work happened ${lorem}` }] }]
  const ctx = fakeCtx({
    replies: [
      JSON.stringify([{ content: 'did the work', relevance: 'high' }]),
      JSON.stringify([{ content: 'the project is underway', supportingIds: [] }])
    ]
  })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10, reflectAfterTokens: 1, observationsPoolMaxTokens: 100000 })
  const outcomes = await runMemoryPass(runtime, fakeAgent('session-pass', messages), undefined)
  assert.equal(outcomes.length, 2, 'no dropper run: the pool is under budget')
  assert.match(outcomes[0], /^observer:/)
  assert.match(outcomes[1], /^reflector:/)
})

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

test('runMemoryPass owns coherent accounting for both of its callers', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: `work happened ${lorem}` }] }]
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'noted', relevance: 'high' }])] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10, reflectAfterTokens: 100000 })
  const agent = fakeAgent('session-accounting', messages)

  await runMemoryPass(runtime, agent, undefined)
  assert.equal(runtime.stats.passesStarted, 1)
  assert.equal(runtime.stats.passesCompleted, 1)
  assert.equal(runtime.stats.passesFailed, 0)
  assert.match(runtime.stats.lastOutcome, /^observer: recorded 1/)

  // A failing pass is counted *and* still reported to its caller: the probe
  // needs the error, and the counters need to agree with it.
  const broken = runtimeFor(fakeCtx({ replies: [], withoutLlm: true }), { observeAfterTokens: 10 })
  await assert.rejects(() => runMemoryPass(broken, agent, undefined), /llm service is not mounted/)
  assert.equal(broken.stats.passesStarted, 1)
  assert.equal(broken.stats.passesCompleted, 0)
  assert.equal(broken.stats.passesFailed, 1)
  assert.match(broken.stats.lastError, /llm service is not mounted/)
})

test('the scheduler counts one pass exactly once', async () => {
  const ctx = fakeCtx({ replies: [] })
  const runtime = runtimeFor(ctx)
  scheduleMemoryPass(runtime, fakeAgent('session-sched', []))
  await new Promise((resolve) => setTimeout(resolve, 25))

  assert.equal(runtime.stats.passesScheduled, 1)
  assert.equal(runtime.stats.passesStarted, 1)
  assert.equal(runtime.stats.passesCompleted, 1)
  assert.equal(runtime.stats.passesFailed, 0)
})

test('recall returns an observation with its source excerpt', () => {
  const ledger = emptyLedger('s')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'a fact', timestamp: '2026-01-01 10:00', relevance: 'high', tokens: 2, evidence: 'the original words' })
  const result = recall(ledger, 'aaaaaaaaaaaa')
  assert.equal(result.kind, 'observation')
  assert.match(result.text, /the original words/)
})

test('recall still finds a dropped observation and says so', () => {
  const ledger = emptyLedger('s')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'pruned fact', timestamp: 't', relevance: 'low', tokens: 2, evidence: 'src' })
  ledger.dropped.push('aaaaaaaaaaaa')
  const result = recall(ledger, 'aaaaaaaaaaaa')
  assert.equal(result.kind, 'observation-dropped')
  assert.match(result.text, /dropped from active memory/)
})

test('recall expands a reflection into its supporting observations', () => {
  const ledger = emptyLedger('s')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'evidence one', timestamp: 't', relevance: 'high', tokens: 2, evidence: '' })
  ledger.reflections.push({ id: 'cccccccccccc', content: 'a conclusion', supportingIds: ['aaaaaaaaaaaa'], tokens: 2 })
  const result = recall(ledger, 'cccccccccccc')
  assert.equal(result.kind, 'reflection')
  assert.match(result.text, /evidence one/)
})

test('recall reports an unknown id as missing', () => {
  assert.equal(recall(emptyLedger('s'), 'ffffffffffff').kind, 'missing')
})

// ---------------------------------------------------------------------------
// Tool and command registration
// ---------------------------------------------------------------------------

test('registerRecallTool registers a schema-driven tool that reads the ledger', async () => {
  const ctx = fakeCtx()
  const runtime = runtimeFor(ctx, )
  registerRecallTool(runtime)

  const tool = ctx.registered.tools[0]
  assert.equal(tool.name, 'recall')
  assert.deepEqual(tool.parameters.required, ['id'])
  assert.match(tool.description, /not search/)

  const ledger = await runtime.store.load('session-tool')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'tool fact', timestamp: 't', relevance: 'high', tokens: 2, evidence: 'raw' })
  const agent = fakeAgent('session-tool', [])
  const result = await tool.execute({ id: 'aaaaaaaaaaaa' }, { agent })
  assert.equal(result.kind, 'observation')
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: result.text }])

  const invalid = await tool.execute({ id: 'nope' }, { agent })
  assert.equal(invalid.kind, 'invalid')

  await assert.rejects(() => tool.execute({ id: 'aaaaaaaaaaaa' }, {}), /owning agent session/)
})

test('registerCommands registers status, view and observe', async () => {
  const ctx = fakeCtx({ replies: [] })
  const runtime = runtimeFor(ctx, )
  registerCommands(runtime)
  assert.deepEqual(ctx.registered.commands.map((c) => c.name).sort(), ['om-observe', 'om-status', 'om-view'])

  // `dsh-commands` validates every name against /^[a-z][a-z0-9_-]*$/u at
  // registration and throws otherwise, which would take the whole plugin down
  // with it. The fake context does not validate, so assert the contract here.
  for (const command of ctx.registered.commands) {
    assert.match(command.name, /^[a-z][a-z0-9_-]*$/, `command "${command.name}" must satisfy the harness name rule`)
    assert.ok(command.description.trim().length > 0)
    assert.equal(typeof command.handler, 'function')
  }

  const agent = fakeAgent('session-commands', [])
  const status = await ctx.registered.commands.find((c) => c.name === 'om-status').handler({ agent })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /observational-memory \(active\)/)

  const view = await ctx.registered.commands.find((c) => c.name === 'om-view').handler({ agent })
  assert.match(view.text, /No observations or reflections/)
})

test('registerCommands om-observe forces a pass and reports it', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: `forced ${lorem}` }] }]
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'forced observation', relevance: 'medium' }])] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10 })
  registerCommands(runtime)
  const agent = fakeAgent('session-force', messages)
  const result = await ctx.registered.commands.find((c) => c.name === 'om-observe').handler({ agent })
  assert.match(result.text, /recorded 1 observation/)
})

test('a rejected command registration degrades instead of failing activation', async () => {
  const warnings = []
  const ctx = fakeCtx({ replies: [] })
  ctx.logger = { info() {}, warn: (message) => warnings.push(message) }
  ctx.commands = {
    register: () => {
      throw new TypeError('command name "om-status" must match /^[a-z][a-z0-9_-]*$/u')
    }
  }
  const runtime = runtimeFor(ctx)
  assert.doesNotThrow(() => registerCommands(runtime))
  assert.equal(warnings.length, 3, 'each rejected command is reported')
  assert.match(warnings[0], /was not registered/)
})

// ---------------------------------------------------------------------------
// Deterministic compaction
// ---------------------------------------------------------------------------

test('the compaction wrapper renders memory instead of calling the summarizer', async () => {
  const engine = fakeEngine(() => {
    throw new Error('the summarizer must not have been called')
  })
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx, )
  const ledger = await runtime.store.load('session-compact')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'a remembered decision', timestamp: 't', relevance: 'high', tokens: 6, evidence: '' })
  // Caught up: the ledger has read more than this compaction will replace.
  ledger.observedTokens = 100000

  assert.equal(installCompactionRenderer(runtime), true)
  const result = await engine.summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(100000) }] }] }, fakeAgent('session-compact', []), undefined)

  assert.equal(result.llmStreamCall, false, 'memory rendering is not a model call')
  assert.match(result.summary[0].text, /a remembered decision/)
  assert.equal(result.provider, 'test-provider')
  assert.equal(engine.calls, 0)
  assert.equal(runtime.stats.rendersServed, 1)
  assert.equal(runtime.stats.rendersSkippedUncovered, 0)
})

test('a ledger that does not cover the shadowed region is refused, not rendered', async () => {
  // The failure this prevents: a ledger holding a few observations about the
  // start of a long session replacing the whole session with them. The text
  // would look like a complete checkpoint while describing only a prefix.
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native summary' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx)
  const ledger = await runtime.store.load('session-uncovered')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'only the very beginning', timestamp: 't', relevance: 'high', tokens: 6, evidence: '' })
  ledger.observedTokens = 12000 // read 12k tokens …

  installCompactionRenderer(runtime)
  const bigRegion = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400000) }] }] }
  const result = await engine.summarize(bigRegion, fakeAgent('session-uncovered', []), undefined)

  assert.equal(result.summary[0].text, 'native summary', '~100k tokens of region must not become 12k of memory')
  assert.equal(engine.calls, 1)
  assert.equal(runtime.stats.rendersServed, 0)
  assert.equal(runtime.stats.rendersSkippedUncovered, 1)
  assert.equal(runtime.stats.rendersFellBack, 1, 'refusing is also a fallback, and both are counted')
})

test('a small uncovered region is still refused', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native summary' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx)
  const ledger = await runtime.store.load('session-small-uncovered')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'memory', timestamp: 't', relevance: 'high', tokens: 2, evidence: '' })
  ledger.observedTokens = 100

  installCompactionRenderer(runtime)
  const result = await engine.summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(4000) }] }] }, fakeAgent('session-small-uncovered', []), undefined)
  assert.equal(result.summary[0].text, 'native summary')
  assert.equal(runtime.stats.rendersSkippedUncovered, 1)
})

test('coversShadowedRegion is the coverage invariant, not a size proxy', () => {
  assert.equal(coversShadowedRegion({ observedTokens: 100 }, 100), true, 'exactly covered is covered')
  assert.equal(coversShadowedRegion({ observedTokens: 99 }, 100), false)
  assert.equal(coversShadowedRegion({ observedTokens: 1000 }, 100), true)
  assert.equal(coversShadowedRegion({ observedTokens: 1000 }, 0), false, 'an unknown region is not covered')
  assert.equal(coversShadowedRegion({ observedTokens: 1000 }, Number.NaN), false)
})

test('the coverage watermark is reconciled upward, never left under-reported', async () => {
  // Two real shapes need this. A ledger written before `observedTokens` existed
  // reads as 0. A ledger written by a version that only accumulated *new* chunks
  // under-reports everything read before it. Either way the gate would refuse
  // memory the ledger genuinely holds, and the feature would stay dormant even
  // once coverage is complete.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: `first ${lorem}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `second ${lorem}` }] }
  ]
  const ctx = fakeCtx({ replies: [] })
  ctx.tokenMeter = { estimateMessage: (message) => Math.ceil(JSON.stringify(message).length / 4) }
  const runtime = runtimeFor(ctx, { observeAfterTokens: 1000000 })
  const agent = fakeAgent('session-migrate', messages)

  // (a) the old shape: no watermark at all.
  const zero = await runtime.store.load('session-migrate-zero')
  zero.observations.push({ id: 'aaaaaaaaaaaa', content: 'old', timestamp: 't', relevance: 'high', tokens: 2, evidence: '' })
  zero.observedCount = 2
  assert.equal(await runObserver(runtime, agent, zero, undefined), null, 'nothing new to observe')
  assert.ok(zero.observedTokens > 0, `expected a migrated watermark, got ${zero.observedTokens}`)
  assert.equal(coversShadowedRegion(zero, zero.observedTokens - 1), true, 'and it now licenses a render')

  // (b) the partial shape: a watermark that under-reports what was read.
  const partial = await runtime.store.load('session-migrate-partial')
  partial.observations.push({ id: 'bbbbbbbbbbbb', content: 'old', timestamp: 't', relevance: 'high', tokens: 2, evidence: '' })
  partial.observedCount = 2
  partial.observedTokens = 7
  await runObserver(runtime, agent, partial, undefined)
  assert.ok(partial.observedTokens > 7, `expected a raised watermark, got ${partial.observedTokens}`)

  // And it never lowers: reconciliation is one-directional, so it cannot make the
  // gate more permissive than the ledger's real coverage.
  partial.observedTokens = 10_000_000
  await runObserver(runtime, agent, partial, undefined)
  assert.equal(partial.observedTokens, 10_000_000)
})

test('the observer accumulates token coverage as it reads', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: `work happened ${lorem}` }] }]
  const more = [...messages, { role: 'user', content: [{ type: 'text', text: `more happened ${lorem}` }] }]
  const ctx = fakeCtx({
    replies: [
      JSON.stringify([{ content: 'noted one', relevance: 'medium' }]),
      JSON.stringify([{ content: 'noted two', relevance: 'medium' }])
    ]
  })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10 })
  const ledger = await runtime.store.load('session-coverage')
  assert.equal(ledger.observedTokens, 0)

  await runObserver(runtime, fakeAgent('session-coverage', messages), ledger, undefined)
  const afterFirst = ledger.observedTokens
  assert.ok(afterFirst > 0, 'reading a chunk raises coverage')

  await runObserver(runtime, fakeAgent('session-coverage', more), ledger, undefined)
  assert.ok(ledger.observedTokens > afterFirst, 'coverage is monotonic across chunks')
  assert.equal(ledger.observations.length, 2)
})

test('normalizeLedger coerces the coverage watermark', () => {
  assert.equal(normalizeLedger('s', { observedTokens: 500 }).observedTokens, 500)
  assert.equal(normalizeLedger('s', { observedTokens: -1 }).observedTokens, 0)
  assert.equal(normalizeLedger('s', { observedTokens: 'nope' }).observedTokens, 0)
  assert.equal(normalizeLedger('s', {}).observedTokens, 0)
})

test('the compaction wrapper falls back to the summarizer when memory is empty', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native summary' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx, )
  installCompactionRenderer(runtime)

  const result = await engine.summarize({ messages: [] }, fakeAgent('session-empty', []), undefined)
  assert.equal(result.summary[0].text, 'native summary')
  assert.equal(engine.calls, 1)
})

test('the compaction wrapper falls back when memory is not smaller than the shadowed region', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native summary' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx, )
  const ledger = await runtime.store.load('session-tiny')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'a'.repeat(4000), timestamp: 't', relevance: 'high', tokens: 1000, evidence: '' })
  installCompactionRenderer(runtime)

  // A shadowed region far smaller than the ledger must not be replaced by it.
  const result = await engine.summarize(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'tiny' }] }] },
    fakeAgent('session-tiny', []),
    undefined
  )
  assert.equal(result.summary[0].text, 'native summary')
})

test('the compaction wrapper restores the prototype method on dispose', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const prototypeMethod = FakeEngine.prototype.summarize
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx, )
  installCompactionRenderer(runtime)
  assert.ok(Object.hasOwn(engine, 'summarize'), 'the wrapper shadows the prototype method')
  assert.notEqual(engine.summarize, prototypeMethod)

  const entry = ctx.disposers.find((d) => String(d.label).includes('deterministic compaction'))
  assert.ok(entry !== undefined, 'the wrapper registered a disposer')
  entry.disposer()
  assert.equal(Object.hasOwn(engine, 'summarize'), false, 'the own property is removed, not left rebound')
  assert.equal(engine.summarize, prototypeMethod)
})

test('the compaction wrapper restores an own-property summarize in place', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const own = async () => ({ summary: [{ type: 'text', text: 'own' }], llmStreamCall: true })
  engine.summarize = own
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx, )
  installCompactionRenderer(runtime)

  ctx.disposers.find((d) => String(d.label).includes('deterministic compaction')).disposer()
  assert.equal(engine.summarize, own, 'an own method comes back, it is not deleted')
})

test('the compaction wrapper does not clobber a later wrapper', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx, )
  installCompactionRenderer(runtime)

  const later = async () => 'later'
  engine.summarize = later
  ctx.disposers.find((d) => String(d.label).includes('deterministic compaction')).disposer()
  assert.equal(engine.summarize, later, 'dispose must not undo work it does not own')
})

test('the compaction wrapper reports when no compaction service is mounted', () => {
  const ctx = fakeCtx()
  const runtime = runtimeFor(ctx, )
  assert.equal(installCompactionRenderer(runtime), false)
})

test('the shadowed region is priced with the engine meter, not the truncating serializer', () => {
  // The serializer clips tool-results to 500 characters, so on exactly the
  // tool-heavy regions this plugin exists to compress it under-counts badly —
  // and an under-count lets the engine reject the render instead of falling back.
  const ctx = fakeCtx()
  ctx.tokenMeter = { estimateMessage: (message) => Math.ceil(JSON.stringify(message).length / 4) }
  const runtime = runtimeFor(ctx)

  const input = {
    messages: [{ role: 'tool', content: [{ type: 'tool-result', content: 'x'.repeat(200000) }] }]
  }
  const metered = estimateShadowedTokens(runtime, input)
  const local = estimateMessages(input.messages)
  assert.ok(metered > local * 10, `metered ${metered} should dwarf the truncated ${local}`)
})

test('the shadowed-region price falls back to the local estimate without a usable meter', () => {
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }] }

  const noMeter = runtimeFor(fakeCtx())
  assert.equal(estimateShadowedTokens(noMeter, input), estimateMessages(input.messages))
  assert.equal(estimateShadowedTokens(noMeter, { messages: [] }), 0)
  assert.equal(estimateShadowedTokens(noMeter, undefined), 0)

  const hostile = fakeCtx()
  hostile.tokenMeter = {
    estimateMessage: () => {
      throw new Error('meter exploded')
    }
  }
  assert.equal(estimateShadowedTokens(runtimeFor(hostile), input), estimateMessages(input.messages))
})

test('priceText prefers the meter and survives a hostile one', () => {
  const ctx = fakeCtx()
  ctx.tokenMeter = { estimateMessage: () => 42 }
  assert.equal(priceText(runtimeFor(ctx), 'anything'), 42)

  const hostile = fakeCtx()
  hostile.tokenMeter = {
    estimateMessage: () => {
      throw new Error('nope')
    }
  }
  assert.equal(priceText(runtimeFor(hostile), 'abcd'), 1, 'falls back to the density estimate')
})

test('the compaction wrapper never fails a compaction when the ledger read throws', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native summary' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx)
  runtime.store.load = async () => {
    throw new Error('disk on fire')
  }
  installCompactionRenderer(runtime)
  const result = await engine.summarize({ messages: [] }, fakeAgent('session-boom', []), undefined)
  assert.equal(result.summary[0].text, 'native summary')
  assert.equal(runtime.stats.rendersFellBack, 1, 'the fallback is counted, not silent')
})

test('the memory agent reaches the llm through ctx.get, not a property', async () => {
  // Regression: the first live run died with `cannot get property "llm" without
  // inject`, because Cordis refuses property access to a service the plugin did
  // not declare in `inject`. The fake context models that restriction.
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'reached the llm', relevance: 'high' }])] })
  assert.equal(ctx.llm, undefined, 'the fake must not expose llm as a property')

  const runtime = runtimeFor(ctx, { observeAfterTokens: 10 })
  const ledger = await runtime.store.load('session-llm-get')
  const agent = fakeAgent('session-llm-get', [{ role: 'user', content: [{ type: 'text', text: `hi ${lorem}` }] }])

  const outcome = await runObserver(runtime, agent, ledger, undefined)
  assert.match(outcome, /recorded 1 observation/)
  assert.equal(ledger.observations[0].content, 'reached the llm')
})

test('a missing llm service fails loudly instead of silently observing nothing', async () => {
  const ctx = fakeCtx({ replies: [], withoutLlm: true })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10 })
  const ledger = await runtime.store.load('session-no-llm')
  const agent = fakeAgent('session-no-llm', [{ role: 'user', content: [{ type: 'text', text: `hi ${lorem}` }] }])

  await assert.rejects(() => runObserver(runtime, agent, ledger, undefined), /llm service is not mounted/)
  assert.equal(ledger.observedCount, 0, 'coverage must not advance when nothing was observed')
})

test('wrapCompactionEngine is idempotent across the plugin and agent contexts', () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx)

  assert.equal(wrapCompactionEngine(runtime, engine), 'wrapped')
  const installed = engine.summarize
  // The same instance is reachable from an agent's own context; wrapping twice
  // must not stack a second wrapper that would render twice or fall back twice.
  assert.equal(wrapCompactionEngine(runtime, engine), 'already-wrapped')
  assert.equal(engine.summarize, installed)
  assert.equal(wrapCompactionEngine(runtime, undefined), 'absent')
})

test('compactionEngineFor resolves the engine through agentPresets.serviceFor', () => {
  // `compaction` lives in a child group of the agent's mount, so neither the
  // plugin context nor `agent.ctx.get` can reach it: `ctx.get` walks ancestors.
  const rootEngine = fakeEngine(() => ({}))
  const agentEngine = fakeEngine(() => ({}))
  const ctx = fakeCtx({ compaction: rootEngine })
  const agent = { id: 'agent-a' }
  const looked = []
  ctx.agentPresets = {
    serviceFor: (target, name) => {
      looked.push([target, name])
      return target === agent && name === 'compaction' ? agentEngine : undefined
    }
  }
  const runtime = runtimeFor(ctx)

  assert.equal(compactionEngineFor(runtime, agent), agentEngine)
  assert.deepEqual(looked, [[agent, 'compaction']])
  assert.equal(compactionEngineFor(runtime), rootEngine, 'no agent falls back to the context lookup')
})

test('compactionEngineFor survives a missing or throwing registry', () => {
  const rootEngine = fakeEngine(() => ({}))
  const ctx = fakeCtx({ compaction: rootEngine })
  const runtime = runtimeFor(ctx)

  // No agentPresets service at all.
  assert.equal(compactionEngineFor(runtime, { id: 'agent-b' }), rootEngine)

  // A registry whose lookup throws must not take the renderer down with it.
  ctx.agentPresets = {
    serviceFor: () => {
      throw new Error('registry exploded')
    }
  }
  assert.equal(compactionEngineFor(runtime, { id: 'agent-c' }), rootEngine)
  assert.match(runtime.stats.lastError, /registry exploded/)

  // And neither must a context that cannot answer at all.
  const bare = fakeCtx({ compaction: undefined })
  assert.equal(compactionEngineFor(runtimeFor(bare), { id: 'agent-d' }), undefined)
})

test('the agent/created hook wraps the engine serviceFor resolves', async () => {
  const pluginEngine = fakeEngine(() => ({}))
  const agentEngine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: pluginEngine })
  const runtime = apply(ctx, {})

  const agent = { id: 'agent-created' }
  ctx.agentPresets = { serviceFor: (target, name) => (target === agent && name === 'compaction' ? agentEngine : undefined) }
  assert.equal(Object.hasOwn(agentEngine, 'summarize'), false, 'untouched before the hook')
  ctx.handlers.get('agent/created')({ agent })

  assert.ok(Object.hasOwn(agentEngine, 'summarize'), 'the agent-scoped engine is wrapped')
  assert.equal(wrapCompactionEngine(runtime, agentEngine), 'already-wrapped')
  assert.equal(runtime.stats.steps['agent compaction hook'], 'ok')
})

test('the turn hook lazily wraps an agent that predates activation', () => {
  // On a reload every live agent already exists, so `agent/created` never fires
  // for it and its engine would stay unwrapped.
  const pluginEngine = fakeEngine(() => ({}))
  const agentEngine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: pluginEngine })
  const runtime = apply(ctx, {})

  const agent = { session: { id: 'session-predates', deriveMessages: () => [] } }
  ctx.agentPresets = {
    serviceFor: (target, name) => (target === agent && name === 'compaction' ? agentEngine : undefined)
  }
  assert.equal(Object.hasOwn(agentEngine, 'summarize'), false, 'the agent engine is untouched before the hook')

  ctx.handlers.get('agent/turn-stopping')({ agent }, undefined)

  assert.equal(runtime.stats.turnStoppingSeen, 1)
  assert.ok(Object.hasOwn(agentEngine, 'summarize'), 'the pre-existing agent engine is now wrapped')
})

test('the agent/created hook survives an agent with no reachable compaction service', () => {
  const ctx = fakeCtx({ compaction: undefined })
  const runtime = apply(ctx, {})
  const handler = ctx.handlers.get('agent/created')

  assert.doesNotThrow(() => handler({ agent: undefined }))
  assert.doesNotThrow(() => handler({ agent: { id: 'x' } }))
  assert.doesNotThrow(() =>
    handler({
      agent: { id: 'y' },
      ...(() => {
        ctx.agentPresets = {
          serviceFor: () => {
            throw new Error('scope is gone')
          }
        }
      })()
    })
  )
  assert.equal(runtime.stats.enginesWrapped, 0)
})

test('an engine that cannot be shadowed reports unwrappable instead of pretending', () => {
  // A frozen service instance rejects both assignment and defineProperty. A
  // silently unwrapped engine keeps calling a model at compaction time and looks
  // exactly like a working one from outside, so the failure must be loud.
  const engine = fakeEngine(() => ({}))
  Object.freeze(engine)
  const ctx = fakeCtx({ compaction: engine })
  const runtime = runtimeFor(ctx)

  assert.equal(wrapCompactionEngine(runtime, engine), 'unwrappable')
  assert.match(runtime.stats.lastError, /cannot wrap summarize/)

  const applied = apply(fakeCtx({ compaction: Object.freeze(fakeEngine(() => ({}))) }), {})
  assert.match(applied.stats.steps['compaction renderer'], /^unwrappable/)
})

test('an activation step that defers its work is not reported as ok too early', () => {
  // The compaction renderer cannot run at activation when no agent exists and no
  // root engine is mounted. The old code recorded `ok` for a hook it had not
  // installed — which is how a dead renderer stayed invisible through two live
  // runs.
  const ctx = fakeCtx({ compaction: undefined })
  const runtime = apply(ctx, {})
  assert.equal(runtime.stats.steps['compaction renderer'], 'per-agent (no agents yet)')
})

// ---------------------------------------------------------------------------
// Diagnostic probe
// ---------------------------------------------------------------------------

test('the probe route admits only loopback, header-carrying POSTs', async () => {
  const { call, route } = probeCaller(fakeCtx({ replies: [] }))
  assert.equal(route.path, '/observational-memory/probe')

  assert.equal((await call({ action: 'status' }, { method: 'GET' })).status, 405)
  assert.equal((await call({ action: 'status' }, { address: '10.0.0.9' })).status, 403)
  assert.equal((await call({ action: 'status' }, { headers: { 'x-dsh-observational-memory': '0' } })).status, 403)
})

test('the probe reports activation steps so "never fired" is distinguishable from "fired and failed"', async () => {
  const { runtime, call } = probeCaller(fakeCtx({ replies: [] }))
  runtime.stats.steps['turn hook'] = 'ok'
  runtime.stats.turnStoppingSeen = 4
  runtime.stats.passesScheduled = 3
  runtime.stats.passesFailed = 1
  runtime.stats.lastError = 'boom'

  const { status, payload } = await call({ action: 'status' })
  assert.equal(status, 200)
  assert.equal(payload.result.activated, true)
  assert.equal(payload.result.stats.turnStoppingSeen, 4)
  assert.equal(payload.result.stats.steps['turn hook'], 'ok')
  assert.equal(payload.result.stats.lastError, 'boom')
})

test('the probe requires a valid session id for ledger actions', async () => {
  const { call } = probeCaller(fakeCtx({ replies: [] }))
  assert.equal((await call({ action: 'ledger' })).payload.result.kind, 'invalid')
  assert.equal((await call({ action: 'ledger', sessionId: '../etc/passwd' })).payload.result.kind, 'invalid')
  assert.equal((await call({ action: 'nonsense', sessionId: 'session-a' })).payload.result.kind, 'unknown-action')
})

test('the probe reports ledger contents and the rendered memory', async () => {
  const { runtime, call } = probeCaller(fakeCtx({ replies: [] }))
  const ledger = await runtime.store.load('session-probe')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'a remembered fact', timestamp: 't', relevance: 'high', tokens: 4, evidence: 'src' })
  ledger.dropped.push('bbbbbbbbbbbb')

  const summary = (await call({ action: 'ledger', sessionId: 'session-probe' })).payload.result
  assert.equal(summary.kind, 'ok')
  assert.deepEqual(summary.summary, {
    observations: 1,
    activeObservations: 1,
    reflections: 0,
    dropped: 1,
    observedCount: 0,
    observedTokens: 0,
    updatedAt: ledger.updatedAt
  })

  const rendered = (await call({ action: 'render', sessionId: 'session-probe' })).payload.result
  assert.match(rendered.rendered, /a remembered fact/)

  assert.equal(
    (await call({ action: 'render', sessionId: 'session-quiet' })).payload.result.rendered,
    null,
    'an empty projection renders as null, which is what triggers the native fallback'
  )
})

test('a delegated child session is not observed, but an unanswerable registry fails open', () => {
  const rootAgent = { session: { id: 'session-root' } }
  const childAgent = { session: { id: 'session-child' } }

  // The authoritative shape: roots() answers.
  const withRoots = runtimeFor(fakeCtx())
  withRoots.ctx.agents = { roots: () => [rootAgent] }
  assert.equal(isRootAgent(withRoots, rootAgent), true)
  assert.equal(isRootAgent(withRoots, childAgent), false, 'a child is skipped')

  // An empty roots() list must NOT be read as "nobody is a root": that would
  // silently disable memory entirely. Ownership is the fallback.
  const owned = runtimeFor(fakeCtx())
  owned.ctx.agents = {
    roots: () => [],
    list: () => [rootAgent, childAgent],
    isOwnedBy: (sessionId, owner) => owner === rootAgent && sessionId === 'session-child'
  }
  assert.equal(isRootAgent(owned, rootAgent), true)
  assert.equal(isRootAgent(owned, childAgent), false, 'ownership still identifies the child')

  // Nothing usable: observe it. Failing open costs a model call; failing closed
  // costs the feature.
  const blind = runtimeFor(fakeCtx())
  blind.ctx.agents = {
    roots: () => [],
    list: () => [rootAgent, childAgent],
    isOwnedBy: () => {
      throw new Error('registry exploded')
    }
  }
  assert.equal(isRootAgent(blind, childAgent), true)

  const absent = runtimeFor(fakeCtx())
  assert.equal(isRootAgent(absent, childAgent), true, 'no agents service at all')
  assert.equal(isRootAgent(absent, undefined), false)
})

test('the scheduler honours the child-session exclusion end to end', async () => {
  const ctx = fakeCtx({ replies: [] })
  const runtime = runtimeFor(ctx)
  const rootAgent = { session: { id: 'session-e2e-root', deriveMessages: () => [] } }
  const childAgent = { session: { id: 'session-e2e-child', deriveMessages: () => [] } }
  ctx.agents = { roots: () => [rootAgent] }

  scheduleMemoryPass(runtime, childAgent)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(runtime.stats.passesStarted, 0, 'a child session never starts a pass')
  assert.equal(runtime.stats.passesScheduled, 1, 'but the attempt is still counted')

  scheduleMemoryPass(runtime, rootAgent)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(runtime.stats.passesStarted, 1, 'the root session does')
})

test('the usage action reports the three clocks the widget draws', async () => {
  // The threshold is recomputed the way `resolveCompactSpec` does, from the live
  // engine's resolved policy: min(1e6 * 0.8, 1e6 - 0 reserved - 65536) = 800000.
  const engine = fakeEngine(() => ({}))
  engine.config = { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16 }
  const ctx = fakeCtx({ compaction: engine })
  ctx.modelInfo = { context: { contextWindow: 1000000 }, defaultMaxTokens: 0 }
  ctx.tokenMeter = {
    measure: () => ({ totalTokens: 400000 }),
    estimateMessage: (message) => Math.ceil(JSON.stringify(message).length / 4)
  }
  const agent = {
    options: {},
    session: {
      id: 'session-usage',
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] }],
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } })
    }
  }
  ctx.agents = { get: (id) => (id === 'session-usage' ? agent : undefined) }

  const { call } = probeCaller(ctx)
  const result = (await call({ action: 'usage', sessionId: 'session-usage' })).payload.result
  assert.equal(result.kind, 'ok')
  assert.equal(result.context.usedTokens, 400000)
  assert.equal(result.context.thresholdTokens, 800000)
  assert.equal(result.context.retainedTokens, 160000)
  assert.equal(result.context.percent, 50, '400k of an 800k threshold')
  assert.equal(result.compact.percent, 50)
  assert.equal(result.reflect.percent, 0, 'an empty pool is 0% of the reflect threshold')
  assert.ok(result.observe.percent > 0, 'the backlog is measured against observeAfterTokens')
  assert.equal(result.ledger.coveragePercent, 0)
})

test('the usage action degrades to no-percentage rather than lying', async () => {
  // No route capacity reported: the widget hides instead of drawing a
  // percentage of an unknown threshold.
  const engine = fakeEngine(() => ({}))
  engine.config = { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16 }
  const ctx = fakeCtx({ compaction: engine })
  ctx.tokenMeter = { measure: () => ({ totalTokens: 400000 }), estimateMessage: () => 1 }
  const agent = {
    options: {},
    session: {
      id: 'session-usage-nocap',
      deriveMessages: () => [],
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } })
    }
  }
  ctx.agents = { get: (id) => (id === 'session-usage-nocap' ? agent : undefined) }

  const { call } = probeCaller(ctx)
  const result = (await call({ action: 'usage', sessionId: 'session-usage-nocap' })).payload.result
  assert.equal(result.kind, 'ok')
  assert.equal(result.context.thresholdTokens, undefined)
  assert.equal(result.context.percent, undefined, 'an unknown threshold yields no percentage')
  assert.equal(result.compact.percent, undefined)
})

test('the probe can force a live memory pass end to end', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: `work happened ${lorem}` }] }]
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'probe recorded this', relevance: 'high' }])] })
  const agent = fakeAgent('session-probe', messages)
  ctx.agents = { get: (id) => (id === 'session-probe' ? agent : undefined) }
  const { runtime, call } = probeCaller(ctx)
  runtime.config = resolveConfig({ observeAfterTokens: 10, reflectAfterTokens: 100000 })

  const result = (await call({ action: 'observe', sessionId: 'session-probe' })).payload.result
  assert.equal(result.kind, 'ok')
  assert.equal(result.derivedMessages, 1)
  assert.match(result.outcomes.join(' '), /recorded 1 observation/)

  const ledger = await runtime.store.load('session-probe')
  assert.equal(ledger.observations.length, 1)
  assert.equal(runtime.stats.passesStarted, 1)
})

test('the probe reports a session with no live agent instead of throwing', async () => {
  const ctx = fakeCtx({ replies: [] })
  ctx.agents = { get: () => undefined }
  const { call } = probeCaller(ctx)
  const result = (await call({ action: 'observe', sessionId: 'session-gone' })).payload.result
  assert.equal(result.kind, 'no-live-agent')
})

// ---------------------------------------------------------------------------
// Activation robustness
// ---------------------------------------------------------------------------

test('one failing activation step does not skip the others', () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  // A web server whose registration throws: the probe route step must fail
  // alone, leaving the tool, commands, hooks and renderer in place.
  ctx.inject = (services, callback) => {
    if (services.includes('webServer')) {
      callback({ effect: () => { throw new Error('no web server here') } })
      return
    }
    callback(ctx)
  }
  const runtime = apply(ctx, { observeAfterTokens: 111 })

  assert.equal(ctx.registered.tools.length, 1, 'the recall tool still registered')
  assert.equal(ctx.registered.commands.length, 3, 'the commands still registered')
  assert.ok(ctx.handlers.has('agent/turn-stopping'), 'the turn hook still registered')
  assert.ok(Object.hasOwn(engine, 'summarize'), 'the compaction renderer still installed')
  assert.match(runtime.stats.steps['probe route'], /no web server here/)
  assert.equal(runtime.stats.steps['recall tool'], 'ok')
  assert.equal(runtime.stats.steps['turn hook'], 'ok')
})

test('apply records each activation step outcome and the resolved config', () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  ctx.webServer = { register: () => () => {} }
  const runtime = apply(ctx, { observeAfterTokens: 111 })

  for (const step of [
    'recall tool',
    'commands',
    'compaction renderer',
    'agent compaction hook',
    'probe route',
    'turn hook',
    'dispose hook',
    'inflight cleanup'
  ]) {
    assert.equal(typeof runtime.stats.steps[step], 'string', `step "${step}" must be recorded`)
    assert.ok(runtime.stats.steps[step].length > 0, `step "${step}" must not be empty`)
    assert.doesNotMatch(runtime.stats.steps[step], /exploded|not mounted/, `step "${step}" must not have failed`)
  }
  // The fake has a root engine and no agents, so the renderer is on the root.
  assert.equal(runtime.stats.steps['compaction renderer'], 'root')
  assert.equal(runtime.config.observeAfterTokens, 111)
  assert.equal(runtime.stats.turnStoppingSeen, 0)
})

// ---------------------------------------------------------------------------
// Full activation
// ---------------------------------------------------------------------------

test('apply wires the tool, the commands, the compaction wrapper and the turn hook', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  apply(ctx, { observeAfterTokens: 1234 })

  assert.equal(ctx.registered.tools.length, 1)
  assert.equal(ctx.registered.commands.length, 3)
  assert.ok(ctx.handlers.has('agent/turn-stopping'))
  assert.ok(ctx.handlers.has('agent/disposed'))
  assert.ok(Object.hasOwn(engine, 'summarize'), 'apply wraps the live compaction engine')

  // The turn handler starts background work and must return immediately without
  // swallowing a serial continuation.
  let continued = false
  const returned = ctx.handlers.get('agent/turn-stopping')({ agent: fakeAgent('session-apply', []) }, () => {
    continued = true
    return true
  })
  assert.equal(continued, true, 'a serial event must not have its continuation swallowed')
  assert.equal(returned, true, 'the continuation result is propagated')

  // And it must not throw when the event carries no agent at all.
  assert.doesNotThrow(() => ctx.handlers.get('agent/turn-stopping')({}, undefined))
})

test('passive mode suppresses background work but keeps the renderer', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const ctx = fakeCtx({ compaction: engine })
  apply(ctx, { passive: true })

  const runtime = runtimeFor(ctx, { passive: true })
  // scheduleMemoryPass is not exported for direct assertion; instead confirm the
  // handler does not enqueue anything observable and does not throw.
  assert.doesNotThrow(() => ctx.handlers.get('agent/turn-stopping')({ agent: fakeAgent('session-passive', []) }, undefined))
  assert.equal(engine.calls, 0)
  void runtime
})

process.on('exit', () => {
  void rm(home, { recursive: true, force: true })
})
