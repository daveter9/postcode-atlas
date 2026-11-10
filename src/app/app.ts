import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { AdrData, AtlasMeta, Pc6Meta, addressSummary, children, formatCode, group, group6, places } from './atlas/atlas-data';
import type { FromRenderer, Theme, ToRenderer } from './atlas/protocol';
import { ADR_DIR, DATA_FILE, PC6_DIR } from './data-file';

// Start downloading the data the moment the bundle is evaluated (the <link rel=preload> in
// index.html usually has it in flight already, this fetch then reuses that response).
const dataPromise: Promise<ArrayBuffer> = fetch(DATA_FILE, { priority: 'low' } as RequestInit).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.arrayBuffer();
});

const nf = new Intl.NumberFormat('nl-NL');
const CODE_RE = /^(\d{4}[A-Z]{0,2}|\d{0,3})$/;

/** "3512 ab" / "3512AB" / "3512-a" -> "3512AB"; letters only count after four digits. */
function normalize(raw: string): string {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const digits = /^\d{0,4}/.exec(s)![0];
  return digits.length === 4 ? digits + s.slice(4).replace(/[^A-Z]/g, '').slice(0, 2) : digits;
}

function initialCode(): string {
  const pc = normalize(new URLSearchParams(location.search).get('pc') ?? '');
  return CODE_RE.test(pc) ? pc : '';
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg: v('--map-bg'),
    land: v('--map-land'),
    border: v('--map-border'),
    ink: v('--map-ink'),
    halo: v('--map-halo'),
    text: v('--map-text'),
    muted: v('--map-muted'),
    font: v('--font'),
    palette: Array.from({ length: 10 }, (_, i) => v(`--c${i}`)),
  };
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
})
export class App {
  protected readonly fmt = (n: number) => nf.format(n);
  protected readonly formatCode = formatCode;

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('map');
  private readonly inputRef = viewChild.required<ElementRef<HTMLInputElement>>('pcInput');
  private readonly cardRef = viewChild<ElementRef<HTMLElement>>('card');

  protected readonly code = signal(initialCode());
  protected readonly meta = signal<AtlasMeta | null>(null);
  /** PC6 data per PC4 as it arrives (null = this PC4 has no 6-character postcodes) */
  private readonly pc6s = signal(new Map<string, Pc6Meta | null>());
  /** addresses per PC4 as they arrive */
  private readonly adrs = signal(new Map<string, AdrData | null>());

  /** streets with house number ranges of the 6-character postcode you are in */
  protected readonly addresses = computed(() => {
    const c = this.code();
    if (c.length !== 6) return null;
    const a = this.adrs().get(c.slice(0, 4));
    if (a === undefined) return { count: -1, streets: [] as string[] };
    return a ? addressSummary(a, c.slice(4)) : null;
  });
  protected readonly error = signal('');
  protected readonly rejected = signal('');
  protected readonly rejectN = signal(0);

  /** touchscreen: show our own keypad and keep the system keyboard away */
  protected readonly touch = matchMedia('(pointer: coarse)').matches;
  /** keypad keys: digits, after four digits letters; keys that lead to no postcode are disabled */
  protected readonly keypad = computed(() => {
    const c = this.code();
    const letters = c.length >= 4;
    const chars = letters ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '1234567890';
    return { letters, keys: [...chars].map((k) => ({ k, ok: c.length < 6 && this.isValid(c + k) })) };
  });

  protected readonly display = computed(() => formatCode(this.code()));

  /** undefined = not loaded yet, null = none */
  protected readonly m6 = computed(() => {
    const c = this.code();
    return c.length >= 4 ? this.pc6s().get(c.slice(0, 4)) : undefined;
  });

  protected readonly pc4 = computed(() => {
    const m = this.meta(), c = this.code();
    return m ? group(m, c.slice(0, 4)) : null;
  });

  protected readonly trail = computed(() => {
    const c = this.code();
    const out: string[] = [];
    for (let k = 1; k < c.length; k++) out.push(c.slice(0, k));
    return out;
  });

  protected readonly pc4Facts = computed(() => {
    const m = this.meta(), g = this.pc4();
    if (!m || !g || this.code().length < 4) return null;
    const i = g.lo;
    return { places: places(m, i), gem: m.strings[m.gem[i]], prov: m.strings[m.prov[i]], inw: m.inw[i] };
  });

  protected readonly pc6Facts = computed(() => {
    const m6 = this.m6(), c = this.code();
    if (!m6 || c.length !== 6) return null;
    const g = group6(m6, c.slice(4));
    if (!g) return null;
    const i = g.lo;
    const str = (k: number) => (k >= 0 ? m6.strings[k] : '');
    return {
      inw: m6.inw[i], won: m6.won[i], hh: m6.hh[i], woz: m6.woz[i], koop: m6.koop[i],
      buurt: str(m6.buurt[i]), wijk: str(m6.wijk[i]),
    };
  });

  protected readonly group6Stats = computed(() => {
    const m6 = this.m6(), c = this.code();
    if (!m6 || c.length !== 5) return null;
    return group6(m6, c.slice(4));
  });

  /** name next to the code in the heading: buurt once letters are typed, else the place */
  protected readonly subtitle = computed(() => {
    const f4 = this.pc4Facts(), f6 = this.pc6Facts(), g6 = this.group6Stats();
    const place = f4 ? f4.places[0] || f4.gem : '';
    return f6?.buurt || g6?.name || place;
  });

  protected readonly summary = computed(() => {
    const m = this.meta(), c = this.code(), g = this.pc4(), f4 = this.pc4Facts(), f6 = this.pc6Facts();
    if (!m) return 'Postcodegebieden laden…';
    const place = f4 ? f4.places[0] || f4.gem : '';
    if (f6) return `Postcode ${formatCode(c)} in ${[f6.buurt, place].filter(Boolean).join(', ')}: ${f6.inw > 0 ? nf.format(f6.inw) + ' inwoners' : 'inwoners onbekend'}.`;
    const g6 = this.group6Stats();
    if (g6) return `Postcodes ${formatCode(c)}: ${g6.hi - g6.lo} postcodes in ${[g6.name, place].filter(Boolean).join(', ')}.`;
    if (f4) return `Postcode ${c}: ${f4.places.join(', ') || f4.gem}, gemeente ${f4.gem}, ${f4.prov}.`;
    const gc = group(m, c);
    if (!gc) return '';
    return c
      ? `Postcodes die beginnen met ${c}: ${gc.hi - gc.lo} gebieden rond ${gc.name}.`
      : `Nederland: ${gc.hi - gc.lo} postcodegebieden in ${children(m, '').length} regio's.`;
  });

  private post: (m: ToRenderer, transfer?: Transferable[]) => void = () => {};
  private hoverQueued = false;
  private lastPointer = { x: 0, y: 0 };
  private randomPc4 = '';

  constructor() {
    const destroyRef = inject(DestroyRef);

    effect(() => {
      const c = this.code();
      this.post({ t: 'code', code: c });
      history.replaceState(null, '', c ? `?pc=${c}` : location.pathname);
    });

    effect(() => {
      const c = this.code(), g = this.pc4(), m = this.meta();
      const name = c.length >= 4 ? g?.name : m && c ? group(m, c)?.name : '';
      document.title = c && name ? `${formatCode(c)} ${name} · Postcoderadar` : 'Postcoderadar · Nederland cijfer voor cijfer';
    });

    // the info card lies on top of the map: tell the renderer to centre below it
    effect((onCleanup) => {
      const card = this.cardRef()?.nativeElement;
      if (!card) return;
      const ro = new ResizeObserver(() => this.post({ t: 'insets', top: card.offsetTop + card.offsetHeight, bottom: 0 }));
      ro.observe(card);
      onCleanup(() => ro.disconnect());
    });

    afterNextRender(() => {
      this.inputRef().nativeElement.focus({ preventScroll: true });
      void this.start(destroyRef);
    });
  }

  private async start(destroyRef: DestroyRef) {
    const canvas = this.canvasRef().nativeElement;
    const dark = matchMedia('(prefers-color-scheme: dark)');
    const onMsg = (m: FromRenderer) => this.onRendererMessage(m);

    // The first ResizeObserver callback delivers the canvas size after layout, so booting from
    // there needs no forced synchronous reflow (unlike getBoundingClientRect at this point).
    let booted: Promise<void> | null = null;
    const boot = async (w: number, h: number) => {
      const init = {
        t: 'init' as const,
        w,
        h,
        dpr: devicePixelRatio,
        theme: readTheme(),
        reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        code: this.code(),
        pc6Dir: PC6_DIR,
        adrDir: ADR_DIR,
      };
      if (typeof canvas.transferControlToOffscreen === 'function' && typeof Worker !== 'undefined') {
        const worker = new Worker(new URL('./atlas/map.worker', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<FromRenderer>) => onMsg(e.data);
        const off = canvas.transferControlToOffscreen();
        worker.postMessage({ ...init, canvas: off }, [off]);
        this.post = (m, transfer = []) => worker.postMessage(m, transfer);
        destroyRef.onDestroy(() => worker.terminate());
      } else {
        const { createRenderer } = await import('./atlas/renderer');
        const handle = createRenderer(onMsg);
        handle({ ...init, canvas });
        this.post = (m) => handle(m);
      }
    };
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (!booted) booted = boot(width, height);
      else this.post({ t: 'resize', w: width, h: height, dpr: devicePixelRatio });
    });
    ro.observe(canvas);
    const onTheme = () => this.post({ t: 'theme', theme: readTheme() });
    dark.addEventListener('change', onTheme);
    destroyRef.onDestroy(() => {
      ro.disconnect();
      dark.removeEventListener('change', onTheme);
    });

    try {
      const buf = await dataPromise;
      while (!booted) await new Promise((r) => requestAnimationFrame(r));
      await booted;
      this.post({ t: 'data', buf }, [buf]);
    } catch (e) {
      this.error.set(`De kaartdata kon niet worden geladen (${e}).`);
    }
  }

  private onRendererMessage(m: FromRenderer) {
    switch (m.t) {
      case 'ready':
        performance.mark('map-ready');
        this.meta.set(m.meta);
        this.code.set(this.validPrefix(this.code()));
        break;
      case 'pc6': {
        const map = new Map(this.pc6s());
        map.delete(m.pc4); // re-insert = most recent
        map.set(m.pc4, m.meta);
        while (map.size > 30) map.delete(map.keys().next().value!);
        this.pc6s.set(map);
        const c = this.code();
        if (c.length > 4 && c.startsWith(m.pc4)) this.code.set(this.validPrefix(c));
        if (this.randomPc4 === m.pc4) {
          this.randomPc4 = '';
          if (m.meta && this.code() === m.pc4) this.code.set(m.pc4 + m.meta.codes[Math.floor(Math.random() * m.meta.n)]);
        }
        break;
      }
      case 'adr': {
        const map = new Map(this.adrs());
        map.delete(m.pc4);
        map.set(m.pc4, m.data);
        while (map.size > 12) map.delete(map.keys().next().value!);
        this.adrs.set(map);
        break;
      }
      case 'error':
        this.error.set(`De kaartdata is ongeldig (${m.message}).`);
        break;
      case 'pick': {
        const hit = m.code, c = this.code(), n = c.length;
        if (!hit) return;
        let next: string;
        if (n < 4) next = hit.slice(0, n + 1);
        else if (n === 4) next = hit.length === 6 ? hit.slice(0, 5) : hit;
        else if (n === 5) next = hit.length === 6 && !hit.startsWith(c) ? hit.slice(0, 5) : hit;
        else next = hit;
        this.setCode(next);
        break;
      }
    }
  }

  // ---------- input ----------
  /** Is every character of `c` an existing (partial) postcode? Unknown letters count as valid until loaded. */
  private isValid(c: string): boolean {
    const m = this.meta();
    if (!m || !c) return true;
    if (!group(m, c.slice(0, 4))) return false;
    if (c.length <= 4) return true;
    const m6 = this.pc6s().get(c.slice(0, 4));
    if (m6 === undefined) return true;
    return !!m6 && !!group6(m6, c.slice(4));
  }

  private validPrefix(c: string): string {
    while (c && !this.isValid(c)) c = c.slice(0, -1);
    return c;
  }

  protected setCode(c: string) {
    this.code.set(c);
    this.rejected.set('');
    const el = this.inputRef().nativeElement;
    el.value = formatCode(c);
  }

  private reject(attempt: string) {
    this.rejected.set(formatCode(attempt));
    this.rejectN.update((n) => n + 1);
  }

  protected onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const raw = el.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
    const valid = this.validPrefix(normalize(raw));
    if (valid !== raw) this.reject(raw);
    else this.rejected.set('');
    this.code.set(valid);
    const shown = formatCode(valid);
    if (el.value !== shown) el.value = shown;
  }

  /** keypad: a character, or '' to erase the last one */
  protected press(k: string) {
    const c = this.code();
    if (!k) this.setCode(c.slice(0, -1));
    else if (this.isValid(c + k)) this.setCode(c + k);
    else this.reject(c + k);
  }

  protected randomPostcode() {
    const m = this.meta();
    if (!m) return;
    const pc4 = String(m.pc[Math.floor(Math.random() * m.n)]);
    const m6 = this.pc6s().get(pc4);
    if (m6) this.setCode(pc4 + m6.codes[Math.floor(Math.random() * m6.n)]);
    else {
      this.randomPc4 = m6 === null ? '' : pc4;
      this.setCode(pc4);
    }
    this.inputRef().nativeElement.focus({ preventScroll: true });
  }

  protected onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const input = this.inputRef().nativeElement;
    if (e.key === 'Escape') {
      this.setCode('');
      return;
    }
    if (e.target === input) return; // the field handles its own typing
    const t = e.target as HTMLElement;
    if (/^[0-9a-zA-Z]$/.test(e.key) || e.key === 'Backspace') {
      if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
      // typing anywhere goes into the postcode field
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // ---------- map pointer ----------
  protected onPointerMove(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    this.lastPointer = { x: e.offsetX, y: e.offsetY };
    if (this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      this.post({ t: 'hover', ...this.lastPointer });
    });
  }

  protected onPointerLeave() {
    this.post({ t: 'hover', x: -1, y: -1 });
  }

  protected onMapClick(e: PointerEvent | MouseEvent) {
    this.post({ t: 'pick', x: e.offsetX, y: e.offsetY });
    if ((e as PointerEvent).pointerType === 'mouse') this.inputRef().nativeElement.focus({ preventScroll: true });
  }
}
