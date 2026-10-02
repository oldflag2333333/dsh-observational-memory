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
  observationLineTokens,
  observationPoolMetrics,
  conversationView,
  reflectionCoverageMap,
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
  buildId,
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
  // Sequences are derived the way the harness derives them: one per message, in
  // surface order. A test that cares about anchoring passes explicit `seqs`.
  const seqs = Array.isArray(options.seqs) ? options.seqs : messages.map((_, index) => index + 1)
  const freeze = (value) => {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child)
      Object.freeze(value)
    }
    return value
  }
  // Raw log events remain immutable even when a race replaces the projection.
  const events = new Map(messages.map((message, index) => {
    const raw = structuredClone(message)
    const type = message.role === 'user' ? 'user/message'
      : message.role === 'tool' ? 'tool/result' : 'assistant/message'
    return [seqs[index], freeze({ seq: seqs[index], type, data: type === 'user/message' ? raw : { message: raw } })]
  }))
  return {
    options: { provider: 'test-provider', model: 'test-model' },
    session: {
      id: sessionId,
      deriveMessages: () => messages,
      eventAt: (seq) => events.get(seq),
      surface: { nodes: seqs },
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
  let ctxPrompts
  const registered = { tools: [], commands: [] }
  const handlers = new Map()
  const disposers = []
  const prompts = []
  ctxPrompts = prompts
  const llmService = {
    async *stream(options) {
      try {
        prompts.push(String(options?.messages?.[0]?.content?.[0]?.text ?? ''))
      } catch {
        /* a malformed request is the caller's problem, not the recorder's */
      }
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
    prompts: ctxPrompts,
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
    observedSeq: 'nope',
    reflectedSeq: 3.5
  })
  assert.equal(ledger.observations.length, 1)
  assert.equal(ledger.observations[0].content, 'kept')
  assert.equal(ledger.observations[0].relevance, 'medium', 'missing relevance defaults')
  assert.equal(ledger.observations[0].evidence, '')
  assert.deepEqual(ledger.reflections[0].supportingIds, ['aaaaaaaaaaaa'])
  assert.deepEqual(ledger.dropped, ['dddddddddddd'])
  assert.equal(ledger.observedCount, 0, 'a negative count resets')
  assert.equal(ledger.observedSeq, undefined, 'a non-integer anchor is discarded')
  assert.equal(ledger.reflectedSeq, undefined, 'so is a non-integer reflection anchor')
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
  // The pool counts the whole rendered line, not the stored content estimate:
  // the budget caps how much observation text re-enters future contexts, and
  // every line carries id, timestamp and relevance alongside the content.
  assert.equal(activeObservationTokens(ledger), observationLineTokens(ledger.observations[1]))
  assert.ok(activeObservationTokens(ledger) > 3, 'line pricing includes the metadata overhead')
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
  assert.match(rendered, /older observation\(s\) omitted/)

  // Recency wins: the newest observation survives, the oldest is gone. Plain
  // truncation would have done the opposite and silently dropped the most
  // relevant memory.
  assert.match(rendered, /observation number 399/)
  assert.doesNotMatch(rendered, /observation number 0 /)
  assert.match(rendered, /use the recall tool/, 'the preamble survives elision')
})

test('elision sheds what the budget needs, not an order of magnitude more', () => {
  // Regression: the drop was sized with a guessed 80-character average, but real
  // observations average ~231. One iteration therefore discarded 315 of 316
  // observations to shed 24% of the length — a catastrophic loss the rendered
  // text gave a reader no way to notice.
  const ledger = emptyLedger('s')
  for (let index = 0; index < 316; index += 1) {
    ledger.observations.push({
      id: memoryId('observation', String(index)),
      content: 'x'.repeat(231),
      timestamp: '2026-10-01 14:41',
      relevance: 'medium',
      tokens: 58,
      evidence: ''
    })
  }
  const rendered = renderMemory(ledger)
  const kept = (rendered.match(/^\[[0-9a-f]{12}\]/gm) ?? []).length
  const elided = Number((rendered.match(/\[(\d+) older observation/) ?? [])[1])

  assert.equal(kept + elided, 316, 'every observation is either kept or accounted for')
  assert.ok(kept > 150, `expected most observations to survive, kept ${kept}`)
  assert.ok(rendered.length <= 62000, `expected the render to respect the budget, got ${rendered.length}`)

  // The point of the fix: shed enough, never far more than enough.
  assert.ok(elided / 316 < 0.5, `shed ${((elided / 316) * 100).toFixed(1)}% for a 24% overflow`)
})

test('elision still converges when one observation exceeds the whole budget', () => {
  const ledger = emptyLedger('s')
  ledger.observations.push(
    { id: 'aaaaaaaaaaaa', content: 'a'.repeat(200000), timestamp: 't', relevance: 'low', tokens: 1, evidence: '' },
    { id: 'bbbbbbbbbbbb', content: 'b'.repeat(200000), timestamp: 't', relevance: 'low', tokens: 1, evidence: '' }
  )
  const rendered = renderMemory(ledger)
  assert.match(rendered, /\[bbbbbbbbbbbb\]/, 'the newest survives even when it alone is oversized')
  assert.doesNotMatch(rendered, /\[aaaaaaaaaaaa\]/)
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
      { content: 'User decided to switch to GraphQL', relevance: 'high', sourceSeqs: [1] },
      { content: 'Migration completed and validated', relevance: 'critical', sourceSeqs: [2] }
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
  assert.deepEqual(ledger.observations.map((item) => item.sourceSeqs), [[1], [2]])
  assert.ok(ledger.observations.every((item) => !Object.hasOwn(item, 'evidence')), 'new observations retain exact references, not a shared excerpt')
  assert.match(ctx.prompts[0], /\[Source event seq: 1\]\n\[user\]\nfirst /)
  assert.match(ctx.prompts[0], /\[Source event seq: 2\]\n\[assistant\]\nsecond /)
  assert.match(ledger.observations[0].timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('runObserver advances coverage only by the chunk it actually read', async () => {
  const messages = Array.from({ length: 4 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `turn ${index} ${'z'.repeat(400)}` }]
  }))
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'first chunk noted', relevance: 'medium', sourceSeqs: [1] }])] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10, observerChunkMaxTokens: 60 })
  const ledger = await runtime.store.load('session-chunk')
  const agent = fakeAgent('session-chunk', messages)

  await runObserver(runtime, agent, ledger, undefined)
  const advanced = ledger.observedCount
  assert.ok(advanced > 0 && advanced < messages.length, `expected a partial advance, got ${advanced}`)
  assert.deepEqual(ledger.observations[0].sourceSeqs, [1])
  assert.match(ctx.prompts[0], /\[Source event seq: 1\]\n\[user\]\nturn 0 /)
  assert.doesNotMatch(ctx.prompts[0], /\[Source event seq: 2\]/)
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

test('an anchor that a compaction removed re-reads the surviving history', async () => {
  // The anchor is an identity, so a surface replacement resolves it to nothing
  // and the ledger reads what survived. The old counter needed a hand-written
  // "did the list shrink?" heuristic, which is how the count and the token total
  // came to disagree in the first place.
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'post-compaction state', relevance: 'medium', sourceSeqs: [1000] }])] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10 })
  const ledger = await runtime.store.load('session-shrunk')
  ledger.observedSeq = 9999 // a sequence the new surface does not contain
  ledger.observedCount = 50
  const agent = fakeAgent('session-shrunk', [{ role: 'user', content: [{ type: 'text', text: `surviving ${lorem}` }] }], {
    seqs: [1000]
  })
  await runObserver(runtime, agent, ledger, undefined)
  assert.equal(ledger.observations.length, 1)
  assert.equal(ledger.observedCount, 1)
  assert.equal(ledger.observedSeq, 1000, 'the anchor moves to the surviving message')
  assert.deepEqual(ledger.observations[0].sourceSeqs, [1000])
  assert.match(ctx.prompts[0], /\[Source event seq: 1000\]\n\[user\]\nsurviving /)
})

// ---------------------------------------------------------------------------
// Threshold semantics (ported from the original's two measurement kinds)
// ---------------------------------------------------------------------------

test('the reflector is due on conversation flow, not on pool size', async () => {
  // The bug this pins: the reflector compared the observation POOL against a
  // threshold meant for conversational FLOW. Observations are condensed, so a
  // pool of 316 represented ~560k tokens of conversation while weighing ~18k —
  // it could never reach a 20k threshold, and the reflector was unreachable code
  // no matter how long the session ran.
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'a durable fact', supportingIds: [] }])] })
  const runtime = runtimeFor(ctx, { reflectAfterTokens: 20000 })
  // A real surface, so anchors resolve and the flow is measurable.
  // Measured: ~104 tokens per message here, so clearing a 20k threshold takes
  // ~200 messages. Sized from the measurement, not from an estimate.
  const conversation = Array.from({ length: 220 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `turn ${index} ${'x'.repeat(400)}` }]
  }))
  const seqs = conversation.map((_, index) => 1000 + index)
  const agent = fakeAgent('session-flow', conversation, { seqs })

  // A huge pool with no new conversation since the last reflection: not due.
  const stocked = await runtime.store.load('session-flow-stocked')
  // ~52 tokens per rendered observation line, so clearing a 20k pool takes ~400.
  for (let index = 0; index < 420; index += 1) {
    stocked.observations.push({
      id: memoryId('observation', `s${index}`),
      content: 'a very long observation that inflates the pool considerably '.repeat(3),
      timestamp: 't',
      relevance: 'medium',
      tokens: 100,
      evidence: ''
    })
  }
  // Both anchors rest on the last message: nothing has flowed past the reflector.
  stocked.observedSeq = seqs[seqs.length - 1]
  stocked.reflectedSeq = seqs[seqs.length - 1]
  stocked.observedCount = conversation.length
  assert.equal(
    await runReflector(runtime, agent, stocked, undefined),
    null,
    'a big pool with no new conversation is not a reason to reflect'
  )
  assert.ok(activeObservationTokens(stocked) > 20000, 'the pool really is over the threshold')

  // A small pool with plenty of new conversation since: due.
  const fresh = await runtime.store.load('session-flow-fresh')
  fresh.observations.push({ id: 'aaaaaaaaaaaa', content: 'one observation', timestamp: 't', relevance: 'medium', tokens: 5, evidence: '' })
  // The observation anchor sits at the end while the reflection anchor sits at
  // the start, so the whole conversation has flowed past the reflector.
  fresh.observedSeq = seqs[seqs.length - 1]
  fresh.observedCount = conversation.length
  fresh.reflectedSeq = seqs[0]
  const result = await runReflector(runtime, agent, fresh, undefined)
  assert.match(result.message, /recorded 1 new reflection/)
  assert.equal(result.status, 'success')
  assert.equal(result.recorded, 1)
  assert.equal(result.restated, 0)

  // And the reflection anchor advances onto the conversation just reasoned over.
  assert.equal(fresh.reflectedSeq, fresh.observedSeq)
})

test('the reflection anchor only advances when the run concluded something', async () => {
  // The defect this pins: the anchor advanced unconditionally, so a run that
  // distilled nothing — or whose output could not be parsed — marked the
  // conversation as reflected anyway and retired it permanently. The clock would
  // then read zero however much unreflected history sat behind it.
  const conversation = Array.from({ length: 220 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `turn ${index} ${'x'.repeat(400)}` }]
  }))
  const seqs = conversation.map((_, index) => 1000 + index)

  const empty = fakeCtx({ replies: [JSON.stringify([])] })
  const emptyRuntime = runtimeFor(empty, { reflectAfterTokens: 20000 })
  const emptyLedger = await emptyRuntime.store.load('session-reflect-empty')
  emptyLedger.observations.push({ id: 'aaaaaaaaaaaa', content: 'a fact', timestamp: 't', relevance: 'medium', tokens: 5, evidence: '' })
  emptyLedger.observedSeq = seqs[seqs.length - 1]
  emptyLedger.observedCount = conversation.length
  emptyLedger.reflectedSeq = seqs[0]

  const emptyOutcome = await runReflector(emptyRuntime, fakeAgent('session-reflect-empty', conversation, { seqs }), emptyLedger, undefined)
  assert.match(emptyOutcome.message, /coverage left unchanged/)
  assert.equal(emptyOutcome.status, 'empty')
  assert.equal(emptyOutcome.recorded + emptyOutcome.restated, 0)
  assert.equal(emptyLedger.reflectedSeq, seqs[0], 'the anchor did not move')
  assert.equal(emptyLedger.reflections.length, 0)

  const broken = fakeCtx({ replies: ['not json at all'] })
  const brokenRuntime = runtimeFor(broken, { reflectAfterTokens: 20000 })
  const brokenLedger = await brokenRuntime.store.load('session-reflect-broken')
  brokenLedger.observations.push({ id: 'bbbbbbbbbbbb', content: 'a fact', timestamp: 't', relevance: 'medium', tokens: 5, evidence: '' })
  brokenLedger.observedSeq = seqs[seqs.length - 1]
  brokenLedger.observedCount = conversation.length
  brokenLedger.reflectedSeq = seqs[0]

  const brokenOutcome = await runReflector(brokenRuntime, fakeAgent('session-reflect-broken', conversation, { seqs }), brokenLedger, undefined)
  assert.match(brokenOutcome.message, /unparseable/)
  assert.equal(brokenOutcome.status, 'unparseable')
  assert.equal(brokenOutcome.recorded + brokenOutcome.restated, 0)
  assert.equal(brokenLedger.reflectedSeq, seqs[0], 'nor did a failed run move it')

  // A run that produces a conclusion does advance it.
  const good = fakeCtx({ replies: [JSON.stringify([{ content: 'a durable conclusion', supportingIds: [] }])] })
  const goodRuntime = runtimeFor(good, { reflectAfterTokens: 20000 })
  const goodLedger = await goodRuntime.store.load('session-reflect-good')
  goodLedger.observations.push({ id: 'cccccccccccc', content: 'a fact', timestamp: 't', relevance: 'medium', tokens: 5, evidence: '' })
  goodLedger.observedSeq = seqs[seqs.length - 1]
  goodLedger.observedCount = conversation.length
  goodLedger.reflectedSeq = seqs[0]

  await runReflector(goodRuntime, fakeAgent('session-reflect-good', conversation, { seqs }), goodLedger, undefined)
  assert.equal(goodLedger.reflectedSeq, seqs[seqs.length - 1], 'a real conclusion advances it')
})

test('restating an existing reflection still counts as reflecting', async () => {
  // The run did reason over the conversation and answered "these still hold",
  // which is a conclusion. Treating it as no progress would re-run the reflector
  // forever on the same span.
  const conversation = Array.from({ length: 220 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `turn ${index} ${'x'.repeat(400)}` }]
  }))
  const seqs = conversation.map((_, index) => 1000 + index)
  const content = 'the project targets a January ship date'

  const ctx = fakeCtx({ replies: [JSON.stringify([{ content, supportingIds: [] }])] })
  const runtime = runtimeFor(ctx, { reflectAfterTokens: 20000 })
  const ledger = await runtime.store.load('session-reflect-restate')
  // The reflector needs an observation pool to distil from, and an existing
  // reflection to restate.
  ledger.observations.push({ id: 'dddddddddddd', content: 'a fact', timestamp: 't', relevance: 'medium', tokens: 5, evidence: '' })
  ledger.reflections.push({ id: memoryId('reflection', content), content, supportingIds: [], tokens: 8 })
  ledger.observedSeq = seqs[seqs.length - 1]
  ledger.observedCount = conversation.length
  ledger.reflectedSeq = seqs[0]

  const outcome = await runReflector(runtime, fakeAgent('session-reflect-restate', conversation, { seqs }), ledger, undefined)
  assert.match(outcome.message, /restated 1/)
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.recorded, 0)
  assert.equal(outcome.restated, 1)
  assert.equal(ledger.reflections.length, 1, 'no duplicate reflection was appended')
  assert.equal(ledger.reflectedSeq, seqs[seqs.length - 1], 'and the anchor moved')
})

test('coverage tiers count citations, so one reflection is only partial', async () => {
  // The defect this pins: coverage was a boolean, so an observation cited by a
  // single reflection was labelled `strong` — the strongest pruning signal the
  // dropper receives — where the original calls that `partial`. The error runs in
  // the dangerous direction: it invites pruning memory the reflections do not
  // really preserve.
  const observations = [
    { id: 'aaaaaaaaaaaa', content: 'cited twice', timestamp: 't', relevance: 'high', tokens: 5, evidence: '' },
    { id: 'bbbbbbbbbbbb', content: 'cited once', timestamp: 't', relevance: 'high', tokens: 5, evidence: '' },
    { id: 'cccccccccccc', content: 'not cited', timestamp: 't', relevance: 'high', tokens: 5, evidence: '' }
  ]
  const reflections = [
    { id: 'r1', content: 'one', supportingIds: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'], tokens: 2 },
    { id: 'r2', content: 'two', supportingIds: ['aaaaaaaaaaaa'], tokens: 2 }
  ]

  const tiers = reflectionCoverageMap(observations, reflections)
  assert.equal(tiers.get('aaaaaaaaaaaa'), 'strong', 'two reflections citing it')
  assert.equal(tiers.get('bbbbbbbbbbbb'), 'partial', 'one reflection citing it')
  assert.equal(tiers.get('cccccccccccc'), 'none', 'no reflection citing it')

  // A duplicate id inside one reflection is one piece of evidence, not two.
  const duplicated = reflectionCoverageMap(observations, [
    { id: 'r3', content: 'dup', supportingIds: ['bbbbbbbbbbbb', 'bbbbbbbbbbbb'], tokens: 2 }
  ])
  assert.equal(duplicated.get('bbbbbbbbbbbb'), 'partial')

  const ctx = fakeCtx({ replies: [JSON.stringify([])] })
  const runtime = runtimeFor(ctx, { observationsPoolTargetTokens: 10 })
  const ledger = emptyLedger('session-tier')
  ledger.observations.push(...observations)
  ledger.reflections.push(...reflections)
  await runDropper(runtime, fakeAgent('session-tier', []), ledger, undefined)

  const prompt = ctx.prompts.find((entry) => entry.includes('coverage:'))
  assert.ok(prompt !== undefined, 'the dropper prompt carries coverage annotations')
  assert.match(prompt, /coverage: strong/)
  assert.match(prompt, /coverage: partial/)
  assert.match(prompt, /coverage: none/)
})

test('the dropper triggers on the pool TARGET, not the pool maximum', async () => {
  // In the original these are two budgets with different jobs: the maximum only
  // decides whether compaction renders a full fold, the target is what the
  // dropper trims toward. Using the maximum as the trigger made pruning late by
  // design, because it is twice the target.
  const ctx = fakeCtx({ replies: [JSON.stringify([])] })
  const runtime = runtimeFor(ctx, { observationsPoolTargetTokens: 1000, observationsPoolMaxTokens: 20000 })
  const ledger = await runtime.store.load('session-target')
  // Deliberately between target and maximum: a pool in this band must still prune.
  for (let index = 0; index < 12; index += 1) {
    ledger.observations.push({
      id: memoryId('observation', `t${index}`),
      content: 'x'.repeat(400),
      timestamp: 't',
      relevance: 'medium',
      tokens: 100,
      evidence: ''
    })
  }
  const pool = observationPoolMetrics(activeObservations(ledger), 1000)
  assert.ok(pool.observationTokens > 1000 && pool.observationTokens < 20000, 'pool sits between target and max')
  assert.equal(pool.ready, true, 'and is therefore prunable')

  // The run reaches the model, which is only possible past the readiness gate.
  const outcome = await runDropper(runtime, fakeAgent('session-target', []), ledger, undefined)
  assert.match(outcome, /dropper:/)
  assert.match(outcome, /allowed towards a 1000-token target/)
})

test('the drop budget caps the model, which cannot gut the pool', async () => {
  // A model that returns every id it was shown is over-reaching; honouring it
  // would discard memory the budget never asked to shed.
  const observations = Array.from({ length: 10 }, (_, index) => ({
    id: memoryId('observation', `c${index}`),
    content: 'y'.repeat(400),
    timestamp: 't',
    relevance: 'medium',
    tokens: 100,
    evidence: ''
  }))
  // 10 lines at ~110 tokens each is ~1100, so the target must sit below that.
  const pool = observationPoolMetrics(observations, 500)
  assert.equal(pool.activeObservationCount, 10)
  assert.ok(pool.maxDropsAllowed > 0 && pool.maxDropsAllowed < 10, `expected a partial cap, got ${pool.maxDropsAllowed}`)

  const ctx = fakeCtx({ replies: [JSON.stringify(observations.map((item) => item.id))] })
  const runtime = runtimeFor(ctx, { observationsPoolTargetTokens: 500 })
  const ledger = await runtime.store.load('session-cap')
  ledger.observations.push(...observations)

  await runDropper(runtime, fakeAgent('session-cap', []), ledger, undefined)
  assert.equal(ledger.dropped.length, pool.maxDropsAllowed, 'the budget bounded the model')
})

test('pool metrics price whole lines and never report an empty pool as prunable', () => {
  const observation = { id: 'aaaaaaaaaaaa', content: 'x'.repeat(400), timestamp: '2026-01-01 00:00', relevance: 'high', tokens: 100, evidence: '' }
  const line = observationLineTokens(observation)
  assert.ok(line > estimateTokens(observation.content), 'line pricing exceeds the bare content')
  assert.ok(line > observation.tokens, 'and exceeds the stored content estimate, so metadata is counted')

  const empty = observationPoolMetrics([], 1000)
  assert.equal(empty.ready, false)
  assert.equal(empty.maxDropsAllowed, 0)
  assert.equal(empty.observationTokens, 0)

  // Exactly on target is not over target.
  const at = observationPoolMetrics([observation], observationLineTokens(observation))
  assert.equal(at.overTarget, false)
  assert.equal(at.ready, false, 'an exactly-on-target pool is never pruned')

  // A non-positive target is rejected rather than dividing by zero.
  const bad = observationPoolMetrics([observation], 0)
  assert.equal(bad.fullness, 0)
  assert.equal(bad.ready, false)
})

test('the pool target defaults to half the maximum, as in the original', () => {
  assert.equal(resolveConfig({}).observationsPoolTargetTokens, 10000)
  assert.equal(resolveConfig({ observationsPoolMaxTokens: 40000 }).observationsPoolTargetTokens, 20000)
  assert.equal(resolveConfig({ observationsPoolMaxTokens: 40000, observationsPoolTargetTokens: 5000 }).observationsPoolTargetTokens, 5000)
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
  // The reflector is due on raw conversation that has flowed past its anchor, not
  // on the size of the observation pool.
  const turns = Array.from({ length: 50 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `t${index} ${'y'.repeat(400)}` }]
  }))
  ledger.observedSeq = 49
  ledger.observedCount = 50
  const agent = fakeAgent('session-reflector', turns, { seqs: turns.map((_, index) => index) })

  const outcome = await runReflector(runtime, agent, ledger, undefined)
  assert.match(outcome.message, /recorded 1 new reflection/)
  assert.equal(outcome.status, 'success')
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
      JSON.stringify([{ content: 'did the work', relevance: 'high', sourceSeqs: [1] }]),
      JSON.stringify([{ content: 'the project is underway', supportingIds: [] }])
    ]
  })
  const runtime = runtimeFor(ctx, {
    observeAfterTokens: 10,
    reflectAfterTokens: 1,
    observationsPoolMaxTokens: 100000,
    // Pinned to the sequential default: this test is about ordering, and catch-up
    // would need one scripted reply per chunk.
    catchUpChunksPerPass: 1
  })
  const outcomes = await runMemoryPass(runtime, fakeAgent('session-pass', messages), undefined)
  assert.equal(outcomes.length, 2, 'no dropper run: the pool is under target')
  assert.match(outcomes[0], /^observer:/)
  assert.match(outcomes[1], /^reflector:/)
})

// Keep the active pool over budget and retain old reflection coverage. These
// cases would invoke Dropper under the old `reflector !== null` string gate.
async function reflectionPassFixture(sessionId, replies) {
  const ctx = fakeCtx({ replies })
  const runtime = runtimeFor(ctx, {
    observeAfterTokens: 1, reflectAfterTokens: 1,
    observationsPoolTargetTokens: 1
  })
  const ledger = await runtime.store.load(sessionId)
  const messages = ['already reflected history', 'newly observed conversation'].map((text) => ({
    role: 'user', content: [{ type: 'text', text: text.repeat(20) }]
  }))
  const agent = fakeAgent(sessionId, messages)
  ledger.observedSeq = 2
  ledger.observedCount = 2
  ledger.reflectedSeq = 1
  ledger.observations.push({
    id: 'aaaaaaaaaaaa', content: 'An existing load-bearing constraint',
    timestamp: 't', relevance: 'critical', tokens: 10, evidence: 'source'
  })
  ledger.reflections.push({
    id: memoryId('reflection', 'Existing durable conclusion'),
    content: 'Existing durable conclusion', supportingIds: ['aaaaaaaaaaaa'], tokens: 10
  })
  const writes = { count: 0 }
  const save = runtime.store.save.bind(runtime.store)
  runtime.store.save = (id) => { writes.count += 1; return save(id) }
  return { ctx, runtime, ledger, agent, writes }
}

for (const [name, reply, reason] of [
  ['empty', '[]', 'no durable conclusions'],
  ['unparseable', 'not valid JSON', 'unparseable'],
  ['missing content', '[{}]', 'invalid'],
  ['null item', '[null]', 'invalid'],
  ['non-object item', '["not a reflection"]', 'invalid'],
  ['blank content', '[{"content":"  ","supportingIds":[]}]', 'invalid'],
  ['non-string content', '[{"content":42,"supportingIds":[]}]', 'invalid'],
  ['invalid support container', '[{"content":"a fact","supportingIds":{}}]', 'invalid'],
  ['mixed valid and invalid', '[{"content":"a valid fact","supportingIds":["aaaaaaaaaaaa"]},{}]', 'invalid']
]) {
  test(`a ${name} Reflector result cannot trigger same-pass pruning`, async () => {
    const fixture = await reflectionPassFixture(`reflection-gate-${name.replaceAll(' ', '-')}`, [reply, '["aaaaaaaaaaaa"]'])
    const { ctx, runtime, ledger, agent, writes } = fixture
    const before = structuredClone(ledger)
    const outcomes = await runMemoryPass(runtime, agent)
    assert.equal(ctx.prompts.length, 1, 'Dropper must not even be called despite an over-budget pool and old reflection coverage')
    assert.equal(outcomes.length, 1)
    assert.match(outcomes[0], new RegExp(reason))
    assert.deepEqual(ledger, before, 'neither partial reflections, coverage nor tombstones may be committed')
    assert.equal(writes.count, 0)
  })
}

test('a not-due Reflector cannot authorize pruning from old reflections', async () => {
  const { ctx, runtime, ledger, agent, writes } = await reflectionPassFixture('reflection-gate-not-due', ['["aaaaaaaaaaaa"]'])
  ledger.reflectedSeq = ledger.observedSeq
  const before = structuredClone(ledger)
  assert.deepEqual(await runMemoryPass(runtime, agent), [])
  assert.equal(ctx.prompts.length, 0)
  assert.deepEqual(ledger, before)
  assert.equal(writes.count, 0)
})

test('a failed Reflector worker aborts the pass without invoking Dropper', async () => {
  const { ctx, runtime, ledger, agent, writes } = await reflectionPassFixture('reflection-gate-worker-error', [
    () => { throw new Error('reflector provider failure') }, '["aaaaaaaaaaaa"]'
  ])
  const before = structuredClone(ledger)
  await assert.rejects(runMemoryPass(runtime, agent), /reflector provider failure/)
  assert.equal(ctx.prompts.length, 1)
  assert.deepEqual(ledger, before)
  assert.equal(writes.count, 0)
  assert.equal(runtime.stats.passesFailed, 1)
})

test('a successful non-empty Reflector result permits same-pass budgeted pruning', async () => {
  const { ctx, runtime, ledger, agent, writes } = await reflectionPassFixture('reflection-gate-success', [
    '[{"content":"A new durable conclusion","supportingIds":["aaaaaaaaaaaa"]}]',
    '["aaaaaaaaaaaa"]'
  ])
  const outcomes = await runMemoryPass(runtime, agent)
  assert.equal(ctx.prompts.length, 2)
  assert.equal(outcomes.length, 2)
  assert.match(outcomes[0], /recorded 1 new reflection/)
  assert.match(outcomes[1], /^dropper: dropped 1/)
  assert.equal(ledger.reflectedSeq, ledger.observedSeq)
  assert.equal(ledger.reflections.length, 2)
  assert.deepEqual(ledger.dropped, ['aaaaaaaaaaaa'])
  assert.equal(writes.count, 2)
})

test('a successful non-empty restatement remains eligible for same-pass pruning', async () => {
  const { ctx, runtime, ledger, agent } = await reflectionPassFixture('reflection-gate-restatement', [
    '[{"content":"Existing durable conclusion","supportingIds":["aaaaaaaaaaaa"]}]',
    '["aaaaaaaaaaaa"]'
  ])
  const outcomes = await runMemoryPass(runtime, agent)
  assert.equal(ctx.prompts.length, 2)
  assert.match(outcomes[0], /recorded 0 new reflection\(s\), restated 1/)
  assert.match(outcomes[1], /^dropper:/)
  assert.equal(ledger.reflections.length, 1)
  assert.equal(ledger.reflectedSeq, ledger.observedSeq)
  assert.deepEqual(ledger.dropped, ['aaaaaaaaaaaa'])
})

test('catch-up drains the backlog in one pass, up to its cap', async () => {
  // Four chunks are due; the cap is three, so the pass reads three and says so.
  const messages = Array.from({ length: 4 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `chunk ${index} ${'z'.repeat(400)}` }]
  }))
  const ctx = fakeCtx({
    replies: [
      JSON.stringify([{ content: 'one', relevance: 'medium', sourceSeqs: [1] }]),
      JSON.stringify([{ content: 'two', relevance: 'medium', sourceSeqs: [2] }]),
      JSON.stringify([{ content: 'three', relevance: 'medium', sourceSeqs: [3] }])
    ]
  })
  const runtime = runtimeFor(ctx, {
    observeAfterTokens: 5,
    reflectAfterTokens: 1000000,
    observerChunkMaxTokens: 60,
    catchUpChunksPerPass: 3
  })
  const agent = fakeAgent('session-catchup', messages)
  const outcomes = await runMemoryPass(runtime, agent, undefined)

  const observers = outcomes.filter((line) => line.startsWith('observer:'))
  assert.equal(observers.length, 3, 'three chunks in one pass instead of one')
  assert.match(outcomes[outcomes.length - 1], /catch-up: stopped at the 3-chunk cap/)
  assert.equal(runtime.stats.catchUpChunks, 3)
  assert.equal(runtime.stats.catchUpActive, true, 'backlog remains')

  // The ledger really did advance three chunks' worth.
  const ledger = await runtime.store.load('session-catchup')
  assert.equal(ledger.observations.length, 3)
  assert.deepEqual(ledger.observations.map((item) => item.sourceSeqs), [[1], [2], [3]])
  for (let index = 0; index < 3; index += 1) {
    assert.match(ctx.prompts[index], new RegExp(`\\[Source event seq: ${index + 1}\\]\\n\\[user\\]\\nchunk ${index} `))
  }
  assert.ok(ledger.observedCount > 1)
})

test('catch-up reports convergence when the backlog empties', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: `only chunk ${lorem}` }] }]
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'the only one', relevance: 'medium', sourceSeqs: [1] }])] })
  const runtime = runtimeFor(ctx, {
    observeAfterTokens: 5,
    reflectAfterTokens: 1000000,
    observerChunkMaxTokens: 100000,
    catchUpChunksPerPass: 10
  })
  const outcomes = await runMemoryPass(runtime, fakeAgent('session-converged', messages), undefined)

  assert.equal(outcomes.filter((line) => line.startsWith('observer:')).length, 1)
  assert.equal(runtime.stats.catchUpChunks, 1)
  assert.equal(runtime.stats.catchUpActive, false, 'nothing was left behind')
  assert.doesNotMatch(outcomes.join(' '), /chunk cap/)
})

test('the catch-up cap is configurable and defaults to sequential', () => {
  assert.equal(resolveConfig({}).catchUpChunksPerPass, 1, 'one chunk per pass unless asked otherwise')
  assert.equal(resolveConfig({ catchUpChunksPerPass: 40 }).catchUpChunksPerPass, 40)
  assert.equal(resolveConfig({ catchUpChunksPerPass: 0 }).catchUpChunksPerPass, 1, 'zero is not a valid cap')
  assert.equal(resolveConfig({ catchUpChunksPerPass: -5 }).catchUpChunksPerPass, 1)
})

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

test('runMemoryPass owns coherent accounting for both of its callers', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: `work happened ${lorem}` }] }]
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'noted', relevance: 'high', sourceSeqs: [1] }])] })
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

test('a hung run is reclaimed instead of silencing every later turn', async () => {
  // The failure this prevents was observed live: one memory call never returned,
  // the in-flight slot stayed held, and because the scheduler skips a session
  // that already has a run, memory never started again for the whole process.
  const ctx = fakeCtx({ replies: [] })
  const runtime = runtimeFor(ctx, { passTimeoutMs: 30 })
  // A pass that never settles.
  runtime.store.load = () => new Promise(() => {})
  const agent = fakeAgent('session-hung', [])

  scheduleMemoryPass(runtime, agent)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runtime.stats.passesStarted, 1)

  // A second attempt inside the window is refused: runs must not stack.
  scheduleMemoryPass(runtime, agent)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runtime.stats.passesStarted, 1, 'still in flight, so not restarted')

  // Once the slot is stale, the next turn reclaims it.
  await new Promise((resolve) => setTimeout(resolve, 40))
  scheduleMemoryPass(runtime, agent)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runtime.stats.stalePassesReclaimed, 1, 'the stale slot was reclaimed')
  assert.equal(runtime.stats.passesStarted, 2, 'and a new run started')
})

test('a slow memory call is bounded by the timeout', async () => {
  const ctx = fakeCtx({ replies: [] })
  // `ctx.llm` is deliberately not a property (Cordis refuses undeclared service
  // access), so the slow stream is installed on the service itself. It yields
  // nothing and then ends, which is a stream that outlives the deadline without
  // wedging the async iterator's own teardown.
  ctx.get('llm').stream = () => ({
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 200)),
        return: () => Promise.resolve({ done: true, value: undefined })
      }
    }
  })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10, callTimeoutMs: 40 })
  const ledger = await runtime.store.load('session-timeout')
  const agent = fakeAgent('session-timeout', [{ role: 'user', content: [{ type: 'text', text: `hi ${lorem}` }] }])

  await assert.rejects(() => runObserver(runtime, agent, ledger, undefined), /timed out after 40ms/)
  assert.equal(ledger.observedCount, 0, 'a timed-out run must not advance coverage')
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

function assertRecallDiagnostics(result, status, sourceSeqs = []) {
  assert.equal(result.status, status)
  assert.deepEqual(result.sourceSeqs, sourceSeqs)
  for (const field of ['missingSourceSeqs', 'nonSourceSeqs', 'missingSupportingIds']) {
    assert.deepEqual(result[field], [], field)
  }
}

test('recall returns a legacy observation with its non-exact source excerpt', () => {
  const ledger = emptyLedger('s')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'a fact', timestamp: '2026-01-01 10:00', relevance: 'high', tokens: 2, evidence: 'the original words' })
  const result = recall(ledger, 'aaaaaaaaaaaa', fakeAgent('s', []).session)
  assert.equal(result.kind, 'observation')
  assertRecallDiagnostics(result, 'legacy')
  assert.match(result.text, /legacy/i)
  assert.match(result.text, /not exact evidence/i)
  assert.match(result.text, /the original words/)
})

test('recall still finds a dropped observation and says so', () => {
  const ledger = emptyLedger('s')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'pruned fact', timestamp: 't', relevance: 'low', tokens: 2, evidence: 'src' })
  ledger.dropped.push('aaaaaaaaaaaa')
  const result = recall(ledger, 'aaaaaaaaaaaa', fakeAgent('s', []).session)
  assert.equal(result.kind, 'observation-dropped')
  assertRecallDiagnostics(result, 'legacy')
  assert.match(result.text, /legacy/i)
  assert.match(result.text, /dropped from active memory/)
})

test('recall expands a reflection into its supporting observations', () => {
  const ledger = emptyLedger('s')
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'evidence one', timestamp: 't', relevance: 'high', tokens: 2, evidence: '' })
  ledger.reflections.push({ id: 'cccccccccccc', content: 'a conclusion', supportingIds: ['aaaaaaaaaaaa'], tokens: 2 })
  const result = recall(ledger, 'cccccccccccc', fakeAgent('s', []).session)
  assert.equal(result.kind, 'reflection')
  assertRecallDiagnostics(result, 'legacy')
  assert.match(result.text, /evidence one/)
})

test('recall reports an unknown id as missing', () => {
  const result = recall(emptyLedger('s'), 'ffffffffffff', fakeAgent('s', []).session)
  assert.equal(result.kind, 'missing')
  assertRecallDiagnostics(result, 'missing')
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
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'tool fact', timestamp: 't', relevance: 'high', tokens: 2, sourceSeqs: [1] })
  const agent = fakeAgent('session-tool', [{ role: 'user', content: [{ type: 'text', text: 'raw tool source' }] }])
  const result = await tool.execute({ id: 'aaaaaaaaaaaa' }, { agent })
  assert.equal(result.kind, 'observation')
  assertRecallDiagnostics(result, 'ok', [1])
  assert.match(result.text, /raw tool source/)
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: result.text }])

  const invalid = await tool.execute({ id: 'nope' }, { agent })
  assert.equal(invalid.kind, 'invalid')
  assert.equal(invalid.status, 'invalid')

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
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'forced observation', relevance: 'medium', sourceSeqs: [1] }])] })
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
  // The input must identify the actual covered surface span, not merely be
  // smaller than a different, longer message the ledger happened to observe.
  const covering = [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(40000) }] }]
  const agent = fakeAgent('session-compact', covering, { seqs: [1] })
  ledger.observedSeq = 1
  ledger.observedCount = 1

  assert.equal(installCompactionRenderer(runtime), true)
  const result = await engine.summarize(
    { messages: covering },
    agent,
    undefined
  )

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
  ledger.observedSeq = 999999 // an anchor the surface cannot resolve
  ledger.observedCount = 1

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
  ledger.observedSeq = 999999
  ledger.observedCount = 1

  installCompactionRenderer(runtime)
  const result = await engine.summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(4000) }] }] }, fakeAgent('session-small-uncovered', []), undefined)
  assert.equal(result.summary[0].text, 'native summary')
  assert.equal(runtime.stats.rendersSkippedUncovered, 1)
})

test('coversShadowedRegion proves message identity and position, not token size', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'A'.repeat(20000) }] },
    { role: 'user', content: [{ type: 'text', text: 'unread B' }] }
  ]
  const ledger = emptyLedger('coverage-region')
  ledger.observedSeq = 10
  const runtime = runtimeFor(fakeCtx())
  const agent = fakeAgent(ledger.sessionId, messages, { seqs: [10, 11] })
  const view = conversationView(runtime, agent, ledger)
  assert.equal(coversShadowedRegion(ledger, { messages: [messages[0]] }, view), true)
  assert.equal(coversShadowedRegion(ledger, { messages: [messages[1]] }, view), false, 'a shorter unread region is not covered')
  assert.equal(coversShadowedRegion(ledger, { messages }, view), false)
  assert.equal(coversShadowedRegion(ledger, { messages: [] }, view), false)
  assert.equal(coversShadowedRegion(ledger, { messages: [{ ...messages[0], content: [{ type: 'text', text: 'unrelated' }] }] }, view), false)
  assert.equal(coversShadowedRegion(ledger, { messages: [messages[0]] }, undefined), false)
  ledger.observedSeq = undefined
  ledger.observedCount = 2
  const countOnly = conversationView(runtime, agent, ledger)
  assert.equal(coversShadowedRegion(ledger, { messages }, countOnly), false, 'a legacy count is not proof of region identity')
})

test('the anchor decides coverage: resolvable reads through itself, stale re-reads', () => {
  // The anchor is the only persisted watermark, so there is nothing to reconcile:
  // a ledger whose anchor the surface cannot resolve re-reads the surviving
  // history, and one whose anchor resolves yields an exact covered prefix. Both
  // are derived on demand, never accumulated — which is what removes the drift
  // that let a count and a token total disagree.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: `first ${lorem}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `second ${lorem}` }] }
  ]
  const agent = fakeAgent('anchor-shapes', messages, { seqs: [10, 11] })
  const runtime = runtimeFor(fakeCtx())

  const resolvable = emptyLedger('anchor-A')
  resolvable.observedSeq = 11
  const a = conversationView(runtime, agent, resolvable)
  assert.equal(a.coveredCount, 2, 'a resolvable anchor covers through itself')
  assert.equal(a.pending.length, 0)
  assert.ok(a.coveredTokens > 0)
  assert.equal(a.coveredTokens + 0 >= a.coveredTokens, true)

  const stale = emptyLedger('anchor-B')
  stale.observedSeq = 999
  const b = conversationView(runtime, agent, stale)
  assert.equal(b.coveredCount, 0, 'an unresolvable anchor re-reads the surviving history')
  assert.equal(b.pending.length, 2)
  assert.equal(b.coveredTokens, 0)
  assert.equal(b.pendingTokens, b.conversationTokens, 'everything is pending again')

  // Middle anchor: the prefix is exactly what precedes it.
  const middle = emptyLedger('anchor-C')
  middle.observedSeq = 10
  const c = conversationView(runtime, agent, middle)
  assert.equal(c.coveredCount, 1)
  assert.equal(c.pending.length, 1)
  assert.equal(c.coveredTokens + c.pendingTokens, c.conversationTokens, 'the parts sum to the whole')

  // A caller-supplied anchor measures a different clock from the same surface:
  // this is how the reflector gets its own reading without a private total.
  const d = conversationView(runtime, agent, resolvable, 10)
  assert.equal(d.coveredCount, 1, 'an explicit anchor overrides the ledger one')
})

test('an explicit anchor survives a surface that cannot be read', () => {
  // Without sequences the view still works by count, which is the weaker
  // guarantee this model replaces; it must not throw.
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'only' }] }]
  const agent = { session: { deriveMessages: () => messages } }
  const ledger = emptyLedger('anchor-D')
  ledger.observedCount = 1

  const view = conversationView(runtimeFor(fakeCtx()), agent, ledger)
  assert.equal(view.aligned, false)
  assert.equal(view.coveredCount, 1, 'the count is the fallback')
  assert.equal(view.pending.length, 0)
})

test('the observer accumulates token coverage as it reads', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: `work happened ${lorem}` }] }]
  const more = [...messages, { role: 'user', content: [{ type: 'text', text: `more happened ${lorem}` }] }]
  const ctx = fakeCtx({
    replies: [
      JSON.stringify([{ content: 'noted one', relevance: 'medium', sourceSeqs: [11] }]),
      JSON.stringify([{ content: 'noted two', relevance: 'medium', sourceSeqs: [12] }])
    ]
  })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 10 })
  const ledger = await runtime.store.load('session-coverage')
  assert.equal(ledger.observedSeq, undefined)

  const firstSeq = [11]
  const agent = fakeAgent('session-coverage', messages, { seqs: firstSeq })
  await runObserver(runtime, agent, ledger, undefined)
  assert.equal(ledger.observedSeq, 11, 'reading a chunk moves the anchor')
  const afterFirst = conversationView(runtime, agent, ledger).coveredTokens
  assert.ok(afterFirst > 0, 'and that yields a covered total')

  const moreSeqs = [11, 12]
  const agent2 = fakeAgent('session-coverage', more, { seqs: moreSeqs })
  await runObserver(runtime, agent2, ledger, undefined)
  assert.equal(ledger.observedSeq, 12, 'the anchor advances with each chunk')
  assert.ok(
    conversationView(runtime, agent2, ledger).coveredTokens > afterFirst,
    'coverage grows as more is read'
  )
  assert.equal(ledger.observations.length, 2)
})

test('normalizeLedger coerces the sequence anchors', () => {
  assert.equal(normalizeLedger('s', { observedSeq: 500 }).observedSeq, 500)
  assert.equal(normalizeLedger('s', { observedSeq: -1 }).observedSeq, undefined)
  assert.equal(normalizeLedger('s', { observedSeq: 'nope' }).observedSeq, undefined)
  assert.equal(normalizeLedger('s', {}).observedSeq, undefined)
  assert.equal(normalizeLedger('s', { reflectedSeq: 7 }).reflectedSeq, 7)
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

  // Even a genuinely covered region must fall back if the memory is larger.
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'tiny' }] }]
  ledger.observedSeq = 1
  ledger.observedCount = 1
  const result = await engine.summarize(
    { messages },
    fakeAgent('session-tiny', messages),
    undefined
  )
  assert.equal(result.summary[0].text, 'native summary')
  assert.equal(runtime.stats.rendersSkippedUncovered, 0)
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
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'reached the llm', relevance: 'high', sourceSeqs: [1] }])] })
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
  const reported = summary.summary
  assert.deepEqual(
    {
      observations: reported.observations,
      activeObservations: reported.activeObservations,
      reflections: reported.reflections,
      dropped: reported.dropped,
      observedSeq: reported.observedSeq,
      observedCount: reported.observedCount,
      reflectedSeq: reported.reflectedSeq,
      updatedAt: reported.updatedAt
    },
    {
    observations: 1,
    activeObservations: 1,
    reflections: 0,
    dropped: 1,
    observedSeq: undefined,
    observedCount: 0,
    reflectedSeq: undefined,
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
  const usageMessages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] }]
  const agent = {
    options: {},
    session: {
      id: 'session-usage',
      deriveMessages: () => usageMessages,
      surface: { nodes: [1] },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } })
    }
  }
  ctx.agents = { get: (id) => (id === 'session-usage' ? agent : undefined) }
  // Nothing has been observed yet, so both anchors are absent and both clocks
  // read the whole conversation as unread-but-pending.
  const usageLedger = await (async () => (await import('../index.js')).emptyLedger('session-usage'))()

  const { call } = probeCaller(ctx)
  const result = (await call({ action: 'usage', sessionId: 'session-usage' })).payload.result
  assert.equal(result.kind, 'ok')
  assert.equal(result.context.usedTokens, 400000)
  assert.equal(result.context.thresholdTokens, 800000)
  assert.equal(result.context.retainedTokens, 160000)
  assert.equal(result.context.percent, 50, '400k of an 800k threshold')
  assert.equal(result.compact.percent, 50)
  // No reflection has ever run, so the whole conversation is flow it has not
  // reasoned over — not zero.
  assert.equal(result.reflect.pendingTokens, result.ledger.conversationTokens)
  assert.ok(result.reflect.percent > 0, 'the whole conversation is unreflected flow')
  assert.ok(result.observe.percent > 0, 'the backlog is measured against observeAfterTokens')
  assert.equal(result.ledger.coveragePercent, 0)
})

test('coverage is measured against the conversation, not the compaction threshold', async () => {
  // Regression: the widget divided the ledger's read total by the compaction
  // threshold. That answers "is the ledger big enough to stand in for the region
  // compaction would replace" — a real question, but a different one — and it
  // made the reading plateau in the seventies however caught up the reader was,
  // because the threshold is a trigger line, not the size of the conversation.
  const engine = fakeEngine(() => ({}))
  engine.config = { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16 }
  const ctx = fakeCtx({ compaction: engine })
  ctx.modelInfo = { context: { contextWindow: 1000000 }, defaultMaxTokens: 0 }
  ctx.tokenMeter = {
    measure: () => ({ totalTokens: 613850 }),
    // Price each message at a fixed 1000 tokens so the arithmetic is exact.
    estimateMessage: () => 1000
  }
  const messages = Array.from({ length: 614 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `m${index}` }]
  }))
  const agent = {
    options: {},
    session: {
      id: 'session-coverage-basis',
      deriveMessages: () => messages,
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } })
    }
  }
  ctx.agents = { get: (id) => (id === 'session-coverage-basis' ? agent : undefined) }
  const { call, runtime } = probeCaller(ctx)

  const ledger = await runtime.store.load('session-coverage-basis')
  // Read 600 of 614 messages: nearly caught up, though the ledger sits far below
  // the 800k compaction threshold.
  ledger.observedCount = 600
  ledger.observedTokens = 600000

  const result = (await call({ action: 'usage', sessionId: 'session-coverage-basis' })).payload.result
  assert.equal(result.context.thresholdTokens, 800000)
  assert.equal(result.ledger.conversationTokens, 614000, 'the conversation is priced like the watermark')
  assert.equal(result.ledger.coveragePercent, 98, '600k read of a 614k conversation')
  assert.equal(result.ledger.unreadTokens, 14000)

  // The threshold-based figure would have read 75%: the plateau this removes.
  assert.notEqual(result.ledger.coveragePercent, 75)
})

test('the reflect reading is the flow the reflector is scheduled on', async () => {
  // Regression: the widget reported the observation POOL against the reflect
  // threshold, but the reflector is scheduled on conversation that has flowed
  // past since the last reflection. The panel therefore sat at 100% while the
  // real trigger was untouched — a reading the scheduler never consults, and one
  // a reader had no way to tell apart from the real thing.
  const engine = fakeEngine(() => ({}))
  engine.config = { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16 }
  const ctx = fakeCtx({ compaction: engine })
  ctx.modelInfo = { context: { contextWindow: 1000000 }, defaultMaxTokens: 0 }
  // One token per message, so the flow arithmetic is exact and anchor-driven.
  ctx.tokenMeter = { measure: () => ({ totalTokens: 100000 }), estimateMessage: () => 1 }
  const flowMessages = Array.from({ length: 300 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `m${index}` }]
  }))
  const flowSeqs = flowMessages.map((_, index) => 500 + index)
  const agent = {
    options: {},
    session: {
      id: 'session-reflect-flow',
      deriveMessages: () => flowMessages,
      surface: { nodes: flowSeqs },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } })
    }
  }
  ctx.agents = { get: (id) => (id === 'session-reflect-flow' ? agent : undefined) }
  const { call, runtime } = probeCaller(ctx)

  // A big pool, but nothing new since the last reflection: the flow is zero.
  const ledger = await runtime.store.load('session-reflect-flow')
  for (let index = 0; index < 200; index += 1) {
    ledger.observations.push({
      id: memoryId('observation', `r${index}`),
      content: 'x'.repeat(400),
      timestamp: 't',
      relevance: 'medium',
      tokens: 100,
      evidence: ''
    })
  }
  // Both anchors rest on the last message: the observer is caught up, and the
  // reflector has already reasoned over everything the observer read.
  ledger.observedSeq = flowSeqs[flowSeqs.length - 1]
  ledger.observedCount = flowMessages.length
  ledger.reflectedSeq = flowSeqs[flowSeqs.length - 1]

  const caughtUp = (await call({ action: 'usage', sessionId: 'session-reflect-flow' })).payload.result
  assert.ok(caughtUp.reflect.activeTokens > 20000, 'the pool is large')
  assert.equal(caughtUp.reflect.pendingTokens, 0, 'but no conversation flowed past')
  assert.equal(caughtUp.reflect.percent, 0, 'so the reflector is not due, and the panel says so')

  // The reflection anchor falls behind the observation anchor: the reading tracks
  // that flow rather than the pool.
  ledger.reflectedSeq = flowSeqs[0]
  const behind = (await call({ action: 'usage', sessionId: 'session-reflect-flow' })).payload.result
  // 299 messages at one token each: 299 tokens of flow, which is 1% of the
  // 20,000 threshold. The point is that it tracked the FLOW — before the fix this
  // reading followed the observation pool and sat at 100%.
  assert.equal(behind.reflect.pendingTokens, 299, 'the flow since the last reflection')
  assert.equal(behind.reflect.percent, 1, '299 against a 20,000 threshold')
  assert.ok(behind.reflect.pendingTokens !== caughtUp.reflect.activeTokens, 'and it is not the pool')
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
  const ctx = fakeCtx({ replies: [JSON.stringify([{ content: 'probe recorded this', relevance: 'high', sourceSeqs: [1] }])] })
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

test('the running revision identifies itself, so a stale process is detectable', () => {
  // A workspace bundle is evaluated once per Host process. Without this, "my
  // edit is not live" and "my edit did not work" are the same observation.
  const first = runtimeFor(fakeCtx())
  assert.match(first.stats.buildId, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z·\d+b$/)
  assert.equal(buildId(), first.stats.buildId, 'every activation reports the same source identity')
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

// Regression cases from the coverage/concurrency review. No model or live
// session is needed: replacements happen deterministically inside the stream.
const textMessage = (text, role = 'user') => ({ role, content: [{ type: 'text', text }] })

for (const [label, reply] of [
  ['missing content', '[{}]'],
  ['null item', '[null]'],
  ['non-string content', '[{"content":42,"sourceSeqs":[1]}]'],
  ['blank content', '[{"content":"  ","sourceSeqs":[1]}]'],
  ['non-object item', '["not an observation"]'],
  ['invalid relevance', '[{"content":"a fact","relevance":"urgent","sourceSeqs":[1]}]'],
  ['mixed valid and invalid', '[{"content":"a fact","relevance":"high","sourceSeqs":[1]},{}]']
]) {
  test(`Observer rejects ${label} atomically without advancing coverage`, async () => {
    const runtime = runtimeFor(fakeCtx({ replies: [reply] }), { observeAfterTokens: 1 })
    const ledger = await runtime.store.load(`invalid-observer-${label.replaceAll(' ', '-')}`)
    const agent = fakeAgent(ledger.sessionId, [textMessage('Important constraint')])
    const outcome = await runObserver(runtime, agent, ledger)
    assert.match(outcome, /invalid/)
    assert.equal(ledger.observations.length, 0)
    assert.equal(ledger.observedSeq, undefined)
    assert.equal(ledger.observedCount, 0)
  })
}

test('an intentional empty Observer result can advance coverage', async () => {
  const runtime = runtimeFor(fakeCtx({ replies: ['[]'] }), { observeAfterTokens: 1 })
  const ledger = await runtime.store.load('observer-deliberate-empty')
  await runObserver(runtime, fakeAgent(ledger.sessionId, [textMessage('routine acknowledgement')]), ledger)
  assert.equal(ledger.observations.length, 0)
  assert.equal(ledger.observedSeq, 1)
  assert.equal(ledger.observedCount, 1)
})

test('conversationView snapshots sequences instead of borrowing mutable nodes', () => {
  const nodes = [1, 2, 3]
  const agent = fakeAgent('snapshot-view', [textMessage('A'), textMessage('B'), textMessage('C')], { seqs: nodes })
  const view = conversationView(runtimeFor(fakeCtx()), agent, emptyLedger(agent.session.id))
  nodes.splice(0, 2, 100)
  assert.deepEqual(view.seqs, [1, 2, 3])
})

test('a replacement during Observer completion cannot mark an unread tail covered', async () => {
  const nodes = [1, 2, 3]
  let messages = [textMessage('A'.repeat(40)), textMessage('B'.repeat(40)), textMessage('UNREAD C'.repeat(100))]
  const ctx = fakeCtx({ replies: [() => {
    nodes.splice(0, 2, 100)
    messages = [textMessage('summary A+B'), messages[2]]
    return '[{"content":"only A and B were read","relevance":"high","sourceSeqs":[1,2]}]'
  }] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 1, observerChunkMaxTokens: 24 })
  const ledger = await runtime.store.load('observer-replacement-race')
  const agent = fakeAgent(ledger.sessionId, messages, { seqs: nodes })
  agent.session.deriveMessages = () => messages
  const outcome = await runObserver(runtime, agent, ledger)
  assert.match(outcome, /surface changed/)
  assert.equal(ledger.observedSeq, undefined)
  assert.equal(ledger.observedCount, 0)
  assert.equal(ledger.observations.length, 0, 'a stale completion must not commit partially')
  assert.equal(conversationView(runtime, agent, ledger).pending.length, 2)
})

test('a projection rewrite with unchanged sequences invalidates Observer output', async () => {
  let messages = [textMessage('old result')]
  const ctx = fakeCtx({ replies: [() => {
    messages = [textMessage('rewritten result')]
    return '[{"content":"old result was observed","relevance":"high","sourceSeqs":[1]}]'
  }] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 1 })
  const ledger = await runtime.store.load('observer-content-rewrite')
  const agent = fakeAgent(ledger.sessionId, messages)
  agent.session.deriveMessages = () => messages
  assert.match(await runObserver(runtime, agent, ledger), /surface changed/)
  assert.equal(ledger.observedCount, 0)
  assert.equal(ledger.observations.length, 0)
})

test('append-only growth during an Observer call does not invalidate its read prefix', async () => {
  const nodes = [1]
  const messages = [textMessage('already read A')]
  const ctx = fakeCtx({ replies: [() => {
    nodes.push(2)
    messages.push(textMessage('unread B'))
    return '[{"content":"A was read","relevance":"medium","sourceSeqs":[1]}]'
  }] })
  const runtime = runtimeFor(ctx, { observeAfterTokens: 1 })
  const ledger = await runtime.store.load('observer-append-race')
  const agent = fakeAgent(ledger.sessionId, messages, { seqs: nodes })
  assert.match(await runObserver(runtime, agent, ledger), /recorded 1/)
  assert.equal(ledger.observedSeq, 1)
  assert.equal(ledger.observedCount, 1)
  assert.equal(conversationView(runtime, agent, ledger).pending.length, 1)
})

test('null-projected surface nodes do not shift Observer sequence alignment', async () => {
  const message = textMessage('a visible fact')
  const runtime = runtimeFor(fakeCtx({ replies: ['[{"content":"a visible fact","relevance":"high","sourceSeqs":[20]}]'] }), { observeAfterTokens: 1 })
  const ledger = await runtime.store.load('observer-null-node')
  const agent = fakeAgent(ledger.sessionId, [message], { seqs: [10, 20] })
  const sourceEvent = Object.freeze({ seq: 20, type: 'user/message', data: Object.freeze(structuredClone(message)) })
  agent.session.eventAt = (seq) => seq === 10 ? { seq, type: 'assistant/message', data: { message: null } } : sourceEvent
  agent.session.deriveEventMessage = (event) => event.seq === 10 ? null : event.data
  assert.equal(conversationView(runtime, agent, ledger).aligned, true)
  await runObserver(runtime, agent, ledger)
  assert.equal(ledger.observedSeq, 20)
  assert.deepEqual(ledger.observations[0].sourceSeqs, [20])
})

test('unknown sequence alignment refuses an Observer commit', async () => {
  const runtime = runtimeFor(fakeCtx({ replies: [] }), { observeAfterTokens: 1 })
  const ledger = await runtime.store.load('observer-unknown-alignment')
  const agent = fakeAgent(ledger.sessionId, [textMessage('important fact')], { seqs: [10, 20] })
  assert.match(await runObserver(runtime, agent, ledger), /alignment/)
  assert.equal(ledger.observedSeq, undefined)
  assert.equal(ledger.observedCount, 0)
})

test('compacting a shorter unread non-prefix region falls back despite a long covered prefix', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native B summary' }], llmStreamCall: true }))
  const runtime = runtimeFor(fakeCtx({ compaction: engine }))
  const ledger = await runtime.store.load('compact-unread-region')
  ledger.observedSeq = 10
  ledger.observedCount = 1
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'A only', timestamp: 't', relevance: 'high', evidence: '' })
  const messages = [textMessage('A'.repeat(20000)), textMessage('UNREAD B'.repeat(1000))]
  const agent = fakeAgent(ledger.sessionId, messages, { seqs: [10, 20] })
  installCompactionRenderer(runtime)
  const result = await engine.summarize({ messages: [messages[1]] }, agent)
  assert.equal(result.llmStreamCall, true)
  assert.equal(engine.calls, 1)
  assert.equal(runtime.stats.rendersSkippedUncovered, 1)
})

test('a uniquely addressed covered interior span can render memory', async () => {
  const engine = fakeEngine(() => { throw new Error('must not call native summarizer') })
  const runtime = runtimeFor(fakeCtx({ compaction: engine }))
  const ledger = await runtime.store.load('compact-covered-interior')
  const messages = [textMessage('A'), textMessage('B'.repeat(10000)), textMessage('unread C')]
  const agent = fakeAgent(ledger.sessionId, messages, { seqs: [100, 5, 9] })
  ledger.observedSeq = 5 // surface order, not numeric seq order
  ledger.observedCount = 2
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'B was observed', timestamp: 't', relevance: 'high', evidence: '' })
  installCompactionRenderer(runtime)
  const result = await engine.summarize({ messages: structuredClone([messages[1]]) }, agent)
  assert.equal(result.llmStreamCall, false)
  assert.equal(engine.calls, 0)
})

test('duplicate indistinguishable regions are refused rather than guessed', () => {
  const message = textMessage('same text')
  const messages = [message, structuredClone(message)]
  const runtime = runtimeFor(fakeCtx())
  const ledger = emptyLedger('ambiguous-region')
  ledger.observedSeq = 10
  const agent = fakeAgent(ledger.sessionId, messages, { seqs: [10, 20] })
  assert.equal(coversShadowedRegion(ledger, { messages: [message] }, conversationView(runtime, agent, ledger)), false)
})

test('a replayed system head is context, not evidence for an unread region', () => {
  const messages = [textMessage('system instructions', 'system'), textMessage('A'), textMessage('unread B')]
  const runtime = runtimeFor(fakeCtx())
  const ledger = emptyLedger('system-replayed')
  ledger.observedSeq = 20
  const agent = fakeAgent(ledger.sessionId, messages, { seqs: [10, 20, 30] })
  const view = conversationView(runtime, agent, ledger)
  assert.equal(coversShadowedRegion(ledger, { messages: [messages[0], messages[1]] }, view), true)
  assert.equal(coversShadowedRegion(ledger, { messages: [messages[0], messages[2]] }, view), false)
})

test('system-head size cannot make an oversized memory render seem smaller than the replaced region', async () => {
  const engine = fakeEngine(() => ({ summary: [{ type: 'text', text: 'native' }], llmStreamCall: true }))
  const runtime = runtimeFor(fakeCtx({ compaction: engine }))
  const ledger = await runtime.store.load('system-region-size')
  const messages = [textMessage('S'.repeat(40000), 'system'), textMessage('tiny region')]
  const agent = fakeAgent(ledger.sessionId, messages, { seqs: [10, 20] })
  ledger.observedSeq = 20
  ledger.observedCount = 2
  ledger.observations.push({ id: 'aaaaaaaaaaaa', content: 'a fact', timestamp: 't', relevance: 'high', evidence: '' })
  installCompactionRenderer(runtime)
  const result = await engine.summarize({ messages }, agent)
  assert.equal(result.llmStreamCall, true)
  assert.equal(runtime.stats.rendersSkippedUncovered, 0)
})

process.on('exit', () => {
  void rm(home, { recursive: true, force: true })
})
