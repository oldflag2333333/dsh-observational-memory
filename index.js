/**
 * Host half of the observational-memory bundle.
 *
 * Long Harness sessions lose their thread the same way every long agent session
 * does: history is condensed, then the condensation is condensed, and the
 * rationale behind decisions — why an approach was rejected, which constraint
 * was hard, what the user already clarified — is the first thing to go. This
 * plugin ports the observational-memory model (Mastra's research; the Pi
 * extension `pi-observational-memory` V3) onto the Harness:
 *
 *   1. **Observation ledger.** Background Observer and Reflector agents distil
 *      the session into timestamped, source-backed observations and durable
 *      reflections, stored per session in a plugin-owned durable file.
 *   2. **Deterministic compaction.** `compaction`'s `summarize()` hook renders
 *      that ledger with no model call at all, so condensation becomes a
 *      rendering step instead of a summarization event. An empty projection
 *      delegates to the shipped LLM summarizer, so memory never *replaces*
 *      context with nothing.
 *   3. **Source-backed recall.** Every observation carries an id and the source
 *      text it came from, and the `recall` tool reads either back — memory is an
 *      index into evidence, not a claim you have to trust.
 *
 * Two deliberate deviations from the Pi original, both forced by this host:
 *
 * - **The ledger is not a session event.** Out-of-repo plugin events are
 *   supported only through the persisted `SessionEvent.ignorable` envelope
 *   marker, which `session.append()` does not accept, so a plugin cannot write
 *   its own log-only event type. The ledger therefore lives in its own durable
 *   store keyed by session id. Consequence: memory is per session and is *not*
 *   branch-local — a forked session shares its parent's memory.
 * - **Compaction is wrapped, not subclassed.** A workspace bundle has no
 *   `node_modules`, so importing `@deepseek-ai/dsh-compaction-basic` to extend
 *   `BasicCompactionEngine` fails at activation. The live engine is wrapped
 *   instead: `summarize()` — the contract's documented sole subclass hook — is
 *   replaced on that one instance and restored on dispose.
 *
 * This file uses Node builtins and runtime services only, for the same reason.
 */

import { createHash } from 'node:crypto'
import { appendFile, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'observational-memory'

/** Core services this plugin needs before it can register anything. */
export const inject = ['tools', 'commands']

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Defaults follow the Pi V3 shape where the concept is the same. Token counts
 * are *estimated* with the harness's own fixed density heuristic (the token
 * meter prices text at 4 characters per token), so these numbers mean the same
 * thing as the ones `ctx.tokenMeter` reports for the same text.
 */
const DEFAULTS = Object.freeze({
  /** Estimated tokens of unobserved conversation before an Observer run. */
  observeAfterTokens: 10000,
  /** Estimated tokens of active observations before a Reflector run. */
  reflectAfterTokens: 20000,
  /** Estimated tokens of active observations that triggers pruning after a reflection. */
  observationsPoolMaxTokens: 20000,
  /** Maximum estimated tokens serialized into one Observer request. */
  observerChunkMaxTokens: 12000,
  /** Output-token ceiling requested for each memory-agent run. */
  maxTokens: 4096,
  /** Optional memory-worker model override: `{ provider, model }`. */
  model: undefined,
  /** Disable all background memory work; an existing ledger still renders. */
  passive: false,
  /** Write one NDJSON line per memory-agent run under `storages/observational-memory/debug/`. */
  debugLog: false,
  /** Observe only root agents, skipping subagent sessions. */
  rootAgentsOnly: true
})

/** Estimated characters per token, matching the harness estimate heuristic. */
const CHARS_PER_TOKEN = 4

/** Upper bound on the source excerpt retained per observation for `recall`. */
const EVIDENCE_MAX_CHARS = 4000

/** Upper bound on how much ledger text one compaction checkpoint will carry. */
const RENDER_MAX_CHARS = 60000

/**
 * Resolve user configuration over the defaults, ignoring unknown or invalid
 * keys rather than failing activation: a memory plugin should never be the
 * reason a profile will not boot.
 * @param raw - the loader entry's config object, when present.
 * @returns resolved configuration.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const positive = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  const model = input.model
  const hasModel =
    model !== null &&
    typeof model === 'object' &&
    typeof model.provider === 'string' &&
    typeof model.model === 'string'
  return {
    observeAfterTokens: positive(input.observeAfterTokens, DEFAULTS.observeAfterTokens),
    reflectAfterTokens: positive(input.reflectAfterTokens, DEFAULTS.reflectAfterTokens),
    observationsPoolMaxTokens: positive(input.observationsPoolMaxTokens, DEFAULTS.observationsPoolMaxTokens),
    observerChunkMaxTokens: positive(input.observerChunkMaxTokens, DEFAULTS.observerChunkMaxTokens),
    maxTokens: positive(input.maxTokens, DEFAULTS.maxTokens),
    model: hasModel ? { provider: model.provider, model: model.model } : undefined,
    passive: input.passive === true,
    debugLog: input.debugLog === true,
    rootAgentsOnly: input.rootAgentsOnly !== false
  }
}

// ---------------------------------------------------------------------------
// Identity and measurement
// ---------------------------------------------------------------------------

/**
 * Deterministic 12-character lowercase hex identity, so the same content at the
 * same moment always yields the same id and a replay cannot mint a new one.
 * @param kind - namespace separating observation and reflection id spaces.
 * @param body - content plus any discriminator that must affect identity.
 * @returns the id string.
 */
export function memoryId(kind, body) {
  return createHash('sha256').update(`${kind}\u0000${body}`).digest('hex').slice(0, 12)
}

/**
 * Fixed-density token estimate shared with the harness estimator.
 * @param text - text to price.
 * @returns estimated tokens, never negative.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * `YYYY-MM-DD HH:MM` in local time, the shape the ledger renders.
 * @param date - moment to render.
 * @returns the timestamp string.
 */
function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

// ---------------------------------------------------------------------------
// Durable ledger store
// ---------------------------------------------------------------------------

/** Harness config root, resolved the way `@deepseek-ai/dsh-home-paths` does. */
function dshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/** Session ids are backend-generated; this pattern also blocks path traversal. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * File name of the ledger inside a session's own directory.
 *
 * The ledger lives beside the session log (`session.v4.jsonl.zstd`,
 * `session.lock`, …) rather than in a plugin-private store, because a session's
 * durable footprint is then exactly one directory. `dsh-session-removal`
 * already deletes that directory recursively, so memory is removed with the
 * session by construction — no registry of per-session plugin stores, and no
 * orphan left behind when the two disagree.
 */
export const LEDGER_FILENAME = 'observational-memory.json'

/**
 * Resolve a session's own directory.
 *
 * Discovered by scanning the session root, never derived from the session id:
 * the backend's project-key encoding and generation filenames are internal and
 * versioned (the log has already moved through v1→v4), and a plugin must not
 * reimplement them. Returns `null` when no directory exists yet.
 * @param sessionId - owning session.
 * @param cached - optional per-session directory cache to consult and fill.
 * @returns the absolute directory, or `null`.
 */
export async function resolveSessionDir(sessionId, cached) {
  const hit = cached?.get(sessionId)
  if (hit !== undefined) return hit
  const found = await findSessionLogDirs(dshHome(), sessionId)
  if (found.length === 0) return null
  cached?.set(sessionId, found[0])
  return found[0]
}

/** One empty ledger for a session. */
export function emptyLedger(sessionId) {
  return {
    version: 1,
    sessionId,
    observations: [],
    reflections: [],
    dropped: [],
    observedCount: 0,
    /**
     * Estimated tokens of conversation the observer has ever read. Monotonic:
     * observations are never deleted (drops are tombstones), so this is the size
     * of the history the ledger can actually describe. It is what licenses the
     * deterministic render — see `coversShadowedRegion`.
     */
    observedTokens: 0,
    reflectedObservationTokens: 0,
    updatedAt: new Date().toISOString()
  }
}

/** Coerce a parsed ledger back into the current shape, dropping anything unknown. */
export function normalizeLedger(sessionId, parsed) {
  const base = emptyLedger(sessionId)
  if (parsed === null || typeof parsed !== 'object') return base
  const list = (value) => (Array.isArray(value) ? value : [])
  const observations = list(parsed.observations)
    .filter(
      (item) =>
        item !== null && typeof item === 'object' && typeof item.id === 'string' && typeof item.content === 'string'
    )
    .map((item) => ({
      id: item.id,
      content: item.content,
      timestamp: typeof item.timestamp === 'string' ? item.timestamp : stamp(new Date()),
      relevance: ['low', 'medium', 'high', 'critical'].includes(item.relevance) ? item.relevance : 'medium',
      tokens: Number.isFinite(item.tokens) ? item.tokens : estimateTokens(item.content),
      evidence: typeof item.evidence === 'string' ? item.evidence : ''
    }))
  const reflections = list(parsed.reflections)
    .filter(
      (item) =>
        item !== null && typeof item === 'object' && typeof item.id === 'string' && typeof item.content === 'string'
    )
    .map((item) => ({
      id: item.id,
      content: item.content,
      supportingIds: list(item.supportingIds).filter((id) => typeof id === 'string'),
      tokens: Number.isFinite(item.tokens) ? item.tokens : estimateTokens(item.content)
    }))
  return {
    ...base,
    observations,
    reflections,
    dropped: list(parsed.dropped).filter((id) => typeof id === 'string'),
    observedCount: Number.isInteger(parsed.observedCount) && parsed.observedCount >= 0 ? parsed.observedCount : 0,
    observedTokens: Number.isFinite(parsed.observedTokens) && parsed.observedTokens >= 0 ? parsed.observedTokens : 0,
    reflectedObservationTokens: Number.isFinite(parsed.reflectedObservationTokens)
      ? parsed.reflectedObservationTokens
      : 0
  }
}

/**
 * In-memory ledgers plus their write chain.
 *
 * Reads are served from memory so the compaction hook — which should not block
 * on disk — sees the latest accepted state; writes are serialized per session
 * and atomic (temp file plus rename), so a crash mid-write cannot truncate a
 * ledger.
 */
export class LedgerStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.cache = new Map()
    /** @type {Map<string, Promise<void>>} */
    this.writes = new Map()
    /** @type {Map<string, string>} resolved session directories */
    this.dirs = new Map()
    /** Writes skipped because the session has no directory yet. */
    this.deferredWrites = 0
  }

  /**
   * Load one session's ledger, from cache or from the session's directory. A
   * missing or corrupt file reads as an empty ledger: lost memory must never
   * block a session.
   * @param sessionId - owning session.
   * @returns the ledger (shared and mutable).
   */
  async load(sessionId) {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached
    let ledger = emptyLedger(sessionId)
    const dir = await resolveSessionDir(sessionId, this.dirs)
    if (dir !== null) {
      try {
        const raw = await readFile(join(dir, LEDGER_FILENAME), 'utf8')
        ledger = normalizeLedger(sessionId, JSON.parse(raw))
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn(`observational-memory: ledger read failed for ${sessionId}: ${String(error)}`)
        }
      }
    }
    this.cache.set(sessionId, ledger)
    return ledger
  }

  /**
   * Persist one session's ledger, serialized behind any in-flight write.
   *
   * The write never creates the session directory. A directory that is absent
   * means the session has not been persisted (or has just been deleted), and
   * creating one here would manufacture a phantom session that every reader —
   * including the deletion path — would then treat as real. The write is
   * deferred instead; the in-memory ledger keeps serving this process.
   * @param sessionId - owning session.
   * @returns a promise settling after this write.
   */
  save(sessionId) {
    const ledger = this.cache.get(sessionId)
    if (ledger === undefined) return Promise.resolve()
    const previous = this.writes.get(sessionId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        const dir = await resolveSessionDir(sessionId, this.dirs)
        if (dir === null) {
          this.deferredWrites += 1
          return
        }
        ledger.updatedAt = new Date().toISOString()
        const path = join(dir, LEDGER_FILENAME)
        const temp = `${path}.${process.pid}.tmp`
        await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`)
        await rename(temp, path)
      })
      .catch((error) => {
        console.warn(`observational-memory: ledger write failed for ${sessionId}: ${String(error)}`)
      })
      .finally(() => {
        if (this.writes.get(sessionId) === next) this.writes.delete(sessionId)
      })
    this.writes.set(sessionId, next)
    return next
  }

  /**
   * Await every pending write.
   * @returns a promise settling after all queued writes.
   */
  async drain() {
    await Promise.allSettled([...this.writes.values()])
  }
}

/** Whether a path exists. */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Every session directory for one id, across all workspace keys — the same scan
 * `dsh-session-removal` performs, so both agree on where a session lives.
 * @param root - harness config root.
 * @param sessionId - session to look for.
 * @returns matching directories.
 */
export async function findSessionLogDirs(root, sessionId) {
  const sessionsRoot = join(root, 'sessions')
  let entries
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(sessionsRoot, entry.name, sessionId)
    if (await exists(candidate)) found.push(candidate)
  }
  return found
}

// ---------------------------------------------------------------------------
// Ledger projections
// ---------------------------------------------------------------------------

/**
 * Observations still in active memory. Dropping is a tombstone: history stays in
 * the ledger, so `recall` can still recover a dropped observation by id.
 * @param ledger - session ledger.
 * @returns active observations in record order.
 */
export function activeObservations(ledger) {
  const dropped = new Set(ledger.dropped)
  return ledger.observations.filter((observation) => !dropped.has(observation.id))
}

/**
 * Total estimated tokens of active observations.
 * @param ledger - session ledger.
 * @returns token sum.
 */
export function activeObservationTokens(ledger) {
  return activeObservations(ledger).reduce((total, observation) => total + observation.tokens, 0)
}

/**
 * Render the ledger into the checkpoint body the model will see.
 *
 * This is the whole point of the port: the text is assembled from records, not
 * generated, so condensation costs no model call and no coherence is lost to
 * re-summarization. The preamble and the trailing `recall` instruction are the
 * agent-facing contract, so they belong to the rendering rather than to a prompt.
 * @param ledger - session ledger.
 * @returns the rendered memory, or `null` when the projection is empty.
 */
export function renderMemory(ledger) {
  const observations = activeObservations(ledger)
  const reflections = ledger.reflections
  if (observations.length === 0 && reflections.length === 0) return null

  /**
   * Compose the memory text, optionally eliding the oldest observations.
   * @param kept - observations to render, newest last.
   * @param elided - how many older observations were dropped.
   */
  const compose = (kept, elided) => {
    const lines = [
      'These are condensed memories from earlier in this session.',
      '',
      '- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. Reflection lines include ids in brackets.',
      '- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.',
      '',
      'Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.',
      '',
      'When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. Do not use recall as broad search.'
    ]
    if (reflections.length > 0) {
      lines.push('', '## Reflections')
      for (const reflection of reflections) lines.push(`[${reflection.id}] ${reflection.content}`)
    }
    if (kept.length > 0) {
      lines.push('', '## Observations')
      if (elided > 0) {
        lines.push(`[${elided} older observation(s) elided to stay within the memory budget; recall any id you still hold]`)
      }
      for (const observation of kept) {
        lines.push(`[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`)
      }
    }
    return lines.join('\n')
  }

  // Over budget, drop the OLDEST observations rather than truncating the string.
  // Truncation would silently discard the newest — and most relevant — memory,
  // which is the same "looks complete but is not" failure the coverage gate
  // exists to prevent. Elision is stated in the text so the reader can tell.
  let kept = observations
  let elided = 0
  let rendered = compose(kept, elided)
  while (rendered.length > RENDER_MAX_CHARS && kept.length > 1) {
    const over = rendered.length - RENDER_MAX_CHARS
    const drop = Math.min(kept.length - 1, Math.max(1, Math.ceil(over / 80)))
    kept = kept.slice(drop)
    elided += drop
    rendered = compose(kept, elided)
  }
  return rendered
}

// ---------------------------------------------------------------------------
// Conversation serialization
// ---------------------------------------------------------------------------

/** Render one content block as a single line for a memory-agent prompt. */
function blockLine(block) {
  if (block === null || typeof block !== 'object') return String(block)
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : ''
    case 'reasoning':
      return ''
    case 'tool-call':
      return `-> tool call ${String(block.name)}(${String(block.arguments ?? '').slice(0, 500)})`
    case 'tool-result': {
      const value = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
      return `<- tool result ${value.slice(0, 500)}`
    }
    default:
      return `[${String(block.type ?? 'block')}] ${JSON.stringify(block).slice(0, 300)}`
  }
}

/**
 * Serialize model-visible messages into the compact transcript a memory agent
 * reads. Tool output is truncated hard: memory should record what a tool
 * established, never re-ingest its bulk.
 * @param messages - messages from `session.deriveMessages()`.
 * @returns one transcript string.
 */
export function serializeMessages(messages) {
  const parts = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message?.role === 'string' ? message.role : 'unknown'
    const content = Array.isArray(message?.content) ? message.content : []
    const body = content
      .map(blockLine)
      .filter((line) => line.length > 0)
      .join('\n')
    if (body.length === 0) continue
    parts.push(`[${role}]\n${body}`)
  }
  return parts.join('\n\n')
}

/**
 * Estimated tokens of a serialized message list.
 * @param messages - messages to price.
 * @returns estimated tokens.
 */
export function estimateMessages(messages) {
  return estimateTokens(serializeMessages(messages))
}

/**
 * Price text the way the engine will price the checkpoint it builds from it.
 *
 * Falls back to the local density estimate when the meter is unavailable or
 * rejects the informal message shape.
 * @param runtime - the runtime.
 * @param text - the text to price.
 * @returns estimated tokens.
 */
export function priceText(runtime, text) {
  const meter = runtime.ctx.get('tokenMeter')
  if (typeof meter?.estimateMessage === 'function') {
    try {
      const priced = meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] })
      if (Number.isFinite(priced) && priced > 0) return priced
    } catch {
      /* fall through to the local estimate */
    }
  }
  return estimateTokens(text)
}

/**
 * Price the region a compaction is about to shadow, using the same meter the
 * engine uses for its own size check.
 *
 * It must not use the local serializer: that truncates tool calls and
 * tool-results to 500 characters, so it under-counts exactly the tool-heavy
 * regions this plugin exists to compress. Under-counting lets an oversized
 * render through, and the engine then throws "summary is not smaller than the
 * shadowed content" instead of falling back to the shipped summarizer.
 * @param runtime - the runtime.
 * @param input - the summarizer input the engine handed over.
 * @returns estimated tokens of the shadowed region.
 */
export function estimateShadowedTokens(runtime, input) {
  const messages = Array.isArray(input?.messages) ? input.messages : []
  if (messages.length === 0) return 0
  const meter = runtime.ctx.get('tokenMeter')
  if (typeof meter?.estimateMessage === 'function') {
    let total = 0
    for (const message of messages) {
      try {
        total += meter.estimateMessage(message)
      } catch {
        return estimateMessages(messages)
      }
    }
    if (Number.isFinite(total) && total > 0) return total
  }
  return estimateMessages(messages)
}

/**
 * Whether the ledger describes at least as much conversation as a compaction is
 * about to replace.
 *
 * This is the invariant that makes a deterministic render honest. The engine
 * always shadows the *oldest* span of the surface and the observer reads
 * *oldest first*, so once the ledger has read at least `shadowed` tokens, the
 * shadowed span is fully described. Without this test a partially built ledger
 * would replace a long conversation with a few observations about its
 * beginning — text that looks like a complete checkpoint while describing only
 * a prefix, which is a lie by omission and worse than the summary it displaced.
 *
 * A partial ledger is not itself a defect: it is what a mid-session install, an
 * unparseable observer run that deliberately leaves its range uncovered, or a
 * backlog that has not drained yet all look like. The defect is rendering one as
 * if it were complete.
 * @param ledger - the session ledger.
 * @param shadowedTokens - estimated tokens the compaction will replace.
 * @returns whether the render may stand in for that region.
 */
export function coversShadowedRegion(ledger, shadowedTokens) {
  if (!Number.isFinite(shadowedTokens) || shadowedTokens <= 0) return false
  return ledger.observedTokens >= shadowedTokens
}

/**
 * Take the oldest messages whose serialized size stays inside the chunk budget,
 * always returning at least one message so an oversized turn cannot stall
 * coverage forever.
 * @param messages - unobserved messages, oldest first.
 * @param budgetTokens - maximum estimated tokens in the chunk.
 * @returns the chunk, a prefix of `messages`.
 */
export function takeOldestChunk(messages, budgetTokens) {
  const chunk = []
  let used = 0
  for (const message of messages) {
    const size = estimateMessages([message])
    if (chunk.length > 0 && used + size > budgetTokens) break
    chunk.push(message)
    used += size
  }
  return chunk.length > 0 ? chunk : messages.slice(0, 1)
}

// ---------------------------------------------------------------------------
// Memory-agent prompts and parsing
// ---------------------------------------------------------------------------

const OBSERVER_SYSTEM = [
  'You maintain the observational memory of a long coding session.',
  'You read a transcript of recent conversation and record what happened as observations.',
  '',
  'Rules:',
  '- One observation is one concrete event or established fact: a decision and its stated reason, a constraint, a completed and validated outcome, a traced bug, a preference the user stated, a rejected approach.',
  '- Prefer durable meaning over narration. "User decided to switch from REST to GraphQL to reduce mobile over-fetching" is an observation; "user asked a question" is not.',
  '- Never invent. Record only what the transcript supports.',
  '- Ignore routine status, acknowledgements, and anything re-derivable from nearby context.',
  '- Assign relevance: "critical" for identity, explicit corrections, hard constraints and completed outcomes; "high" for important decisions and unresolved blockers; "medium" for useful task context; "low" for everything else.',
  '',
  'Reply with ONLY a JSON array. Each element:',
  '{"content": "<one line of plain prose>", "relevance": "low"|"medium"|"high"|"critical"}',
  'Reply with [] when the transcript contains nothing worth remembering.'
].join('\n')

const REFLECTOR_SYSTEM = [
  'You maintain the observational memory of a long coding session.',
  'You read the current active observations and the existing reflections, and you distil durable reflections.',
  '',
  'A reflection is a long-lived conclusion: who the user is, what the project is, a hard constraint, an architectural decision, a recurring preference.',
  'Rules:',
  '- Fewer and more durable than observations. Do not turn every observation into a reflection.',
  '- Never invent and never inflate. A reflection supporting ids must list all and only the observations whose durable meaning it preserves; those ids later justify pruning, so an inflated list makes pruning look safer than it is.',
  '- Do not restate an existing reflection unless the new evidence changes it. When it does, emit the corrected version.',
  '',
  'Reply with ONLY a JSON array. Each element:',
  '{"content": "<one line of plain prose>", "supportingIds": ["<observation id>", ...]}',
  'Reply with [] when no new durable conclusion is warranted.'
].join('\n')

const DROPPER_SYSTEM = [
  'You prune the active observation pool of a long coding session.',
  'You receive active observations, each annotated with whether existing reflections cover it.',
  '',
  'Choose observation ids that are safe to remove from ACTIVE memory. Removal is a tombstone: history is never lost and any id can still be recalled.',
  'Rules:',
  '- Drop only what is already preserved by a reflection, superseded by newer memory, redundant, or obsolete.',
  '- Annotated coverage is evidence for your judgement, not an automatic rule. A "strong" observation may still deserve to stay; a "none" observation is usually load-bearing.',
  '- Never drop user assertions, exact decisions, unique identifiers, errors, or the rationale behind a decision unless a reflection genuinely carries them.',
  '',
  'Reply with ONLY a JSON array of observation ids, for example ["a1b2c3d4e5f6"]. Reply with [] to drop nothing.'
].join('\n')

/**
 * Extract the first JSON array from model output, tolerating prose and code
 * fences around it.
 * @param text - raw model output.
 * @returns parsed array, or `null` when no array parses.
 */
export function extractJsonArray(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * Per-activation state. Everything a helper needs is passed explicitly: a Cordis
 * context is a service proxy, not a place to hang plugin-private fields.
 * @param ctx - the plugin context.
 * @param config - resolved configuration.
 * @returns the runtime.
 */
export function createRuntime(ctx, config) {
  return {
    ctx,
    config,
    store: new LedgerStore(),
    /** @type {Set<AbortController>} */
    inflight: new Set(),
    /**
     * Activation and scheduling counters. A plugin that runs in the background
     * is otherwise invisible: without these, "the observer never fired" and "the
     * observer fired and failed" look identical from outside. The probe route
     * reports them.
     */
    stats: {
      activatedAt: new Date().toISOString(),
      /** @type {Record<string, string>} step name -> `ok` or the failure text */
      steps: {},
      turnStoppingSeen: 0,
      passesScheduled: 0,
      passesStarted: 0,
      passesCompleted: 0,
      passesFailed: 0,
      /** Compactions answered from the ledger with no model call. */
      rendersServed: 0,
      /** Compactions that fell through to the shipped summarizer. */
      rendersFellBack: 0,
      /** Compactions refused because the ledger did not cover the shadowed region. */
      rendersSkippedUncovered: 0,
      /** Agent-scoped compaction engines wrapped on `agent/created`. */
      enginesWrapped: 0,
      lastError: undefined,
      lastOutcome: undefined
    },
    log(level, message) {
      ctx.logger?.[level]?.(`observational-memory: ${message}`)
    }
  }
}

/**
 * Run one activation step in isolation.
 *
 * Activation is a sequence of independent registrations, and a failure in any
 * one of them must not silently skip the rest — which is exactly the failure
 * mode that is hardest to see from outside. Each step's outcome is recorded for
 * the probe route.
 * @param runtime - the runtime.
 * @param name - step name reported by the probe.
 * @param run - the step.
 */
function activationStep(runtime, name, run) {
  try {
    run()
    // A step whose real work is deferred (a service injection completes later)
    // records `pending` itself; do not overwrite that with a premature `ok`.
    // Reporting `ok` for work that had not happened yet is exactly how a
    // never-installed compaction hook stayed invisible through two live runs.
    if (runtime.stats.steps[name] === undefined) runtime.stats.steps[name] = 'ok'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    runtime.stats.steps[name] = message
    runtime.stats.lastError = `${name}: ${message}`
    runtime.log('warn', `${name} failed: ${message}`)
  }
}

/**
 * Settle one deferred activation step.
 * @param runtime - the runtime.
 * @param name - the step name.
 * @param error - the failure, or undefined for success.
 */
function settleStep(runtime, name, error) {
  if (error === undefined) {
    runtime.stats.steps[name] = 'ok'
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  runtime.stats.steps[name] = message
  runtime.stats.lastError = `${name}: ${message}`
  runtime.log('warn', `${name} failed: ${message}`)
}

/**
 * The compaction engine an agent's own turns would compact with.
 *
 * `compaction` is mounted inside the agent preset's `compaction` group, a *child*
 * scope of the agent's mount, and `ctx.get` walks ancestors only — so neither the
 * plugin's own context nor `agent.ctx` can see it, and `ctx.inject(['compaction'])`
 * never fires at all. `agentPresets.serviceFor` searches *within* the agent's
 * mount subtree (`withinFiber`), which is the scope the engine actually lives in.
 * @param runtime - the runtime.
 * @param agent - the agent whose engine is wanted.
 * @returns the engine, or undefined.
 */
export function compactionEngineFor(runtime, agent) {
  if (agent !== undefined && agent !== null) {
    try {
      const engine = runtime.ctx.get('agentPresets')?.serviceFor?.(agent, 'compaction')
      if (engine !== undefined && engine !== null) return engine
    } catch (error) {
      runtime.stats.lastError = `serviceFor(compaction): ${String(error)}`
    }
  }
  try {
    return runtime.ctx.get('compaction')
  } catch {
    return undefined
  }
}

/** Resolve the provider/model a memory agent should use. */
function resolveTarget(agent, config) {
  if (config.model !== undefined) return config.model
  try {
    const routed = agent.session.requestHeader?.()?.config
    if (routed !== undefined && typeof routed.provider === 'string' && typeof routed.model === 'string') {
      return { provider: routed.provider, model: routed.model }
    }
  } catch {
    /* fall through to agent options */
  }
  const options = agent.options
  if (typeof options?.provider === 'string' && typeof options?.model === 'string') {
    return { provider: options.provider, model: options.model }
  }
  return undefined
}

/**
 * Run one one-shot memory-agent completion and return its text.
 *
 * `purpose` is deliberately omitted: the option is a closed union of
 * `compaction | session-title`, and a memory run is neither.
 * @returns the assistant text.
 */
async function callMemoryModel(runtime, agent, system, prompt, signal) {
  const target = resolveTarget(agent, runtime.config)
  if (target === undefined) throw new Error('no provider/model available for a memory run')
  // `ctx.get`, not `ctx.llm`: Cordis throws on property access to any service the
  // plugin did not declare in `inject` ("cannot get property llm without
  // inject"). `llm` is deliberately not injected — injecting it would scope it,
  // and every profile mounts it globally — so it is reached the same way as
  // `compaction`, `agents` and `sessionPersistence`.
  const llm = runtime.ctx.get('llm')
  if (typeof llm?.stream !== 'function') throw new Error('the llm service is not mounted')
  let text = ''
  let finish
  for await (const chunk of llm.stream({
    provider: target.provider,
    model: target.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: runtime.config.maxTokens,
    sessionId: agent.session.id,
    ...(signal === undefined ? {} : { signal })
  })) {
    if (chunk?.type === 'text-delta') text += chunk.text ?? ''
    else if (chunk?.type === 'finish') finish = chunk.reason?.kind
  }
  if (typeof finish === 'string' && finish !== 'stop' && text.trim().length === 0) {
    throw new Error(`memory run finished without usable output (${finish})`)
  }
  return text
}

/** File name of the debug NDJSON, beside the ledger in the session directory. */
export const DEBUG_FILENAME = 'observational-memory-debug.ndjson'

/** Append one debug record when `debugLog` is on. */
async function debugRecord(runtime, sessionId, record) {
  if (!runtime.config.debugLog) return
  try {
    const dir = await resolveSessionDir(sessionId, runtime.store.dirs)
    if (dir === null) return
    await appendFile(join(dir, DEBUG_FILENAME), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
  } catch {
    /* debug output must never affect memory */
  }
}

// ---------------------------------------------------------------------------
// Memory agents
// ---------------------------------------------------------------------------

/**
 * Record new observations for the conversation the ledger has not seen yet.
 *
 * Coverage is tracked by observed message count rather than by log sequence,
 * because the model-visible surface is what memory is about and a surface
 * replacement (any compaction) shrinks it — when that happens the count resets
 * and the surviving history is re-read. Coverage advances by exactly the chunk
 * observed, so a backlog larger than one chunk drains over successive runs
 * instead of being marked seen.
 * @returns a short outcome description, or `null` when no run was due.
 */
export async function runObserver(runtime, agent, ledger, signal) {
  const config = runtime.config
  const messages = agent.session.deriveMessages()
  if (messages.length < ledger.observedCount) ledger.observedCount = 0

  // Keep the token watermark honest: never below the price of the messages the
  // ledger claims to have read, priced with the same meter the coverage gate
  // compares against.
  //
  // This self-heals two real cases. A ledger written before `observedTokens`
  // existed reads as 0 and would deadlock the gate forever; a ledger written by a
  // version that only accumulated *new* chunks under-reports everything read
  // before it. Both make the gate refuse memory the ledger genuinely holds, so the
  // feature stays dormant even once coverage is complete.
  //
  // It only ever RAISES the watermark, so it can never make the gate more
  // permissive than the ledger's real coverage.
  const claimedCoverage =
    ledger.observedCount > 0
      ? estimateShadowedTokens(runtime, { messages: messages.slice(0, ledger.observedCount) })
      : 0
  if (claimedCoverage > ledger.observedTokens) {
    ledger.observedTokens = claimedCoverage
    await runtime.store.save(agent.session.id)
  }

  const pending = messages.slice(ledger.observedCount)
  if (pending.length === 0) return null
  if (estimateMessages(pending) < config.observeAfterTokens) return null

  const chunk = takeOldestChunk(pending, config.observerChunkMaxTokens)
  const transcript = serializeMessages(chunk)
  const raw = await callMemoryModel(
    runtime,
    agent,
    OBSERVER_SYSTEM,
    `Transcript of recent conversation:\n\n${transcript}`,
    signal
  )
  const parsed = extractJsonArray(raw)
  if (parsed === null) {
    await debugRecord(runtime, agent.session.id, { run: 'observer', outcome: 'unparseable' })
    // Leave the range uncovered so the next run retries it rather than silently
    // skipping history.
    return 'observer: unparseable output, range left uncovered'
  }

  const now = new Date()
  const evidence = transcript.slice(0, EVIDENCE_MAX_CHARS)
  let recorded = 0
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const content = typeof item.content === 'string' ? item.content.trim().replace(/\s+/g, ' ') : ''
    if (content.length === 0) continue
    const relevance = ['low', 'medium', 'high', 'critical'].includes(item.relevance) ? item.relevance : 'medium'
    const id = memoryId('observation', `${stamp(now)}\u0000${content}`)
    if (ledger.observations.some((observation) => observation.id === id)) continue
    ledger.observations.push({
      id,
      content,
      timestamp: stamp(now),
      relevance,
      tokens: estimateTokens(content),
      evidence
    })
    recorded += 1
  }

  ledger.observedCount += chunk.length
  // Coverage is measured in tokens, not messages, so it can be compared with the
  // size of the region a compaction wants to replace. Priced with the engine
  // meter where available; the local serializer under-counts tool-heavy chunks,
  // which only makes this test more conservative.
  ledger.observedTokens += estimateShadowedTokens(runtime, { messages: chunk })
  await runtime.store.save(agent.session.id)
  await debugRecord(runtime, agent.session.id, {
    run: 'observer',
    outcome: 'ok',
    recorded,
    chunkMessages: chunk.length
  })
  return `observer: recorded ${recorded} observation(s) from ${chunk.length} message(s)`
}

/**
 * Distil durable reflections from the active observation pool.
 * @returns a short outcome description, or `null` when no run was due.
 */
export async function runReflector(runtime, agent, ledger, signal) {
  const config = runtime.config
  const observations = activeObservations(ledger)
  if (observations.length === 0) return null
  const tokens = activeObservationTokens(ledger)
  if (tokens < config.reflectAfterTokens) return null

  const listing = observations
    .map((observation) => `[${observation.id}] (${observation.relevance}) ${observation.content}`)
    .join('\n')
  const existing =
    ledger.reflections.length === 0
      ? '(none yet)'
      : ledger.reflections.map((reflection) => `[${reflection.id}] ${reflection.content}`).join('\n')
  const raw = await callMemoryModel(
    runtime,
    agent,
    REFLECTOR_SYSTEM,
    `Existing reflections:\n${existing}\n\nActive observations:\n${listing}`,
    signal
  )
  const parsed = extractJsonArray(raw)
  if (parsed === null) {
    await debugRecord(runtime, agent.session.id, { run: 'reflector', outcome: 'unparseable' })
    return 'reflector: unparseable output'
  }

  const known = new Set(observations.map((observation) => observation.id))
  let recorded = 0
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const content = typeof item.content === 'string' ? item.content.trim().replace(/\s+/g, ' ') : ''
    if (content.length === 0) continue
    // Only ids naming a live observation are kept: these ids are pruning
    // evidence, so an unresolvable one must not enter the ledger.
    const supportingIds = (Array.isArray(item.supportingIds) ? item.supportingIds : [])
      .filter((id) => typeof id === 'string' && known.has(id))
      .filter((id, index, all) => all.indexOf(id) === index)
    const id = memoryId('reflection', content)
    const previous = ledger.reflections.find((reflection) => reflection.id === id)
    if (previous !== undefined) {
      previous.supportingIds = supportingIds
      continue
    }
    ledger.reflections.push({ id, content, supportingIds, tokens: estimateTokens(content) })
    recorded += 1
  }

  ledger.reflectedObservationTokens = tokens
  await runtime.store.save(agent.session.id)
  await debugRecord(runtime, agent.session.id, { run: 'reflector', outcome: 'ok', recorded })
  return `reflector: recorded ${recorded} reflection(s)`
}

/**
 * Prune the active observation pool after a reflection, using reflection
 * coverage as evidence.
 *
 * Deliberately reachable only once the pool exceeds its budget: dropping is a
 * tombstone, but a wrongly dropped observation stops guiding the agent until
 * something recalls it.
 * @returns a short outcome description, or `null` when no run was due.
 */
export async function runDropper(runtime, agent, ledger, signal) {
  const config = runtime.config
  const observations = activeObservations(ledger)
  if (observations.length === 0) return null
  if (activeObservationTokens(ledger) <= config.observationsPoolMaxTokens) return null

  const covered = new Set()
  for (const reflection of ledger.reflections) {
    for (const id of reflection.supportingIds) covered.add(id)
  }
  const listing = observations
    .map((observation) => {
      const tier = covered.has(observation.id) ? 'strong' : 'none'
      return `[${observation.id}] (${observation.relevance}, coverage: ${tier}) ${observation.content}`
    })
    .join('\n')
  const raw = await callMemoryModel(runtime, agent, DROPPER_SYSTEM, `Active observations:\n${listing}`, signal)
  const parsed = extractJsonArray(raw)
  if (parsed === null) {
    await debugRecord(runtime, agent.session.id, { run: 'dropper', outcome: 'unparseable' })
    return 'dropper: unparseable output'
  }

  const droppable = new Set(observations.map((observation) => observation.id))
  const dropped = []
  for (const value of parsed) {
    const id =
      typeof value === 'string' ? value : value !== null && typeof value === 'object' ? value.id : undefined
    if (typeof id !== 'string' || !droppable.has(id) || ledger.dropped.includes(id)) continue
    ledger.dropped.push(id)
    dropped.push(id)
  }
  if (dropped.length > 0) await runtime.store.save(agent.session.id)
  await debugRecord(runtime, agent.session.id, { run: 'dropper', outcome: 'ok', dropped: dropped.length })
  return `dropper: dropped ${dropped.length} observation(s) from active memory`
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Commit one observation/reflection/prune pass, in the ledger's order of
 * operations.
 * @returns collected outcome lines.
 */
export async function runMemoryPass(runtime, agent, signal) {
  // Accounting lives here, not in the scheduler: the probe calls this directly,
  // and a pass that only the scheduler counted made `passesStarted` and
  // `passesCompleted` disagree — which is exactly the kind of incoherent
  // diagnostic that makes a live failure hard to read.
  runtime.stats.passesStarted += 1
  try {
    const sessionId = agent.session.id
    const ledger = await runtime.store.load(sessionId)
    const outcomes = []
    const observer = await runObserver(runtime, agent, ledger, signal)
    if (observer !== null) outcomes.push(observer)
    const reflector = await runReflector(runtime, agent, ledger, signal)
    if (reflector !== null) outcomes.push(reflector)
    // Pruning is post-reflection maintenance only, so it can see the reflections
    // it is allowed to treat as coverage evidence.
    if (reflector !== null) {
      const dropper = await runDropper(runtime, agent, ledger, signal)
      if (dropper !== null) outcomes.push(dropper)
    }
    if (outcomes.length > 0) runtime.log('info', outcomes.join('; '))
    runtime.stats.lastOutcome = outcomes.length === 0 ? 'nothing due' : outcomes.join('; ')
    runtime.stats.passesCompleted += 1
    return outcomes
  } catch (error) {
    runtime.stats.passesFailed += 1
    runtime.stats.lastError = String(error)
    throw error
  }
}

/** Sessions with a memory run in flight, so turns cannot stack runs. */
const inFlight = new Set()

/**
 * Whether an agent is a root session rather than a delegated child.
 *
 * A child session (subagent, team member, workflow agent) is short-lived and
 * works inside its parent's task, so observing it spends a model call to write
 * memory nobody will read — and a `fork` child inherits its parent's event
 * prefix, so it would re-observe history the parent's ledger already holds.
 *
 * `agents.roots()` answers directly, but it can be empty at the moment a turn
 * ends, and treating "no roots" as "not a root" would silently disable memory
 * entirely. `isOwnedBy` is the authoritative ownership test and does not depend
 * on that list; when neither is usable the session is observed, because failing
 * open here costs a model call while failing closed costs the feature.
 * @param runtime - the runtime.
 * @param agent - the agent to classify.
 * @returns whether the agent should be observed.
 */
export function isRootAgent(runtime, agent) {
  if (agent === undefined || agent === null) return false
  let registry
  try {
    registry = runtime.ctx.get('agents')
  } catch {
    return true
  }
  if (registry === undefined || registry === null) return true
  try {
    const roots = registry.roots?.()
    if (Array.isArray(roots) && roots.length > 0) return roots.includes(agent)
  } catch {
    /* fall through to the ownership test */
  }
  try {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string' && typeof registry.isOwnedBy === 'function') {
      const owned = registry.list?.() ?? []
      for (const owner of owned) {
        if (owner === agent) continue
        if (registry.isOwnedBy(sessionId, owner) === true) return false
      }
    }
  } catch {
    /* an unanswerable registry is treated as "observe it" */
  }
  return true
}

/**
 * Start a memory pass in the background.
 *
 * The pass must not block the turn: it is a model call, and the turn that
 * triggered it has already finished. It therefore runs on its own abort
 * controller, tracked so a plugin dispose can cancel it.
 */
export function scheduleMemoryPass(runtime, agent) {
  const config = runtime.config
  runtime.stats.passesScheduled += 1
  if (config.passive) return
  const sessionId = agent?.session?.id
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return
  if (inFlight.has(sessionId)) return
  if (config.rootAgentsOnly && !isRootAgent(runtime, agent)) return
  const controller = new AbortController()
  runtime.inflight.add(controller)
  inFlight.add(sessionId)
  void (async () => {
    try {
      // `runMemoryPass` owns the started/completed/failed accounting.
      await runMemoryPass(runtime, agent, controller.signal)
    } catch (error) {
      runtime.log('warn', `memory pass failed: ${String(error)}`)
    } finally {
      inFlight.delete(sessionId)
      runtime.inflight.delete(controller)
    }
  })()
}

// ---------------------------------------------------------------------------
// Deterministic compaction
// ---------------------------------------------------------------------------

/**
 * Install the deterministic memory renderer on the live compaction engine.
 *
 * `summarize()` is the contract's documented sole subclass customization hook; a
 * workspace bundle cannot import the engine class to subclass it, so the one
 * mounted instance is wrapped instead and restored by the disposer. The wrapper
 * never fails a compaction: any problem falls through to the shipped summarizer.
 * @returns whether the wrapper was installed.
 */
export function installCompactionRenderer(runtime, agent) {
  return wrapCompactionEngine(runtime, compactionEngineFor(runtime, agent)) === 'wrapped'
}

/**
 * Marker proving a `summarize` is this plugin's renderer. It makes wrapping
 * idempotent — the same engine can be reached from the plugin context and from
 * an agent's own context — and lets the probe report exactly which engine is
 * wrapped rather than asserting it.
 */
const WRAPPED_SUMMARIZE = Symbol.for('dsh.observational-memory.wrapped-summarize')

/**
 * Wrap one compaction engine's `summarize` with the deterministic renderer.
 *
 * The engine may be reached more than once (a plugin-context engine and an
 * agent-scoped one), so the wrapper is idempotent and disposes independently.
 * @param runtime - the runtime.
 * @param engine - the compaction engine to wrap.
 * @returns `wrapped`, `already-wrapped`, or `absent`.
 */
export function wrapCompactionEngine(runtime, engine) {
  if (engine === undefined || engine === null || typeof engine.summarize !== 'function') return 'absent'
  if (engine.summarize[WRAPPED_SUMMARIZE] === true) return 'already-wrapped'
  // `summarize` normally lives on the engine's prototype, so the wrapper is an
  // own property shadowing it. Restoring must therefore *remove* the own
  // property when it did not exist, or a later dispose would leave a permanently
  // rebound copy in place of the class method.
  const hadOwnSummarize = Object.hasOwn(engine, 'summarize')
  const ownSummarize = engine.summarize
  const original = ownSummarize

  const patched = async function summarize(input, agent, signal) {
    try {
      const sessionId = agent?.session?.id
      if (typeof sessionId === 'string') {
        const ledger = await runtime.store.load(sessionId)
        const rendered = renderMemory(ledger)
        if (rendered !== null) {
          const shadowed = estimateShadowedTokens(runtime, input)
          if (!coversShadowedRegion(ledger, shadowed)) {
            // Partial coverage. A checkpoint built from it would look complete
            // while describing only a prefix of what it replaced — a lie by
            // omission, and worse than the summary it displaced.
            runtime.stats.rendersSkippedUncovered += 1
          } else if (shadowed === 0 || priceText(runtime, rendered) < shadowed) {
            // The engine rejects a summary that is not smaller than the region it
            // shadows, so fall through rather than throw when memory is not the
            // smaller representation.
            const target = resolveTarget(agent, runtime.config)
            runtime.stats.rendersServed += 1
            return {
              summary: [{ type: 'text', text: rendered }],
              // Not a model call: the contract's unmarked variant, kept out of
              // the summary's call record by `llmStreamCall: false`.
              llmStreamCall: false,
              provider: target?.provider ?? 'observational-memory',
              model: target?.model ?? 'observational-memory'
            }
          }
        }
      }
    } catch (error) {
      runtime.log('warn', `memory render failed, falling back to the summarizer: ${String(error)}`)
    }
    runtime.stats.rendersFellBack += 1
    return original.call(engine, input, agent, signal)
  }
  patched[WRAPPED_SUMMARIZE] = true

  // The wrapper is an own property shadowing the class method, so assignment can
  // fail on a frozen, sealed, or proxied service instance. That failure has to be
  // visible rather than silent: an unwrapped engine keeps calling a model at
  // compaction time and looks identical to a working one from the outside.
  try {
    engine.summarize = patched
  } catch (assignmentError) {
    try {
      Object.defineProperty(engine, 'summarize', { value: patched, configurable: true, writable: true })
    } catch (defineError) {
      const message = `cannot wrap summarize: ${String(defineError)} (assignment: ${String(assignmentError)})`
      runtime.stats.lastError = message
      runtime.log('warn', message)
      return 'unwrappable'
    }
  }
  runtime.ctx.effect(
    () => () => {
      if (engine.summarize !== patched) return
      try {
        if (hadOwnSummarize) engine.summarize = ownSummarize
        else delete engine.summarize
      } catch {
        /* an engine that could not be shadowed cannot be restored either */
      }
    },
    'observational-memory: deterministic compaction renderer'
  )
  return 'wrapped'
}

// ---------------------------------------------------------------------------
// Model-facing recall tool and human commands
// ---------------------------------------------------------------------------

/** JSON Schema for the recall tool's arguments. */
const RECALL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      description: 'A 12-character observation or reflection id shown in brackets in the memory block.'
    }
  }
}

/** JSON Schema for the recall tool's output. */
const RECALL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'text'],
  properties: {
    kind: { type: 'string' },
    text: { type: 'string' }
  }
}

/**
 * Resolve one memory id against a ledger.
 * @param ledger - session ledger.
 * @param id - requested id.
 * @returns the kind plus the text to return to the caller.
 */
export function recall(ledger, id) {
  const isDropped = ledger.dropped.includes(id)
  const observation = ledger.observations.find((item) => item.id === id)
  if (observation !== undefined) {
    return {
      kind: isDropped ? 'observation-dropped' : 'observation',
      text: [
        `${isDropped ? 'Observation (dropped from active memory)' : 'Observation'} [${observation.id}]`,
        `${observation.timestamp} [${observation.relevance}] ${observation.content}`,
        observation.evidence.length > 0
          ? `\nSource excerpt:\n${observation.evidence}`
          : '\nNo source excerpt was retained.'
      ].join('\n')
    }
  }
  const reflection = ledger.reflections.find((item) => item.id === id)
  if (reflection !== undefined) {
    const supporting = reflection.supportingIds
      .map((supportId) => ledger.observations.find((item) => item.id === supportId))
      .filter((item) => item !== undefined)
    return {
      kind: 'reflection',
      text: [
        `Reflection [${reflection.id}]`,
        reflection.content,
        supporting.length > 0
          ? `\nSupporting observations:\n${supporting
              .map((item) => `[${item.id}] ${item.timestamp} ${item.content}`)
              .join('\n')}`
          : '\nNo supporting observations are recorded for this reflection.'
      ].join('\n')
    }
  }
  return { kind: 'missing', text: `No observation or reflection with id "${id}" exists in this session's memory.` }
}

/** Register the `recall` tool. */
export function registerRecallTool(runtime) {
  runtime.ctx.tools.register({
    name: 'recall',
    description:
      'Recover the source evidence behind one observational-memory id. Use it when an [id] line in the condensed memory block materially affects a decision, or is too compressed to act on confidently. It takes one exact id and is not search: it cannot answer a question, only show what the recorded memory was derived from.',
    parameters: RECALL_PARAMETERS,
    output: {
      schema: RECALL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    async execute(args, exec) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      const agent = exec?.agent
      if (agent === undefined) throw new Error('recall requires an owning agent session')
      if (!/^[0-9a-f]{12}$/.test(id)) {
        return { kind: 'invalid', text: `"${id}" is not a 12-character memory id.` }
      }
      const ledger = await runtime.store.load(agent.session.id)
      return recall(ledger, id)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Recall memory', kind: 'other', rawInput: args?.id })
  })
}

/** Register one command, never letting a rejection break activation. */
function registerCommandSafely(runtime, definition) {
  try {
    runtime.ctx.commands.register(definition)
  } catch (error) {
    runtime.log('warn', `command "${definition.name}" was not registered: ${String(error)}`)
  }
}

/** Register the `/om-*` commands. */
export function registerCommands(runtime) {
  registerCommandSafely(runtime, {
    name: 'om-status',
    description: 'Show observational-memory counts, thresholds and passive state.',
    handler: async ({ agent }) => {
      const ledger = await runtime.store.load(agent.session.id)
      const config = runtime.config
      const active = activeObservations(ledger)
      return {
        kind: 'success',
        text: [
          `observational-memory (${config.passive ? 'passive' : 'active'})`,
          `observe after: ~${config.observeAfterTokens} tokens | reflect after: ~${config.reflectAfterTokens} tokens`,
          `pool max: ~${config.observationsPoolMaxTokens} tokens`,
          `memory model: ${
            config.model === undefined ? 'session model' : `${config.model.provider}/${config.model.model}`
          }`,
          '',
          `observations: ${active.length} active / ${ledger.observations.length} recorded / ${ledger.dropped.length} dropped`,
          `reflections: ${ledger.reflections.length}`,
          `active observation tokens: ~${activeObservationTokens(ledger)}`,
          `observed messages: ${ledger.observedCount}`,
          `last update: ${ledger.updatedAt}`
        ].join('\n')
      }
    }
  })

  registerCommandSafely(runtime, {
    name: 'om-view',
    description: 'Render the current observational memory for this session.',
    handler: async ({ agent }) => {
      const ledger = await runtime.store.load(agent.session.id)
      const rendered = renderMemory(ledger)
      return {
        kind: 'success',
        text: rendered === null ? 'No observations or reflections recorded for this session yet.' : rendered
      }
    }
  })

  registerCommandSafely(runtime, {
    name: 'om-observe',
    description: 'Force one observational-memory pass now and report what it recorded.',
    handler: async ({ agent, signal }) => {
      const outcomes = await runMemoryPass(runtime, agent, signal)
      return {
        kind: 'success',
        text: outcomes.length === 0 ? 'Memory pass ran; nothing was due.' : outcomes.join('\n')
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Diagnostic probe
// ---------------------------------------------------------------------------

/** Exact route the probe listens on. */
const PROBE_ROUTE = '/observational-memory/probe'
/** Custom header that forces a CORS preflight, so a random web page cannot reach the route. */
const PROBE_HEADER = 'x-dsh-observational-memory'
/** Bound on the request body the probe will read. */
const PROBE_MAX_BODY_BYTES = 8 * 1024

/** Loopback-only admission for the probe route. */
function isLoopback(address) {
  if (address === undefined) return true
  return address.startsWith('127.') || address === '::1' || address.startsWith('::ffff:127.')
}

/** Read the whole request body, bounded. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > PROBE_MAX_BODY_BYTES) throw new Error('request body exceeds the limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Serve one probe request.
 *
 * A background memory plugin has no other observability surface: its work is
 * invisible until a compaction happens, and "never fired" is indistinguishable
 * from "fired and failed". This route answers that question directly, and lets a
 * caller force one memory pass against a live session to prove the pipeline
 * end to end.
 * @returns the JSON response body.
 */
async function probe(runtime, request) {
  const action = typeof request.action === 'string' ? request.action : 'status'
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined
  const stats = { ...runtime.stats, steps: { ...runtime.stats.steps } }
  const sessionDir =
    sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)
      ? null
      : await resolveSessionDir(sessionId, runtime.store.dirs)
  const base = {
    activated: true,
    config: runtime.config,
    stats,
    sessionDir,
    ledgerPath: sessionDir === null ? undefined : join(sessionDir, LEDGER_FILENAME)
  }

  if (action === 'status') {
    const agents = runtime.ctx.get('agents')
    return {
      ...base,
      inflight: runtime.inflight.size,
      deferredWrites: runtime.store.deferredWrites,
      liveAgents: typeof agents?.list === 'function' ? agents.list().map((agent) => agent.session?.id) : undefined
    }
  }

  if (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)) {
    return { ...base, kind: 'invalid', error: 'a valid sessionId is required for this action' }
  }

  // Whether automatic pressure compaction can engage at all. `compaction-basic`
  // needs a `contextWindow` on the routed adapter model; without one it throws
  // `TargetPressureConfigError` on every step, and the only compaction left is
  // the recovery that runs *after* a provider rejects an over-window request —
  // exactly the moment when rendering a partial ledger would do the most damage.
  if (action === 'model-info') {
    const agent = runtime.ctx.get('agents')?.get(sessionId)
    const target = agent === undefined ? undefined : resolveTarget(agent, runtime.config)
    let info
    let error
    try {
      info = target === undefined ? undefined : await runtime.ctx.get('llm')?.resolveModelInfo?.(target.provider, target.model)
    } catch (caught) {
      error = String(caught)
    }
    const contextWindow = info?.context?.contextWindow
    return {
      ...base,
      kind: 'ok',
      target,
      contextWindow,
      defaultMaxTokens: info?.defaultMaxTokens,
      error,
      note:
        contextWindow === undefined
          ? 'no contextWindow for this route: pressure compaction throws and only overflow-recovery compaction can run'
          : `pressure threshold is min(${contextWindow} * 0.8, ${contextWindow} - reserved - 65536)`
    }
  }

  const ledger = await runtime.store.load(sessionId)

  // Everything the status-bar widget needs, in one poll. The three clocks are
  // the ones the agent actually waits on: when the observer will read again,
  // when the reflector will distil, and when compaction will replace history.
  if (action === 'usage') {
    const agent = runtime.ctx.get('agents')?.get(sessionId)
    const meter = runtime.ctx.get('tokenMeter')
    let usedTokens
    try {
      usedTokens = agent === undefined ? undefined : meter?.measure?.(agent.session)?.totalTokens
    } catch {
      usedTokens = undefined
    }

    // The threshold is recomputed exactly the way `resolveCompactSpec` does it,
    // from the live engine's own resolved policy — not from a copy of its
    // defaults, which would silently drift if the profile configured one.
    const engine = compactionEngineFor(runtime, agent)
    const policy = engine?.config
    let contextWindow
    let thresholdTokens
    let retainedTokens
    try {
      const target = agent === undefined ? undefined : resolveTarget(agent, runtime.config)
      const info =
        target === undefined ? undefined : await runtime.ctx.get('llm')?.resolveModelInfo?.(target.provider, target.model)
      contextWindow = info?.context?.contextWindow
      if (Number.isInteger(contextWindow) && contextWindow > 0 && policy !== undefined) {
        const reserved = agent.session.requestHeader?.()?.config?.maxTokens ?? info?.defaultMaxTokens ?? 0
        const messageBudget = contextWindow - reserved
        const pressureBudget = messageBudget - policy.headroomTokens
        thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudget))
        retainedTokens = Math.floor(messageBudget * (policy.retainRatio ?? 0.16))
      }
    } catch {
      /* a route without capacity simply reports no threshold */
    }

    const percent = (value, limit) =>
      !Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0
        ? undefined
        : Math.max(0, Math.min(100, Math.round((value / limit) * 100)))

    let pendingTokens
    try {
      pendingTokens =
        agent === undefined
          ? undefined
          : estimateShadowedTokens(runtime, { messages: agent.session.deriveMessages().slice(ledger.observedCount) })
    } catch {
      pendingTokens = undefined
    }
    const activeTokens = activeObservationTokens(ledger)

    return {
      ...base,
      kind: 'ok',
      context: {
        usedTokens,
        contextWindow,
        thresholdTokens,
        retainedTokens,
        percent: percent(usedTokens, thresholdTokens)
      },
      observe: {
        pendingTokens,
        thresholdTokens: runtime.config.observeAfterTokens,
        percent: percent(pendingTokens, runtime.config.observeAfterTokens)
      },
      reflect: {
        activeTokens,
        thresholdTokens: runtime.config.reflectAfterTokens,
        percent: percent(activeTokens, runtime.config.reflectAfterTokens)
      },
      compact: { percent: percent(usedTokens, thresholdTokens) },
      ledger: {
        observations: ledger.observations.length,
        activeObservations: activeObservations(ledger).length,
        reflections: ledger.reflections.length,
        observedTokens: ledger.observedTokens,
        // How much of the history the ledger can describe. Below 100% the
        // renderer refuses and compaction falls back to the summarizer.
        coveragePercent: percent(ledger.observedTokens, thresholdTokens)
      }
    }
  }

  const summary = {
    observations: ledger.observations.length,
    activeObservations: activeObservations(ledger).length,
    reflections: ledger.reflections.length,
    dropped: ledger.dropped.length,
    observedCount: ledger.observedCount,
    observedTokens: ledger.observedTokens,
    updatedAt: ledger.updatedAt
  }

  if (action === 'ledger') return { ...base, kind: 'ok', summary, ledger }
  if (action === 'render') return { ...base, kind: 'ok', summary, rendered: renderMemory(ledger) }

  // Whether the engine the *agent* would compact with is actually the wrapped
  // one. The plugin's own context and an agent's context can resolve different
  // `compaction` instances because the service is isolated per agent scope, and
  // wrapping the wrong one would silently leave compaction calling a model.
  if (action === 'compaction-hook') {
    const agent = runtime.ctx.get('agents')?.get(sessionId)
    let rootEngine
    let viaAgentCtx
    try {
      rootEngine = runtime.ctx.get('compaction')
    } catch {
      rootEngine = undefined
    }
    // `agent.ctx.get` walks ancestors only, so it cannot see a service mounted in
    // a child group — reporting it distinguishes "the engine is elsewhere in the
    // tree" from "the engine does not exist".
    try {
      viaAgentCtx = agent?.ctx?.get?.('compaction')
    } catch {
      viaAgentCtx = undefined
    }
    const engine = compactionEngineFor(runtime, agent)
    // Attempt the wrap as well as report it: wrapping is idempotent, so this
    // doubles as a repair for an agent that existed before activation.
    if (wrapCompactionEngine(runtime, engine) === 'wrapped') runtime.stats.enginesWrapped += 1
    const state = (candidate) => ({
      present: candidate !== undefined && candidate !== null,
      wrapped: candidate?.summarize?.[WRAPPED_SUMMARIZE] === true
    })
    return {
      ...base,
      kind: 'ok',
      agentPresets: typeof runtime.ctx.get('agentPresets')?.serviceFor === 'function',
      root: state(rootEngine),
      viaAgentCtx: state(viaAgentCtx),
      resolved: state(engine),
      sameEngineAsRoot: engine !== undefined && engine === rootEngine,
      enginesWrapped: runtime.stats.enginesWrapped
    }
  }

  if (action === 'observe') {
    const agent = runtime.ctx.get('agents')?.get(sessionId)
    if (agent === undefined) return { ...base, kind: 'no-live-agent', summary }
    const messages = agent.session.deriveMessages()
    const controller = new AbortController()
    const outcomes = await runMemoryPass(runtime, agent, controller.signal)
    return {
      ...base,
      kind: 'ok',
      summary,
      derivedMessages: messages.length,
      pendingTokens: estimateMessages(messages.slice(ledger.observedCount)),
      outcomes
    }
  }

  return { ...base, kind: 'unknown-action', error: `unknown action "${action}"` }
}

/**
 * Register the loopback probe route.
 * @param runtime - the runtime.
 */
export function installProbeRoute(runtime) {
  // The route only exists once `webServer` is available, which may be after
  // activation returns. The step stays `pending` until that actually happens.
  runtime.stats.steps['probe route'] = 'pending'
  runtime.ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      const send = (status, payload) => {
        const body = JSON.stringify(payload, null, 2)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body)
        })
        res.end(body)
      }
      try {
        if (req.method !== 'POST') {
          send(405, { ok: false, error: 'POST only' })
          return
        }
        if (!isLoopback(req.socket?.remoteAddress)) {
          send(403, { ok: false, error: 'loopback clients only' })
          return
        }
        if (req.headers[PROBE_HEADER] !== '1') {
          send(403, { ok: false, error: `missing ${PROBE_HEADER} header` })
          return
        }
        const raw = await readBody(req)
        const parsed = raw.trim() === '' ? {} : JSON.parse(raw)
        send(200, { ok: true, result: await probe(runtime, parsed) })
      } catch (error) {
        send(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    try {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path: PROBE_ROUTE, handler }),
        'observational-memory: probe route'
      )
      settleStep(runtime, 'probe route', undefined)
    } catch (error) {
      settleStep(runtime, 'probe route', error)
    }
  })
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Mount the observational-memory plugin.
 * @param ctx - plugin context.
 * @param rawConfig - the loader entry's config object.
 */
export function apply(ctx, rawConfig) {
  const runtime = createRuntime(ctx, resolveConfig(rawConfig))

  // Every registration is an independent step. A command-name collision, a
  // restricted tool registry, or a missing service must degrade that one
  // capability and be reported — never silently skip the rest of activation,
  // which is the failure mode hardest to see from outside.
  activationStep(runtime, 'recall tool', () => registerRecallTool(runtime))
  activationStep(runtime, 'commands', () => registerCommands(runtime))
  // The compaction engine only exists inside an agent's preset scope, so there
  // is nothing to wrap until an agent exists. This step is honest about that
  // instead of reporting a success it cannot have: the previous version used
  // `ctx.inject(['compaction'])`, whose callback never fires because the service
  // lives in a child scope, and the step still recorded `ok`.
  activationStep(runtime, 'compaction renderer', () => {
    // A profile may mount compaction at the top level; this one does not — it is
    // isolated inside each agent's preset group — so both are attempted. The
    // step reports what actually happened instead of a blanket `ok`, because the
    // previous version reported success for an injection whose callback never
    // fired and hid a dead renderer through two live runs.
    const rootResult = wrapCompactionEngine(runtime, runtime.ctx.get('compaction'))
    const agents = runtime.ctx.get('agents')?.list?.() ?? []
    let wrapped = 0
    let unwrappable = 0
    for (const agent of agents) {
      const result = wrapCompactionEngine(runtime, compactionEngineFor(runtime, agent))
      if (result === 'wrapped') wrapped += 1
      else if (result === 'unwrappable') unwrappable += 1
    }
    runtime.stats.enginesWrapped += wrapped + (rootResult === 'wrapped' ? 1 : 0)
    if (unwrappable > 0 || rootResult === 'unwrappable') {
      runtime.stats.steps['compaction renderer'] = `unwrappable (${unwrappable} agent engine(s), root ${rootResult})`
    } else {
      runtime.stats.steps['compaction renderer'] =
        agents.length > 0
          ? `per-agent (${wrapped}/${agents.length} wrapped)`
          : rootResult === 'wrapped'
            ? 'root'
            : 'per-agent (no agents yet)'
    }
  })

  // Every agent that enters afterwards gets its own engine wrapped here.
  activationStep(runtime, 'agent compaction hook', () => {
    ctx.on('agent/created', ({ agent }) => {
      try {
        if (wrapCompactionEngine(runtime, compactionEngineFor(runtime, agent)) === 'wrapped') {
          runtime.stats.enginesWrapped += 1
        }
      } catch (error) {
        runtime.stats.lastError = `agent compaction hook: ${String(error)}`
        runtime.log('warn', `agent compaction hook failed: ${String(error)}`)
      }
    })
  })

  activationStep(runtime, 'probe route', () => installProbeRoute(runtime))

  // A turn is the natural observation boundary: the work is done, so the
  // transcript is stable. The pass is started, never awaited — a memory model
  // call must not hold a turn open. The extra `next` is defensive: this event is
  // declared serial, and a listener that swallows a continuation would hang the
  // turn.
  activationStep(runtime, 'turn hook', () => {
    ctx.on('agent/turn-stopping', (payload, next) => {
      runtime.stats.turnStoppingSeen += 1
      try {
        const agent = payload?.agent
        // Lazy re-wrap: `agent/created` never fires for an agent that already
        // existed when this plugin activated, and `agents.list()` may be empty
        // at activation time. Wrapping is idempotent, so once covered this costs
        // one symbol read.
        try {
          if (wrapCompactionEngine(runtime, compactionEngineFor(runtime, agent)) === 'wrapped') {
            runtime.stats.enginesWrapped += 1
          }
        } catch {
          /* an unreachable agent scope must not stop the memory pass */
        }
        scheduleMemoryPass(runtime, agent)
      } catch (error) {
        runtime.stats.lastError = `scheduling: ${String(error)}`
        runtime.log('warn', `scheduling failed: ${String(error)}`)
      }
      return typeof next === 'function' ? next() : undefined
    })
  })

  // Flush the ledger when a session goes away: the write is already queued, but
  // awaiting it here means a clean shutdown cannot lose the last observation.
  activationStep(runtime, 'dispose hook', () => {
    ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string') return
      void runtime.store.save(sessionId)
    })
  })

  activationStep(runtime, 'inflight cleanup', () => {
    ctx.effect(
      () => () => {
        for (const controller of runtime.inflight) controller.abort()
        runtime.inflight.clear()
      },
      'observational-memory: cancel in-flight memory runs'
    )
  })

  runtime.log(
    'info',
    `active (observe ~${runtime.config.observeAfterTokens}, reflect ~${runtime.config.reflectAfterTokens} tokens)`
  )
  // Cordis ignores a plugin's return value; returning the runtime makes the
  // activation steps inspectable in tests.
  return runtime
}

/** Exposed for tests; not part of the plugin contract. */
export const __testing = {
  estimateMessages,
  takeOldestChunk,
  serializeMessages,
  resolveTarget,
  callMemoryModel,
  stamp
}
