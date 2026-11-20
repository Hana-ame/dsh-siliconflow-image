/**
 * dsh-siliconflow-image — browser half.
 *
 * Adds one collapsible "image parameters" bar above the composer, matching the
 * SiliconFlow playground's four fillable fields:
 *
 *   Image Size        ratio buttons, only the sizes the selected model accepts
 *   Inference Steps   slider + number, capped by the model's own maximum
 *   Seed              number + randomize button
 *   Negative Prompt   textarea
 *
 * The bar appears only while the composer's selected provider is this plugin's
 * `siliconflow-image` route, and it reads the *same* catalog facts the adapter
 * gates on (fetched from the Host admin route), so the form can never offer a
 * size or step count the provider would reject.
 *
 * Values are per session and persist through the Host route
 * (`/api/siliconflow-image/params`), so a restart or a reload keeps them, and
 * the adapter/tool apply them to the next generation.
 *
 * Hand-written ModuleLoader bundle: React comes from the shell, no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-siliconflow-image',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const NS = 'siliconflowImageParams'
    const API = '/api/siliconflow-image/params'
    const SLOT = 'conversation.input.dock'
    const ROUTE = 'siliconflow-image'
    /** Stable identity for "no directory yet" so useSyncExternalStore does not loop. */
    const EMPTY_DIRECTORY_STATE = Object.freeze({ status: 'idle', current: null, groups: [], pending: false })
    const inject = ['slots', 'locale', 'sessions', 'modelDirectories']

    const DICT = {
      zh: {
        bar: '图像参数',
        barAria: '展开或收起图像生成参数',
        size: '图片尺寸',
        steps: '推理步数',
        seed: '随机种子',
        negative: '负面提示词',
        negativePlaceholder: '不希望出现的内容，例如：文字、水印、模糊',
        randomize: '随机',
        randomizeAria: '随机生成一个种子',
        reset: '恢复默认',
        editing: '编辑参数',
        editAria: '编辑图像生成参数',
        saving: '保存中…',
        saved: '已保存',
        loadFailed: '读取图像参数失败',
        saveFailed: '保存图像参数失败',
        editModelHint: '编辑模型不接受图片尺寸；参考图在消息里附带。',
        seedHint: '0 – 9999999999；留空表示随机。',
        seedRandom: '随机',
        stepsHint: '上限 {max} 步',
        summaryEmpty: '默认',
        hint: '这些参数只影响「SiliconFlow 生图」模型与 generate_image 工具的下一次生成。',
      },
      en: {
        bar: 'Image parameters',
        barAria: 'Expand or collapse image generation parameters',
        size: 'Image Size',
        steps: 'Inference Steps',
        seed: 'Seed',
        negative: 'Negative Prompt',
        negativePlaceholder: 'What should not appear, e.g. text, watermark, blurry',
        randomize: 'Random',
        randomizeAria: 'Generate a random seed',
        reset: 'Reset to defaults',
        editing: 'Editing parameters',
        editAria: 'Edit image generation parameters',
        saving: 'Saving…',
        saved: 'Saved',
        loadFailed: 'Could not load the image parameters',
        saveFailed: 'Could not save the image parameters',
        editModelHint: 'Edit models do not accept a size; attach reference images in your message.',
        seedHint: '0 – 9999999999; leave empty for random.',
        seedRandom: 'random',
        stepsHint: 'up to {max} steps',
        summaryEmpty: 'default',
        hint: 'These apply to the next generation by a SiliconFlow image model or the generate_image tool.',
      },
    }

    /* ── styles ───────────────────────────────────────────────────── */
    function ensureStyles() {
      const id = 'dsh-siliconflow-image/params.css'
      if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-siliconflow-image'
      tag.dataset.pluginCss = id
      tag.textContent = `
/* The dock slot is display:contents over the composer STACK, which is the card
   PLUS its horizontal padding, so a full-width row pokes out past the card it
   labels (the reported "歪的"). The component measures that padding and
   publishes --sfi-inset; the 16px fallback only covers the first paint. */
.sfi-wrap{display:flex;flex-direction:column;gap:8px;width:100%;padding:0 var(--sfi-inset,16px);box-sizing:border-box;}
.sfi-bar{display:flex;align-items:center;gap:8px;min-height:28px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}
.sfi-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;}
.sfi-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);}
.sfi-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);}
.sfi-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-accent,#6e29f6);flex:none;}
.sfi-label{font-weight:500;}
.sfi-sum{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.sfi-chev{display:inline-block;transition:transform .15s ease;transform:rotate(-90deg);}
.sfi-trigger[aria-expanded="true"] .sfi-chev{transform:rotate(0deg);}
.sfi-status{color:var(--dsw-alias-label-tertiary);font-size:12px;}
.sfi-status.err{color:var(--dsw-alias-label-danger,#e5484d);}
.sfi-panel{display:flex;flex-direction:column;gap:14px;padding:14px 16px;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-module-platform);}
.sfi-row{display:flex;flex-direction:column;gap:6px;}
.sfi-rowHead{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.sfi-rowTitle{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);}
.sfi-rowHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.sfi-sizes{display:flex;gap:6px;width:100%;}
/* Equal flex columns: the playground's radio group is flex-1 per size, so the
   row has no trailing gap and every ratio gets the same target width. */
.sfi-size{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:6px 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;}
.sfi-size:hover{border-color:var(--dsw-alias-label-accent,#6e29f6);}
.sfi-size .sfi-ratio{font-weight:600;font-size:13px;}
.sfi-size .sfi-px{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);}
.sfi-size[aria-pressed="true"]{border-color:var(--dsw-alias-label-accent,#6e29f6);background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-primary);}
.sfi-flex{display:flex;align-items:center;gap:10px;width:100%;}
.sfi-range{flex:1;accent-color:var(--dsw-alias-label-accent,#6e29f6);}
.sfi-num{box-sizing:border-box;width:88px;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;}
/* A seed is free-form and long, so its input takes the row's remaining width
   with the randomize control attached at the far right (playground parity). */
.sfi-num.sfi-grow{flex:1 1 auto;width:auto;min-width:0;}
.sfi-growwrap{display:flex;align-items:center;gap:6px;width:100%;}
.sfi-num:focus{outline:none;border-color:var(--dsw-alias-label-accent,#6e29f6);}
.sfi-btn{box-sizing:border-box;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;}
.sfi-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.sfi-textarea{width:100%;box-sizing:border-box;min-height:60px;resize:vertical;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;}
.sfi-textarea:focus{outline:none;border-color:var(--dsw-alias-label-accent,#6e29f6);}
.sfi-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;}
.sfi-hint{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
/* The footer action must not inherit the row's flex-grow wrapper: pin it right. */
.sfi-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;}
`
      document.head.appendChild(tag)
    }

    /* ── derivations ──────────────────────────────────────────────── */
    function ratioOf(size) {
      const m = /^(\d{2,4})x(\d{2,4})$/.exec(size ?? '')
      if (m === null) return ''
      const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))
      const w = Number(m[1])
      const h = Number(m[2])
      const d = gcd(w, h) || 1
      return `${w / d}:${h / d}`
    }

    function randomSeed() {
      return Math.floor(Math.random() * 1_000_000_0000)
    }

    /**
     * One parameter bar. Collapsed by default: it shows the current summary and
     * expands into the four-field form, so a normal text conversation keeps the
     * composer compact.
     * @param {object} props - slot props (session, injected catalog face, t).
     * @returns {object} React element.
     */
    function ParamsBar(props) {
      const t = props.t
      const sessionId = props.session?.sessionId ?? props.injected?.sessionId
      // `defaultOpen` is a test/reuse seam: the panel is collapsed by default so
      // a normal text conversation keeps its composer compact.
      const [open, setOpen] = React.useState(props.defaultOpen === true)
      const [catalog, setCatalog] = React.useState(null)
      const [params, setParams] = React.useState({})
      const [draft, setDraft] = React.useState({})
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const dirtyRef = React.useRef(false)

      React.useEffect(() => {
        ensureStyles()
      }, [])

      // Publish the composer card's horizontal inset so our padding matches it.
      // The dock slot is full-width over the composer STACK; the visible card is
      // that stack minus its padding, so we borrow the same value instead of
      // guessing. Re-measured on resize because the shell's layout is fluid.
      const wrapRef = React.useRef(null)
      React.useEffect(() => {
        /**
         * Line our content up with the visible composer card.
         *
         * The dock entry sits inside `[data-slot="conversation.input.dock"]`,
         * which is `display:contents` and therefore has NO box — walking to
         * `parentElement` yields rect [0,0] and a bogus measurement. Climb to
         * the first ancestor that actually occupies space, then use the editor's
         * left edge inside it: the gap is precisely the card's horizontal
         * padding.
         */
        const measure = () => {
          const wrap = wrapRef.current
          if (!wrap) return
          const editor = document.querySelector('[data-composer-input]')
          if (!editor) return
          let host = wrap.parentElement
          while (host !== null && host !== document.body) {
            const box = host.getBoundingClientRect()
            if (box.width > 0 && box.height > 0) break
            host = host.parentElement
          }
          if (host === null || host === document.body) return
          const inset = Math.round(editor.getBoundingClientRect().left - host.getBoundingClientRect().left)
          // 0..40px is the plausible range for a composer card's side padding;
          // anything else means the layout is mid-transition and we keep the
          // stylesheet default.
          if (Number.isFinite(inset) && inset >= 0 && inset <= 40) {
            wrap.style.setProperty('--sfi-inset', `${inset}px`)
          }
        }
        measure()
        if (typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(measure)
        // Observe both the wrapper and the card, so a panel resize or a
        // workspace switch both re-measure.
        if (wrapRef.current) observer.observe(wrapRef.current)
        const editor = document.querySelector('[data-composer-input]')
        const card = editor?.closest('[class]')
        if (card) observer.observe(card)
        window.addEventListener('resize', measure)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [])

      // The selected composer model decides whether this bar applies and which
      // constraints are in force; subscribe so a model switch re-renders the
      // form (and its sizes/step cap) immediately.
      const directory = props.directory
      const state = React.useSyncExternalStore(
        React.useCallback((notify) => (directory === undefined ? () => {} : directory.subscribe(notify)), [directory]),
        () => (directory === undefined ? EMPTY_DIRECTORY_STATE : directory.getSnapshot()),
        () => EMPTY_DIRECTORY_STATE,
      )
      const current = state.current ?? null
      const isImageRoute = current?.provider === ROUTE

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        props.loadDirectory?.()
      }, [sessionId, props.loadDirectory])

      React.useEffect(() => {
        if (!isImageRoute) return undefined
        let alive = true
        const model = current.model
        const url = `${API}?sessionId=${encodeURIComponent(sessionId)}&model=${encodeURIComponent(model)}`
        fetch(url, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
            return payload
          })
          .then((payload) => {
            if (!alive) return
            setCatalog(payload)
            setParams(payload.params ?? {})
            setDraft(payload.params ?? {})
            setError('')
          })
          .catch((loadError) => {
            if (!alive) return
            setError(`${t('loadFailed')}: ${String(loadError?.message ?? loadError)}`)
          })
        return () => {
          alive = false
        }
      }, [isImageRoute, sessionId, current?.model])

      if (!isImageRoute) return null

      const model = catalog?.models?.find((entry) => entry.id === current.model) ?? null
      const sizes = model?.sizes ?? []
      const maxSteps = model?.maxSteps ?? 50
      const defaultSteps = model?.defaultSteps
      const kind = model?.kind ?? 'generate'

      /** Persist one change (skipping transient empty values). */
      const save = (next) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        setBusy(true)
        setError('')
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, model: current.model, params: next }),
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
            setParams(payload.params ?? {})
            setStatus(t('saved'))
            window.setTimeout(() => setStatus(null), 1600)
          })
          .catch((saveError) => setError(`${t('saveFailed')}: ${String(saveError?.message ?? saveError)}`))
          .finally(() => setBusy(false))
      }

      /** Apply a draft patch locally and persist it. */
      const commit = (patch) => {
        const next = { ...draft, ...patch }
        for (const key of Object.keys(next)) {
          if (next[key] === undefined || next[key] === null || next[key] === '') delete next[key]
        }
        setDraft(next)
        dirtyRef.current = true
        save(next)
      }

      // Effective values mirror what the next request will actually use, so the
      // form never reads "empty" while the adapter is about to send a default.
      const steps = Number.isInteger(draft.num_inference_steps)
        ? draft.num_inference_steps
        : (defaultSteps ?? Math.min(20, maxSteps))

      const summary = [
        params.image_size ? params.image_size : null,
        Number.isInteger(params.num_inference_steps) ? `${params.num_inference_steps} 步` : null,
        Number.isInteger(params.seed) ? `seed ${params.seed}` : null,
        params.negative_prompt ? '负面' : null,
      ].filter(Boolean)

      const rows = [
        h('div', { key: 'size', className: 'sfi-row' },
          h('div', { className: 'sfi-rowHead' },
            h('span', { className: 'sfi-rowTitle' }, t('size')),
          ),
          kind === 'edit'
            ? h('span', { className: 'sfi-rowHint' }, t('editModelHint'))
            : h('div', { className: 'sfi-sizes' },
                sizes.map((size) => h('button', {
                  key: size.value,
                  type: 'button',
                  className: 'sfi-size',
                  'aria-pressed': draft.image_size === size.value,
                  onClick: () => commit({ image_size: draft.image_size === size.value ? undefined : size.value }),
                },
                  h('span', { className: 'sfi-ratio' }, size.ratio),
                  h('span', { className: 'sfi-px' }, size.value),
                )),
              ),
        ),
        h('div', { key: 'steps', className: 'sfi-row' },
          h('div', { className: 'sfi-rowHead' },
            h('span', { className: 'sfi-rowTitle' }, t('steps')),
            h('span', { className: 'sfi-rowHint' }, t('stepsHint', { max: maxSteps })),
          ),
          h('div', { className: 'sfi-flex' },
            h('input', {
              type: 'range',
              className: 'sfi-range',
              min: 1,
              max: maxSteps,
              step: 1,
              // The playground always shows a concrete step count: the stored
              // value, else the model's own default, else the slider floor.
              value: steps,
              onChange: (event) => commit({ num_inference_steps: Number(event.target.value) }),
            }),
            h('input', {
              type: 'number',
              className: 'sfi-num',
              style: { flex: '0 0 88px' },
              min: 1,
              max: maxSteps,
              step: 1,
              value: steps,
              onChange: (event) => {
                const value = event.target.value === '' ? undefined : Number(event.target.value)
                commit({ num_inference_steps: Number.isInteger(value) && value >= 1 && value <= maxSteps ? value : undefined })
              },
            }),
          ),
        ),
        h('div', { key: 'seed', className: 'sfi-row' },
          h('div', { className: 'sfi-rowHead' },
            h('span', { className: 'sfi-rowTitle' }, t('seed')),
            h('span', { className: 'sfi-rowHint' }, t('seedHint')),
          ),
          h('div', { className: 'sfi-growwrap' },
            h('input', {
              type: 'number',
              className: 'sfi-num sfi-grow',
              min: 0,
              max: 9999999999,
              step: 1,
              value: Number.isInteger(draft.seed) ? draft.seed : '',
              placeholder: t('seedRandom'),
              onChange: (event) => {
                const value = event.target.value === '' ? undefined : Number(event.target.value)
                commit({ seed: Number.isInteger(value) && value >= 0 && value <= 9999999999 ? value : undefined })
              },
            }),
            h('button', {
              type: 'button',
              className: 'sfi-btn',
              'aria-label': t('randomizeAria'),
              onClick: () => commit({ seed: randomSeed() }),
            }, t('randomize')),
          ),
        ),
        h('div', { key: 'negative', className: 'sfi-row' },
          h('span', { className: 'sfi-rowTitle' }, t('negative')),
          h('textarea', {
            className: 'sfi-textarea',
            placeholder: t('negativePlaceholder'),
            value: typeof draft.negative_prompt === 'string' ? draft.negative_prompt : '',
            onChange: (event) => setDraft((previous) => ({ ...previous, negative_prompt: event.target.value })),
            onBlur: (event) => {
              const text = event.target.value.trim()
              commit({ negative_prompt: text.length === 0 ? undefined : text })
            },
          }),
        ),
      ]

      const foot = h('div', { key: 'footer', className: 'sfi-footer' },
        h('span', { className: 'sfi-hint' }, t('hint')),
        h('div', { className: 'sfi-actions' },
          h('button', {
            type: 'button',
            className: 'sfi-btn',
            disabled: busy,
            onClick: () => {
              setDraft({})
              save({})
            },
          }, t('reset')),
        ),
      )

      return h('div', { className: 'sfi-wrap', ref: wrapRef },
        h('div', { className: 'sfi-bar' },
          h('button', {
            type: 'button',
            className: 'sfi-trigger',
            'aria-expanded': open,
            'aria-label': t('barAria'),
            onClick: () => setOpen((value) => !value),
          },
            h('span', { className: 'sfi-dot', 'aria-hidden': true }),
            h('span', { className: 'sfi-label' }, t('bar')),
            h('span', { className: 'sfi-sum' }, summary.length === 0 ? t('summaryEmpty') : summary.join(' · ')),
            h('span', { className: 'sfi-chev', 'aria-hidden': true }, '▾'),
          ),
          busy ? h('span', { className: 'sfi-status' }, t('saving')) : null,
          status !== null ? h('span', { className: 'sfi-status' }, status) : null,
          error.length > 0 ? h('span', { className: 'sfi-status err' }, error) : null,
        ),
        open ? h('div', { className: 'sfi-panel' }, rows, foot) : null,
      )
    }

    /* ── registration ─────────────────────────────────────────────── */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'siliconflow-image: parameter dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.inject(['slots', 'modelDirectories'], (scope) => {
        const models = scope.modelDirectories
        const sessions = scope.sessions
        scope.slots.inject(SLOT, () => scope.slots.register({
          name: SLOT,
          id: 'siliconflow-image-params',
          order: 5,
          locale: NS,
          inject: (sessionId) => {
            const available = sessions.subagentAddress(sessionId) === void 0
            const directory = available ? models.directoryFor(sessionId) : undefined
            return {
              sessionId,
              available,
              directory: directory === undefined ? undefined : directory.store,
              loadDirectory: directory === undefined
                ? undefined
                : () => {
                    directory.load().catch(() => {})
                  },
            }
          },
        }, ParamsBar))
      })
    }

    exports.name = 'siliconflow-image'
    exports.apply = apply
    exports.inject = inject
    exports.ParamsBar = ParamsBar
    return module.exports
  },
})
