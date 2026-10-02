/** Provenance contracts: projected Observer input is an index, never the raw source. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import * as mod from '../index.js'

const previousHome = process.env.DSH_HOME
const temporaryRoot = await realpath(tmpdir())
const home = await mkdtemp(join(temporaryRoot, 'om-provenance-'))
process.env.DSH_HOME = home

test.after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  // Resolve and verify the exact suite-owned target before recursive deletion.
  const target = await realpath(home)
  assert.equal(target, home)
  assert.equal(dirname(target), temporaryRoot)
  assert.ok(basename(target).startsWith('om-provenance-'))
  await rm(target, { recursive: true, force: true })
})

const OBS_ID = 'aaaaaaaaaaaa'
const SECOND_ID = 'bbbbbbbbbbbb'
const REF_ID = 'cccccccccccc'
const MISSING_ID = 'dddddddddddd'
const rawTime = Date.UTC(2026, 0, 1, 0, 0)
const message = (role, text) => ({ role, content: [{ type: 'text', text }] })

// These are RAW persisted SessionEvents. In particular user/message.data is
// itself a message; the other message-producing events wrap data.message.
function rawEvent(seq, type, originalMessage) {
  return {
    seq, time: rawTime + seq, type,
    data: type === 'user/message' ? originalMessage : { message: originalMessage }
  }
}

function rawSession(events = []) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const calls = []
  return {
    id: 'provenance-session', calls,
    eventAt(seq) { calls.push(seq); return bySeq.get(seq) },
    deriveMessages() { throw new Error('recall must not read the current surface projection') },
    deriveEventMessage() { throw new Error('recall must not project a raw event') },
    surface: { nodes: [] }
  }
}

function observation(id, sourceSeqs, content = 'A recorded fact') {
  return {
    id, content, timestamp: '2026-01-01 00:00', relevance: 'high', tokens: 5,
    ...(sourceSeqs === undefined ? {} : { sourceSeqs })
  }
}

function ledgerWith(...observations) {
  const ledger = mod.emptyLedger('provenance-session')
  ledger.observations.push(...observations)
  return ledger
}

function fakeCtx(replies = []) {
  const queue = [...replies]
  const requests = []
  const tools = []
  const llm = {
    async *stream(options) {
      requests.push(options)
      assert.ok(queue.length > 0, 'a memory call needs a scripted reply')
      const next = queue.shift()
      const text = typeof next === 'function' ? next(options) : next
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  return {
    requests, registered: { tools },
    tools: { register(definition) { tools.push(definition) } },
    logger: { info() {}, warn() {} },
    get(key) { return key === 'llm' ? llm : undefined }
  }
}

function observerFixture({ seqs = [123], messages = [message('user', 'A source fact worth remembering.')],
  reply = [{ content: 'A remembered fact', relevance: 'high', sourceSeqs: [123] }], config = {} } = {}) {
  const ctx = fakeCtx([typeof reply === 'string' ? reply : JSON.stringify(reply)])
  const runtime = mod.createRuntime(ctx, mod.resolveConfig({
    observeAfterTokens: 1, observerChunkMaxTokens: 100000, ...config
  }))
  const ledger = mod.emptyLedger('provenance-session')
  runtime.store.cache.set(ledger.sessionId, ledger)
  let saves = 0
  runtime.store.save = async () => { saves += 1 }
  const agent = {
    options: { provider: 'test-provider', model: 'test-model' },
    session: {
      id: ledger.sessionId, surface: { nodes: [...seqs] },
      deriveMessages: () => messages
    }
  }
  return { ctx, runtime, ledger, agent, get saves() { return saves } }
}

function assertDiagnostics(result, expected = {}) {
  assert.equal(typeof result?.then, 'undefined', 'recall remains synchronous')
  assert.equal(typeof result.kind, 'string')
  assert.equal(typeof result.text, 'string')
  for (const field of ['sourceSeqs', 'missingSourceSeqs', 'nonSourceSeqs', 'missingSupportingIds']) {
    assert.deepEqual(result[field], expected[field] ?? [], field)
  }
  if (expected.status !== undefined) assert.equal(result.status, expected.status)
}

const occurrences = (text, needle) => text.split(needle).length - 1

test('serializeSourceMessages exports rendered seq labels and keeps surface order', () => {
  assert.equal(typeof mod.serializeSourceMessages, 'function')
  const result = mod.serializeSourceMessages([
    message('user', 'First visible source.'),
    message('assistant', 'Second visible source.'),
    message('developer', 'Third visible source.')
  ], [30, 0, 7])
  assert.deepEqual(result.sourceSeqs, [30, 0, 7])
  for (const seq of [30, 0, 7]) assert.ok(result.text.includes(`[Source event seq: ${seq}]`))
  assert.ok(result.text.indexOf('First visible source.') < result.text.indexOf('Second visible source.'))
  assert.ok(result.text.indexOf('[Source event seq: 0]') < result.text.indexOf('[Source event seq: 7]'))
})

test('serializeSourceMessages only labels messages that actually render nonempty content', () => {
  assert.equal(typeof mod.serializeSourceMessages, 'function')
  const result = mod.serializeSourceMessages([
    null, { role: 'assistant', content: [] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'private thinking' }] },
    message('user', ''), message('user', 'Renderable source.')
  ], [10, 11, 12, 13, 14])
  assert.deepEqual(result.sourceSeqs, [14])
  assert.ok(result.text.includes('[Source event seq: 14]'))
  for (const seq of [10, 11, 12, 13]) assert.ok(!result.text.includes(`[Source event seq: ${seq}]`))
  assert.ok(!result.text.includes('private thinking'))
})

test('Observer requests sourceSeqs and stores references instead of copied chunk evidence', async () => {
  const fixture = observerFixture()
  await mod.runObserver(fixture.runtime, fixture.agent, fixture.ledger, undefined)
  assert.equal(fixture.ctx.requests.length, 1)
  const request = fixture.ctx.requests[0]
  assert.ok(request.messages[0].content[0].text.includes('[Source event seq: 123]'))
  assert.ok(request.system.includes('sourceSeqs'), 'the model must be told the new JSON contract')
  assert.equal(fixture.ledger.observations.length, 1)
  assert.deepEqual(fixture.ledger.observations[0].sourceSeqs, [123])
  assert.ok(!fixture.ledger.observations[0].evidence, 'new entries must not copy an excerpt of the entire chunk')
  assert.equal(fixture.ledger.observedSeq, 123)
  assert.equal(fixture.ledger.observedCount, 1)
  assert.equal(fixture.saves, 1)
})

test('invalid source references atomically reject the whole Observer batch', async (t) => {
  const cases = [
    ['missing', undefined], ['empty', []], ['invented', [999]],
    ['noninteger', [123.5]], ['string element', ['123']],
    ['mixed elements', [123, '123']], ['not an array', 123],
    ['negative', [-1]], ['unsafe integer', [Number.MAX_SAFE_INTEGER + 1]]
  ]
  for (const [name, refs] of cases) {
    await t.test(name, async () => {
      const invalid = { content: 'This must not be committed', relevance: 'high' }
      if (refs !== undefined) invalid.sourceSeqs = refs
      const fixture = observerFixture({
        seqs: [5, 123], messages: [message('user', 'Already observed.'), message('user', 'New source fact.')],
        reply: [{ content: 'Valid sibling must also be rejected', sourceSeqs: [123] }, invalid]
      })
      fixture.ledger.observedSeq = 5
      fixture.ledger.observedCount = 1
      fixture.ledger.observations.push(observation(OBS_ID, [5], 'Existing memory stays intact'))
      const before = structuredClone(fixture.ledger)
      await mod.runObserver(fixture.runtime, fixture.agent, fixture.ledger, undefined)
      assert.equal(fixture.ctx.requests.length, 1, 'the validation must run on a real model reply')
      assert.deepEqual(fixture.ledger, before, 'no observation or watermark may be partially committed')
      assert.equal(fixture.saves, 0)
    })
  }
})

test('a real surface seq outside the actual chunk is not a valid source reference', async () => {
  const fixture = observerFixture({
    seqs: [3, 8], messages: [message('user', 'first '.repeat(100)), message('user', 'second '.repeat(100))],
    reply: [{ content: 'Cites a source the Observer did not read', sourceSeqs: [8] }],
    config: { observerChunkMaxTokens: 1 }
  })
  const before = structuredClone(fixture.ledger)
  await mod.runObserver(fixture.runtime, fixture.agent, fixture.ledger)
  assert.ok(fixture.ctx.requests[0].messages[0].content[0].text.includes('[Source event seq: 3]'))
  assert.ok(!fixture.ctx.requests[0].messages[0].content[0].text.includes('[Source event seq: 8]'))
  assert.deepEqual(fixture.ledger, before)
  assert.equal(fixture.saves, 0)
})

test('an empty message in the chunk cannot be cited merely because it has a surface seq', async () => {
  const fixture = observerFixture({
    seqs: [4, 9], messages: [{ role: 'assistant', content: [] }, message('user', 'Visible source fact.')],
    reply: [{ content: 'Cites an unlabeled empty message', sourceSeqs: [4] }]
  })
  const before = structuredClone(fixture.ledger)
  await mod.runObserver(fixture.runtime, fixture.agent, fixture.ledger)
  const prompt = fixture.ctx.requests[0].messages[0].content[0].text
  assert.ok(!prompt.includes('[Source event seq: 4]'))
  assert.ok(prompt.includes('[Source event seq: 9]'))
  assert.deepEqual(fixture.ledger, before)
  assert.equal(fixture.saves, 0)
})

test('seq zero is valid in both Observer records and synchronous raw recall', async () => {
  const fixture = observerFixture({ seqs: [0], reply: [{ content: 'Zero is a real source seq', sourceSeqs: [0] }] })
  await mod.runObserver(fixture.runtime, fixture.agent, fixture.ledger)
  assert.deepEqual(fixture.ledger.observations[0]?.sourceSeqs, [0])
  assert.equal(fixture.ledger.observedSeq, 0)
  const session = rawSession([rawEvent(0, 'user/message', message('user', 'RAW_ZERO_SOURCE'))])
  const result = mod.recall(fixture.ledger, fixture.ledger.observations[0].id, session)
  assertDiagnostics(result, { status: 'ok', sourceSeqs: [0] })
  assert.ok(result.text.includes('RAW_ZERO_SOURCE'))
  assert.deepEqual(session.calls, [0])
})

test('Observer deduplicates multiple references in chunk surface order, not numeric or reply order', async () => {
  const fixture = observerFixture({
    seqs: [50, 3, 20], messages: [message('user', 'first'), message('assistant', 'second'), message('user', 'third')],
    reply: [{ content: 'Fact established across three sources', sourceSeqs: [20, 3, 50, 3, 20] }]
  })
  await mod.runObserver(fixture.runtime, fixture.agent, fixture.ledger)
  assert.deepEqual(fixture.ledger.observations[0]?.sourceSeqs, [50, 3, 20])
  assert.equal(fixture.ledger.observedSeq, 20)
})

test('recall recovers a cited tail fact beyond 4000 chars without unrelated chunk head evidence', async () => {
  const head = 'UNRELATED_CHUNK_HEAD ' + 'x'.repeat(4500)
  const tail = 'TAIL_FACT_EXACT: Reject retry because duplicate billing is forbidden.'
  const fixture = observerFixture({
    seqs: [11, 12], messages: [message('user', head), message('assistant', tail)],
    reply: [{ content: 'Duplicate billing forbids retry', sourceSeqs: [12] }]
  })
  await mod.runObserver(fixture.runtime, fixture.agent, fixture.ledger)
  const session = rawSession([
    rawEvent(11, 'user/message', message('user', head)),
    rawEvent(12, 'assistant/message', message('assistant', tail))
  ])
  const result = mod.recall(fixture.ledger, fixture.ledger.observations[0].id, session)
  assertDiagnostics(result, { status: 'ok', sourceSeqs: [12] })
  assert.ok(result.text.includes(tail))
  assert.ok(!result.text.includes('UNRELATED_CHUNK_HEAD'))
  assert.deepEqual(session.calls, [12])
})

test('raw recall supports each message-producing persisted event envelope', () => {
  const types = ['user/message', 'assistant/message', 'tool/result', 'developer/message', 'system/message']
  const roles = ['user', 'assistant', 'tool', 'developer', 'system']
  const seqs = [15, 2, 30, 1, 9]
  const events = types.map((type, index) => rawEvent(seqs[index], type, message(roles[index], `RAW_${index}_BODY`)))
  const result = mod.recall(ledgerWith(observation(OBS_ID, seqs)), OBS_ID, rawSession(events))
  assertDiagnostics(result, { status: 'ok', sourceSeqs: seqs })
  for (let index = 0; index < types.length; index += 1) assert.ok(result.text.includes(`RAW_${index}_BODY`))
  assert.ok(result.text.indexOf('RAW_0_BODY') < result.text.indexOf('RAW_1_BODY'))
})

test('drop tombstones and a compressed surface never prevent recall from the raw log', () => {
  const ledger = ledgerWith(observation(OBS_ID, [10], 'A now-dropped decision'))
  ledger.dropped.push(OBS_ID)
  const session = rawSession([rawEvent(10, 'user/message', message('user', 'ORIGINAL_DROPPED_REASON'))])
  session.surface.nodes = [900]
  session.deriveMessages = () => [message('user', 'Only compressed memory survives on the surface.')]
  assert.equal(mod.renderMemory(ledger), null)
  const result = mod.recall(ledger, OBS_ID, session)
  assert.equal(result.kind, 'observation-dropped')
  assertDiagnostics(result, { status: 'ok', sourceSeqs: [10] })
  assert.ok(result.text.includes('ORIGINAL_DROPPED_REASON'))
  assert.ok(!result.text.includes('Only compressed memory survives'))
})

test('changed projections cannot replace the original raw message during recall', () => {
  const ledger = ledgerWith(observation(OBS_ID, [24]))
  const session = rawSession([rawEvent(24, 'assistant/message', message('assistant', 'IMMUTABLE_RAW_ORIGINAL'))])
  session.surface.nodes = [24]
  session.deriveMessages = () => [message('assistant', 'MUTATED_PROJECTED_TEXT')]
  session.deriveEventMessage = () => message('assistant', 'MUTATED_PROJECTED_TEXT')
  const result = mod.recall(ledger, OBS_ID, session)
  assertDiagnostics(result, { status: 'ok', sourceSeqs: [24] })
  assert.ok(result.text.includes('IMMUTABLE_RAW_ORIGINAL'))
  assert.ok(!result.text.includes('MUTATED_PROJECTED_TEXT'))
})

test('raw recall preserves complete long text, tool-call arguments, and tool results', () => {
  const fullText = 'LONG_RAW_START ' + 't'.repeat(5000) + ' LONG_RAW_TEXT_TAIL'
  const fullArguments = JSON.stringify({ path: 'source.js', payload: 'a'.repeat(6000), exact: 'ARGUMENT_TAIL_REQUIRED' })
  const fullResult = 'r'.repeat(6000) + ' TOOL_RESULT_TAIL_REQUIRED'
  const events = [
    rawEvent(1, 'assistant/message', {
      role: 'assistant', content: [
        { type: 'text', text: fullText },
        { type: 'tool-call', id: 'call-1', name: 'write', arguments: fullArguments }
      ]
    }),
    rawEvent(2, 'tool/result', {
      role: 'tool', toolCallId: 'call-1', isError: false,
      source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: fullResult }]
    })
  ]
  const result = mod.recall(ledgerWith(observation(OBS_ID, [1, 2])), OBS_ID, rawSession(events))
  assertDiagnostics(result, { status: 'ok', sourceSeqs: [1, 2] })
  assert.ok(result.text.includes(fullText), 'text must not use EVIDENCE_MAX_CHARS')
  assert.ok(result.text.includes(fullArguments), 'arguments must not use the prompt serializer truncation')
  assert.ok(result.text.includes(fullResult), 'tool output is also original evidence')
})

test('image and file raw blocks are honest metadata placeholders, never decoded binary claims', () => {
  // The Host persists attachment references, not image bytes or projected text.
  const imageAttachmentId = 'sha256:' + 'a'.repeat(64)
  const fileAttachmentId = 'sha256:' + 'b'.repeat(64)
  const original = {
    role: 'user', content: [
      { type: 'text', text: 'Attached image and report.' },
      { type: 'image', attachment: { attachmentId: imageAttachmentId, mediaType: 'image/png',
        bytes: 999, width: 640, height: 480, name: 'reference.png' } },
      { type: 'file', attachment: { attachmentId: fileAttachmentId, name: 'report.pdf', bytes: 888 } }
    ]
  }
  const result = mod.recall(ledgerWith(observation(OBS_ID, [6])), OBS_ID,
    rawSession([rawEvent(6, 'user/message', original)]))
  assertDiagnostics(result, { status: 'ok', sourceSeqs: [6] })
  assert.match(result.text, /image|图像|图片/i)
  assert.match(result.text, /file|文件/i)
  assert.ok(result.text.includes('image/png'))
  assert.ok(result.text.includes('report.pdf'))
  assert.match(result.text, /metadata|元数据|not (?:read|decoded)|未(?:读|解码)|placeholder|占位/i)
  assert.ok(result.text.includes('reference.png'))
  assert.ok(result.text.includes(imageAttachmentId))
  assert.ok(result.text.includes(fileAttachmentId))
})

test('some missing or non-message sources report partial with separate diagnostic arrays', () => {
  const session = rawSession([
    rawEvent(7, 'user/message', message('user', 'ONE_AVAILABLE_ORIGINAL')),
    { seq: 9, time: rawTime, type: 'agent/config', data: { text: 'NOT_A_MESSAGE_SOURCE' } }
  ])
  const result = mod.recall(ledgerWith(observation(OBS_ID, [7, 8, 9])), OBS_ID, session)
  assertDiagnostics(result, { status: 'partial', sourceSeqs: [7, 8, 9], missingSourceSeqs: [8], nonSourceSeqs: [9] })
  assert.ok(result.text.includes('ONE_AVAILABLE_ORIGINAL'))
  assert.ok(!result.text.includes('NOT_A_MESSAGE_SOURCE'))
})

test('all missing, non-message, or throwing eventAt sources are source_unavailable, never ok', () => {
  const ledger = ledgerWith(observation(OBS_ID, [4, 5]))
  const absent = mod.recall(ledger, OBS_ID, rawSession())
  assertDiagnostics(absent, { status: 'source_unavailable', sourceSeqs: [4, 5], missingSourceSeqs: [4, 5] })
  const withoutSession = mod.recall(ledger, OBS_ID)
  assertDiagnostics(withoutSession, { status: 'source_unavailable', sourceSeqs: [4, 5], missingSourceSeqs: [4, 5] })
  const withoutEventAt = mod.recall(ledger, OBS_ID, { id: ledger.sessionId })
  assertDiagnostics(withoutEventAt, { status: 'source_unavailable', sourceSeqs: [4, 5], missingSourceSeqs: [4, 5] })
  const nonMessage = mod.recall(ledger, OBS_ID, rawSession([
    { seq: 4, time: rawTime, type: 'agent/config', data: { text: 'fake source' } }
  ]))
  assertDiagnostics(nonMessage, { status: 'source_unavailable', sourceSeqs: [4, 5], missingSourceSeqs: [5], nonSourceSeqs: [4] })
  const throwing = rawSession()
  throwing.eventAt = () => { throw new Error('raw log unavailable') }
  let failedLookup
  assert.doesNotThrow(() => { failedLookup = mod.recall(ledger, OBS_ID, throwing) })
  assertDiagnostics(failedLookup, { status: 'source_unavailable', sourceSeqs: [4, 5], missingSourceSeqs: [4, 5] })
})

test('a throwing lookup does not discard another successfully recovered raw source', () => {
  const session = rawSession([rawEvent(2, 'system/message', message('system', 'RAW_STILL_AVAILABLE'))])
  const eventAt = session.eventAt.bind(session)
  session.eventAt = (seq) => { if (seq === 1) throw new Error('one broken event'); return eventAt(seq) }
  const result = mod.recall(ledgerWith(observation(OBS_ID, [1, 2])), OBS_ID, session)
  assertDiagnostics(result, { status: 'partial', sourceSeqs: [1, 2], missingSourceSeqs: [1] })
  assert.ok(result.text.includes('RAW_STILL_AVAILABLE'))
})

test('reflection recall expands dropped supporting observations and deduplicates shared raw seqs', () => {
  const ledger = ledgerWith(observation(OBS_ID, [30, 4]), observation(SECOND_ID, [4, 8]))
  ledger.dropped.push(OBS_ID)
  ledger.reflections.push({ id: REF_ID, content: 'A durable conclusion', supportingIds: [OBS_ID, SECOND_ID, OBS_ID], tokens: 4 })
  const sharedBody = 'SHARED_RAW_BODY ' + 's'.repeat(4500) + ' SHARED_RAW_TAIL'
  const session = rawSession([
    rawEvent(30, 'user/message', message('user', 'FIRST_SUPPORT_RAW')),
    rawEvent(4, 'assistant/message', message('assistant', sharedBody)),
    rawEvent(8, 'developer/message', message('developer', 'LAST_SUPPORT_RAW'))
  ])
  const result = mod.recall(ledger, REF_ID, session)
  assert.equal(result.kind, 'reflection')
  assertDiagnostics(result, { status: 'ok', sourceSeqs: [30, 4, 8] })
  assert.ok(result.text.includes('FIRST_SUPPORT_RAW'))
  assert.ok(result.text.includes(sharedBody))
  assert.ok(result.text.includes('LAST_SUPPORT_RAW'))
  assert.equal(occurrences(result.text, 'SHARED_RAW_BODY'), 1, 'a shared original is rendered only once')
  assert.deepEqual(session.calls, [30, 4, 8], 'shared seqs are also fetched only once')
})

test('reflection recall reports missing supporting ids and missing source seqs independently', () => {
  const ledger = ledgerWith(observation(OBS_ID, [2, 3]))
  ledger.reflections.push({ id: REF_ID, content: 'A conclusion with incomplete support',
    supportingIds: [OBS_ID, MISSING_ID, MISSING_ID], tokens: 4 })
  const result = mod.recall(ledger, REF_ID,
    rawSession([rawEvent(2, 'user/message', message('user', 'SURVIVING_REFLECTION_SUPPORT'))]))
  assertDiagnostics(result, { status: 'partial', sourceSeqs: [2, 3], missingSourceSeqs: [3], missingSupportingIds: [MISSING_ID] })
  assert.ok(result.text.includes('SURVIVING_REFLECTION_SUPPORT'))
})

test('legacy evidence remains readable but is explicitly not an exact historical source', () => {
  const old = { ...observation(OBS_ID), evidence: 'LEGACY_BATCH_EXCERPT' }
  const ledger = ledgerWith(old)
  ledger.observedSeq = 700
  ledger.observedCount = 100
  const session = rawSession([rawEvent(700, 'user/message', message('user', 'WATERMARK_IS_NOT_A_SOURCE'))])
  const result = mod.recall(ledger, OBS_ID, session)
  assertDiagnostics(result, { status: 'legacy' })
  assert.ok(result.text.includes('LEGACY_BATCH_EXCERPT'))
  assert.match(result.text, /not (?:an? )?exact|not (?:a )?precise|inexact|非精确|不(?:是|代表).{0,12}(?:精确|准确)|不能.{0,12}(?:精确|准确)/i)
  assert.ok(!result.text.includes('WATERMARK_IS_NOT_A_SOURCE'))
  assert.deepEqual(session.calls, [], 'observedSeq cannot manufacture evidence refs')
})

test('no_source and missing distinguish unbacked records from unknown memory ids', () => {
  const ledger = ledgerWith(observation(OBS_ID, []), observation(SECOND_ID))
  const session = rawSession()
  assertDiagnostics(mod.recall(ledger, OBS_ID, session), { status: 'no_source' })
  assertDiagnostics(mod.recall(ledger, SECOND_ID, session), { status: 'legacy' })
  const missing = mod.recall(ledger, MISSING_ID, session)
  assert.equal(missing.kind, 'missing')
  assertDiagnostics(missing, { status: 'missing' })
  assert.deepEqual(session.calls, [])
})

test('normalizeLedger and JSON roundtrip retain source refs, order, seq0, and legacy evidence', () => {
  const ledger = ledgerWith(observation(OBS_ID, [30, 0, 4]), { ...observation(SECOND_ID), evidence: 'LEGACY_PERSISTED_EXCERPT' })
  ledger.dropped.push(OBS_ID)
  ledger.reflections.push({ id: REF_ID, content: 'Stable memory', supportingIds: [OBS_ID], tokens: 3 })
  const normalized = mod.normalizeLedger(ledger.sessionId, JSON.parse(JSON.stringify(ledger)))
  assert.deepEqual(normalized.observations[0].sourceSeqs, [30, 0, 4])
  assert.equal(normalized.observations[1].evidence, 'LEGACY_PERSISTED_EXCERPT')
  assert.ok(!normalized.observations[1].sourceSeqs?.length, 'legacy watermark migration must not invent sources')
  assert.deepEqual(normalized.reflections[0].supportingIds, [OBS_ID])
  assert.deepEqual(normalized.dropped, [OBS_ID])
})

test('LedgerStore disk persistence reloads sourceSeqs without losing dropped reflection support', async () => {
  const id = 'provenance-roundtrip'
  const dir = join(home, 'sessions', 'test-workspace', id)
  await mkdir(dir, { recursive: true })
  const store = new mod.LedgerStore()
  const ledger = await store.load(id)
  ledger.observations.push(observation(OBS_ID, [18, 0, 5]))
  ledger.dropped.push(OBS_ID)
  ledger.reflections.push({ id: REF_ID, content: 'Persisted reflection', supportingIds: [OBS_ID], tokens: 3 })
  await store.save(id)
  await store.drain()
  const onDisk = JSON.parse(await readFile(join(dir, mod.LEDGER_FILENAME), 'utf8'))
  assert.deepEqual(onDisk.observations[0].sourceSeqs, [18, 0, 5])
  const loaded = await new mod.LedgerStore().load(id)
  assert.deepEqual(loaded.observations[0].sourceSeqs, [18, 0, 5])
  const session = rawSession([
    rawEvent(18, 'user/message', message('user', 'PERSISTED_SOURCE_FIRST')),
    rawEvent(0, 'system/message', message('system', 'PERSISTED_SOURCE_ZERO')),
    rawEvent(5, 'assistant/message', message('assistant', 'PERSISTED_SOURCE_LAST'))
  ])
  session.id = id
  const result = mod.recall(loaded, REF_ID, session)
  assertDiagnostics(result, { status: 'ok', sourceSeqs: [18, 0, 5] })
  assert.ok(result.text.includes('PERSISTED_SOURCE_ZERO'))
})

test('recall never resolves same-numbered source sequences from another session', () => {
  const session = rawSession([rawEvent(7, 'user/message', message('user', 'OTHER_SESSION_SECRET'))])
  session.id = 'another-session'
  const result = mod.recall(ledgerWith(observation(OBS_ID, [7])), OBS_ID, session)
  assertDiagnostics(result, { status: 'source_unavailable', sourceSeqs: [7], missingSourceSeqs: [7] })
  assert.deepEqual(session.calls, [])
  assert.ok(!result.text.includes('OTHER_SESSION_SECRET'))
})

test('a lookup returning a different event identity is not accepted as evidence', () => {
  const session = rawSession()
  session.eventAt = () => rawEvent(99, 'user/message', message('user', 'WRONG_EVENT_BODY'))
  const result = mod.recall(ledgerWith(observation(OBS_ID, [7])), OBS_ID, session)
  assertDiagnostics(result, { status: 'source_unavailable', sourceSeqs: [7], missingSourceSeqs: [7] })
  assert.ok(!result.text.includes('WRONG_EVENT_BODY'))
})

test('an event with the wrong message role is reported as a non-source', () => {
  const session = rawSession([rawEvent(7, 'user/message', message('assistant', 'MALFORMED_MESSAGE_BODY'))])
  const result = mod.recall(ledgerWith(observation(OBS_ID, [7])), OBS_ID, session)
  assertDiagnostics(result, { status: 'source_unavailable', sourceSeqs: [7], nonSourceSeqs: [7] })
  assert.ok(!result.text.includes('MALFORMED_MESSAGE_BODY'))
})

test('a reflection mixing exact and legacy support is explicitly partial', () => {
  const old = { ...observation(SECOND_ID), evidence: 'NONEXACT_LEGACY_PIECE' }
  const ledger = ledgerWith(observation(OBS_ID, [7]), old)
  ledger.reflections.push({ id: REF_ID, content: 'Mixed provenance conclusion', supportingIds: [OBS_ID, SECOND_ID] })
  const result = mod.recall(ledger, REF_ID, rawSession([rawEvent(7, 'user/message', message('user', 'EXACT_SOURCE_BODY'))]))
  assertDiagnostics(result, { status: 'partial', sourceSeqs: [7] })
  assert.ok(result.text.includes('EXACT_SOURCE_BODY'))
  assert.ok(result.text.includes('NONEXACT_LEGACY_PIECE'))
  assert.match(result.text, /not exact evidence/i)
})

test('malformed imported references fail closed without using a cached excerpt as exact evidence', () => {
  const parsed = ledgerWith({ ...observation(OBS_ID, [7, 'bad']), evidence: 'UNTRUSTED_CACHED_EXCERPT' })
  const normalized = mod.normalizeLedger(parsed.sessionId, parsed)
  assert.deepEqual(normalized.observations[0].sourceSeqs, [])
  const session = rawSession([rawEvent(7, 'user/message', message('user', 'UNRESOLVED_RAW_BODY'))])
  const result = mod.recall(normalized, OBS_ID, session)
  assertDiagnostics(result, { status: 'no_source' })
  assert.deepEqual(session.calls, [])
  assert.ok(!result.text.includes('UNTRUSTED_CACHED_EXCERPT'))
})

test('registered recall tool passes the owning raw session and exposes diagnostic output fields', async () => {
  const ctx = fakeCtx()
  const runtime = mod.createRuntime(ctx, mod.resolveConfig({ passive: true }))
  const ledger = ledgerWith(observation(OBS_ID, [42]))
  runtime.store.cache.set(ledger.sessionId, ledger)
  const session = rawSession([rawEvent(42, 'user/message', message('user', 'TOOL_RAW_SOURCE'))])
  mod.registerRecallTool(runtime)
  const tool = ctx.registered.tools.find((definition) => definition.name === 'recall')
  assert.ok(tool)
  const result = await tool.execute({ id: OBS_ID }, { agent: { session } })
  assertDiagnostics(result, { status: 'ok', sourceSeqs: [42] })
  assert.ok(result.text.includes('TOOL_RAW_SOURCE'))
  assert.deepEqual(session.calls, [42])
  const fields = tool.output.schema.properties
  for (const field of ['status', 'sourceSeqs', 'missingSourceSeqs', 'nonSourceSeqs', 'missingSupportingIds']) {
    assert.ok(fields[field], `tool output schema must allow ${field}`)
  }
})
