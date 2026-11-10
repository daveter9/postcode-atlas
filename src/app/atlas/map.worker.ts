/// <reference lib="webworker" />
import { createRenderer } from './renderer';
import type { ToRenderer } from './protocol';

const handle = createRenderer((m) => postMessage(m));
addEventListener('message', (e: MessageEvent<ToRenderer>) => handle(e.data));
