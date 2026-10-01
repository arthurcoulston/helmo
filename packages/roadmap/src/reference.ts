import { localRecordRef as localCoreRef, qualifiedRecordRef } from '@helmo/core';
import { type Installation } from './install.js';
const config = { homeKey: 'ROADMAP_HOME', dbKey: 'ROADMAP_DB', defaultHome: '.helmo-roadmap', defaultDb: 'roadmap.db', derivedPrefix: 'dev.roadmap' as const, homePattern: /^\.helmo-roadmap([-_.]|$)/, stripPattern: /^\.?(helmo-roadmap|roadmap)(?=[-_.]|$)/, release: () => null };
export { qualifiedRecordRef };
export const localRecordRef = (ref: string, installation?: Installation) => localCoreRef(ref, installation, config, 'R-4');
