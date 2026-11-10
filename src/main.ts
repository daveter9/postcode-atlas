import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { VERSION } from './app/version';

// visible in the dev console; also available as window.postcoderadar.version
console.info(`%cPostcoderadar v${VERSION}`, 'font-weight:bold;color:#1f5fbf');
(window as unknown as { postcoderadar: { version: string } }).postcoderadar = { version: VERSION };

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
