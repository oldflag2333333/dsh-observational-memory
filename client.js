/**
 * Client half of the observational-memory bundle.
 *
 * Puts an observational-memory meter in the composer dock, immediately beside
 * the shipped context meter. The ring shows one number — how much of the
 * compaction threshold the live context has consumed — and the panel behind it
 * shows the three clocks the memory agents actually wait on:
 *
 *   1. observe  — backlog of unread conversation against `observeAfterTokens`
 *   2. reflect  — active observation pool against `reflectAfterTokens`
 *   3. compact  — context against the engine's own compaction threshold
 *
 * Data comes from the Host half's `/observational-memory/probe` route rather
 * than a client projection: projections are declared by the packages that own
 * them, and a hand-written workspace bundle cannot add one — the same reason
 * `dsh-session-removal` uses a route instead of a Host Remote.
 *
 * Styling is copied token-for-token from the shipped meter's CSS module
 * (`ContextMeter.module.css` in `dsh-client-ui-conversation`) and injected as a
 * plain stylesheet, the way that package injects its own. A widget sitting next
 * to a shipped one has to be indistinguishable from it, and matching theme
 * tokens by eye does not achieve that: the ring tint, the type scale and the
 * control metrics all come from tokens whose values are theme-dependent.
 *
 * Nothing renders until the Host reports both a reading and a route capacity,
 * which matches the shipped meter: a percentage of an unknown threshold is
 * worse than no percentage.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-observational-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'observational-memory'
    const ROUTE = '/observational-memory/probe'
    const HEADER = 'x-dsh-observational-memory'
    /** Poll period. The clocks move on the scale of turns, not frames. */
    const POLL_MS = 2000

    /** Ring geometry, verbatim from the shipped meter: 14px box, 5.5px radius, 2px stroke. */
    const RADIUS = 5.5
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS

    const PLUGIN_ID = '@local/dsh-observational-memory'
    const CSS_TAG = `${PLUGIN_ID}/observational-memory.css`

    /**
     * Every declaration below is copied from the shipped meter's CSS module so
     * the two controls share one visual language. `omx_` prefixes the cell names
     * because the shipped module's hashes are private to that package.
     */
    const CSS = [
      '.omx_root{flex:none;display:inline-flex}',
      '.omx_trigger{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);',
      'font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);',
      'font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;',
      'padding:1px 8px;display:inline-flex}',
      '.omx_trigger:hover,.omx_trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.omx_track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}',
      '.omx_fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round}',
      '.omx_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);',
      'width:min(264px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);',
      'color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px}',
      '.omx_header{align-items:center;gap:6px;display:flex}',
      '.omx_figures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}',
      '.omx_percent{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.omx_headline{color:var(--dsw-alias-label-tertiary)}',
      '.omx_headline:empty{display:none}',
      '.omx_meter{display:flex;flex-direction:column;gap:4px;margin-top:10px}',
      '.omx_bar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:4px;display:flex;overflow:hidden}',
      '.omx_segment{background:var(--meter-tint,var(--dsw-alias-label-tertiary));border-radius:1px;flex:none;min-width:2px;height:100%}',
      '.omx_row{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}',
      '.omx_row dt{color:var(--dsw-alias-label-secondary)}',
      '.omx_row dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0}',
      '.omx_reading{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.omx_note{margin-top:12px;padding-top:8px;border-top:0.5px solid var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));line-height:18px}',
      '.omx_colorObserve{--meter-tint:var(--dsw-static-neutral-bluish-400)}',
      '.omx_colorReflect{--meter-tint:#a78bfa}',
      '.omx_colorCompact{--meter-tint:var(--dsw-static-blue-450)}',
      // Hover hint. The shipped controls show one through the primitives
      // `Tooltip`, which a workspace bundle cannot import — the Client half only
      // receives React, ctx, host, styles and console. This is that primitive's
      // bubble, copied declaration for declaration, minus the portal and the
      // placement engine. The native `title` attribute was the first attempt and
      // is not a substitute: it appears after the browser's own delay, cannot
      // follow the theme, and cannot be styled.
      '.omx_hint{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);',
      'width:max-content;max-width:300px;box-sizing:border-box;padding:3px 7px;',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);',
      'color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;',
      'overflow-wrap:break-word;pointer-events:none;z-index:1100;opacity:0;visibility:hidden}',
      '.omx_hint[data-show=true]{opacity:1;visibility:visible;animation:omx-hint-in 150ms var(--ds-ease-in-out)}',
      '@keyframes omx-hint-in{from{opacity:0}}',
      '@media (prefers-reduced-motion: reduce){.omx_hint[data-show=true]{animation:none}}'
    ].join('')

    /**
     * Insert the stylesheet through the package-owned `styles` builtin rather
     * than a hand-appended `<style>`: it tags ownership and removes the sheet
     * when this Client run ends, so a reload cannot accumulate copies. The
     * fallback covers an older Client runtime that does not expose it.
     * @param ctx - the client plugin context.
     */
    function insertStyles(ctx) {
      const styles = ctx?.get?.('styles')
      if (typeof styles?.insert === 'function') {
        ctx.effect(() => styles.insert(CSS), 'observational-memory: stylesheet')
        return
      }
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const T = {
      aria: { zh: '观察记忆：占压缩阈值 {percent}', en: 'Observational memory: {percent} of the compaction threshold' },
      title: { zh: '观察记忆', en: 'Observational memory' },
      observe: { zh: '下一次观察', en: 'Next observe' },
      reflect: { zh: '下一次反思', en: 'Next reflect' },
      compact: { zh: '下一次压缩', en: 'Next compact' },
      coverage: { zh: '账本覆盖', en: 'Ledger coverage' },
      counts: {
        zh: '{observations} 条观察 · {reflections} 条反思',
        en: '{observations} observations · {reflections} reflections'
      },
      ofThreshold: { zh: '上限 {limit}', en: 'limit {limit}' },
      unread: { zh: '未读 {value}', en: '{value} unread' },
      pool: { zh: '活跃池 {value}', en: '{value} in pool' },
      context: { zh: '上下文 {value}', en: '{value} context' },
      hint: {
        zh: '占压缩阈值 {percent} · 点击查看下次观察、反思与压缩',
        en: '{percent} of the compaction threshold · click for the next observe, reflect and compact'
      },
      coverageHint: {
        zh: '覆盖不足时压缩会回退到原生总结器，而不是用不完整的记忆替换历史。',
        en: 'Below full coverage, compaction falls back to the shipped summarizer rather than replacing history with partial memory.'
      }
    }

    /** Flat dictionaries per built-in locale id (`zh` / `en`). */
    const DICTS = { zh: {}, en: {} }
    for (const [key, value] of Object.entries(T)) {
      DICTS.zh[key] = value.zh
      DICTS.en[key] = value.en
    }

    /** The client plugin context, captured so components can resolve services at call time. */
    let pluginCtx

    /**
     * Compact token counts using the same K/M form as the shipped meter.
     * @param value - token count.
     * @returns the compact reading.
     */
    function formatTokens(value) {
      if (!Number.isFinite(value)) return '—'
      if (value < 1000) return String(value)
      const scaled = (candidate) =>
        candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
      if (value < 1000000) return `${scaled(value / 1000)}K`
      return `${scaled(value / 1000000)}M`
    }

    /**
     * Read one usage snapshot from the Host half.
     *
     * This goes over the Host's HTTP route, not `host.call`. The `host` builtin
     * belongs to `cordis_run` dynamic plugins, whose Host half registers paired
     * handlers with `harness.handle(method, fn)`; a bundle declared through
     * `dsh.client` loads via `__ModuleLoader__.load` and has no such pairing, so
     * `ctx.get('host')` yields nothing. That is the same reason
     * `dsh-session-removal` uses a route rather than a Host Remote.
     * @param sessionId - the session to report on.
     * @returns the usage payload.
     */
    async function fetchUsage(sessionId) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER]: '1' },
        body: JSON.stringify({ action: 'usage', sessionId })
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload.result
    }

    /** One labelled meter: a name, its percentage, a bar, and the reading behind it. */
    function MeterRow(props) {
      const { label, percent, reading, tint } = props
      const width = percent === undefined ? 0 : Math.max(0, Math.min(100, percent))
      return h(
        'div',
        { className: 'omx_meter' },
        h('div', { className: 'omx_row' }, h('dt', null, label), h('dd', null, percent === undefined ? '—' : `${percent}%`)),
        h('div', { className: 'omx_bar' }, h('div', { className: `omx_segment ${tint}`, style: { width: `${width}%` } })),
        h('div', { className: 'omx_reading' }, reading)
      )
    }

    /**
     * The composer-dock meter. It renders in the same dock row as the shipped
     * context meter, so it borrows that meter's markup, geometry and tokens
     * rather than introducing a second visual language beside it.
     */
    function ObservationalMemoryMeter(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const sessionId = props?.sessionId ?? props?.session?.id
      const [usage, setUsage] = React.useState(undefined)
      const [failed, setFailed] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      /** Whether the pointer is over the trigger, so the hint can show. */
      const [hovered, setHovered] = React.useState(false)
      /** Viewport coordinates of the trigger, measured when the panel opens. */
      const [anchor, setAnchor] = React.useState(undefined)
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)

      React.useEffect(() => {
        if (typeof sessionId !== 'string') {
          setUsage(undefined)
          return undefined
        }
        let live = true
        const read = async () => {
          try {
            const next = await fetchUsage(sessionId)
            if (live) {
              setUsage(next)
              setFailed(false)
            }
          } catch {
            // A missing Host half (or an older one) must leave the composer
            // alone: fail quiet, and let the next poll recover.
            if (live) setFailed(true)
          }
        }
        void read()
        const timer = setInterval(read, POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [sessionId])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current?.contains?.(event.target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const percent = usage?.compact?.percent
      if (failed || usage === undefined || percent === undefined) return null

      const limit = usage.context?.thresholdTokens
      const reading = `${percent}%`

      return h(
        'div',
        { ref: rootRef, className: 'omx_root', style: { position: 'relative' } },
        h(
          'button',
          {
            type: 'button',
            ref: triggerRef,
            className: 'omx_trigger',
            onClick: () => {
              // Measure the trigger and place the panel in viewport coordinates.
              // `position: fixed` is what keeps the panel out of the composer's
              // clipping, and the shipped meter does the same; it just borrows a
              // primitives hook to do the measuring, which a workspace bundle
              // cannot import.
              const rect = triggerRef.current?.getBoundingClientRect?.()
              if (rect !== undefined && rect !== null) {
                const width = 264
                const margin = 12
                const room = typeof window === 'undefined' ? width : window.innerWidth
                setAnchor({
                  left: Math.max(margin, Math.min(rect.left, room - width - margin)),
                  bottom: (typeof window === 'undefined' ? 0 : window.innerHeight) - rect.top + 8
                })
              }
              setOpen((value) => !value)
            },
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            onFocus: () => setHovered(true),
            onBlur: () => setHovered(false),
            title: undefined,
            'aria-label': t('aria', { percent: reading }),
            'aria-haspopup': 'dialog',
            'aria-expanded': open
          },
          h(
            'svg',
            { viewBox: '0 0 14 14', width: '14', height: '14', 'aria-hidden': true },
            h('circle', { className: 'omx_track', cx: '7', cy: '7', r: RADIUS }),
            h('circle', {
              className: 'omx_fill',
              cx: '7',
              cy: '7',
              r: RADIUS,
              // The shipped form: a dash of the filled arc followed by a gap of
              // the whole circumference, rotated to start at twelve o'clock.
              // `strokeDashoffset` instead would draw the arc ending at twelve
              // rather than starting there — the same length, the opposite
              // direction.
              strokeDasharray: `${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`,
              transform: 'rotate(-90 7 7)'
            })
          ),
          // No class: the shipped trigger renders the reading in a bare span, so
          // it inherits the trigger's `label-tertiary`. `omx_percent` is the
          // panel header's brighter tone and does not belong here.
          h('span', null, reading)
        ),
        // Hidden while the panel is open: the panel already states everything
        // the hint would, and two floating layers over one trigger is noise.
        h(
          'div',
          { className: 'omx_hint', role: 'tooltip', 'data-show': hovered && !open ? 'true' : 'false' },
          t('hint', { percent: reading })
        ),
        open
          ? h(
              'div',
              {
                role: 'dialog',
                className: 'omx_panel',
                'aria-label': t('title'),
                style:
                  anchor === undefined
                    ? { position: 'fixed', visibility: 'hidden' }
                    : { position: 'fixed', left: anchor.left, bottom: anchor.bottom }
              },
              h(
                'div',
                { className: 'omx_header' },
                h('span', { className: 'omx_headline' }, t('title')),
                h('span', { className: 'omx_percent' }, reading),
                h(
                  'span',
                  { className: 'omx_figures' },
                  `~${formatTokens(usage.context?.usedTokens)} / ${formatTokens(limit)}`
                )
              ),
              h(MeterRow, {
                label: t('observe'),
                percent: usage.observe?.percent,
                tint: 'omx_colorObserve',
                reading: `${t('unread', { value: formatTokens(usage.observe?.pendingTokens) })} · ${t('ofThreshold', {
                  limit: formatTokens(usage.observe?.thresholdTokens)
                })}`
              }),
              h(MeterRow, {
                label: t('reflect'),
                percent: usage.reflect?.percent,
                tint: 'omx_colorReflect',
                reading: `${t('pool', { value: formatTokens(usage.reflect?.activeTokens) })} · ${t('ofThreshold', {
                  limit: formatTokens(usage.reflect?.thresholdTokens)
                })}`
              }),
              h(MeterRow, {
                label: t('compact'),
                percent: usage.compact?.percent,
                tint: 'omx_colorCompact',
                reading: `${t('context', { value: formatTokens(usage.context?.usedTokens) })} · ${t('ofThreshold', {
                  limit: formatTokens(limit)
                })}`
              }),
              h(
                'div',
                { className: 'omx_note' },
                h(
                  'div',
                  null,
                  `${t('coverage')} ${
                    usage.ledger?.coveragePercent === undefined ? '—' : `${usage.ledger.coveragePercent}%`
                  } · ${t('counts', {
                    observations: usage.ledger?.activeObservations ?? 0,
                    reflections: usage.ledger?.reflections ?? 0
                  })}`
                ),
                h('div', null, t('coverageHint'))
              )
            )
          : null
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        pluginCtx = ctx
        insertStyles(ctx)
        // A hot reload can re-enter `apply` while the previous registration is
        // still in place; a duplicate `(ns, locale)` throws and would take the
        // whole page boot with it.
        for (const [locale, dict] of [
          ['zh', DICTS.zh],
          ['en', DICTS.en]
        ]) {
          try {
            ctx.effect(() => ctx.locale.register(NS, locale, dict), `observational-memory: ${locale} strings`)
          } catch (error) {
            console.warn(`observational-memory: ${locale} strings already registered`, error)
          }
        }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'observational-memory', order: 400, locale: NS },
            ObservationalMemoryMeter
          )
        )
      }
    }
  }
})
