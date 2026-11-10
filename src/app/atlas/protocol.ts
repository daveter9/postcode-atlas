import type { AtlasMeta, Pc6Meta } from './atlas-data';

export interface Theme {
  bg: string;
  land: string;
  border: string;
  ink: string;
  halo: string;
  text: string;
  muted: string;
  font: string;
  palette: string[];
}

export type ToRenderer =
  | {
      t: 'init';
      canvas: OffscreenCanvas | HTMLCanvasElement;
      w: number;
      h: number;
      dpr: number;
      theme: Theme;
      reduceMotion: boolean;
      code: string;
      pc6Dir: string;
    }
  | { t: 'data'; buf: ArrayBuffer }
  | { t: 'resize'; w: number; h: number; dpr: number }
  /** CSS pixels at the top/bottom of the map covered by other UI */
  | { t: 'insets'; top: number; bottom: number }
  | { t: 'theme'; theme: Theme }
  | { t: 'code'; code: string }
  | { t: 'hover'; x: number; y: number }
  | { t: 'pick'; x: number; y: number };

export type FromRenderer =
  | { t: 'ready'; meta: AtlasMeta }
  /** meta = null: this PC4 has no 6-character postcodes with an area */
  | { t: 'pc6'; pc4: string; meta: Pc6Meta | null }
  /** full code under the pointer ('' = nothing) */
  | { t: 'pick'; code: string }
  | { t: 'error'; message: string };
