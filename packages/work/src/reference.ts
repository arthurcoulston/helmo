import { localRecordRef as localCoreRef, qualifiedRecordRef } from '@helmo/core';
import { type Installation } from './install.js';
const config = { homeKey: 'HELMO_HOME', dbKey: 'HELMO_DB', defaultHome: '.helmo', defaultDb: 'helmo.db', derivedPrefix: 'dev.helmo' as const, homePattern: /^\.helmo([-_.]|$)/, stripPattern: /^\.?helmo(?=[-_.]|$)/, release: () => null };
export { qualifiedRecordRef };
export const localRecordRef = (ref: string, installation?: Installation) => localCoreRef(ref, installation, config, 'H-42');
