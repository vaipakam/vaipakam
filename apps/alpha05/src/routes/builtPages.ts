import type { ComponentType } from 'react';
import { HomePage } from '../pages/home/HomePage';

/** The page each BUILT route renders, by page-map path. A route not listed
 *  keeps its honest placeholder; `pageMap.test.ts` holds this map and the
 *  page map's `built` flags to one another. */
export const BUILT_PAGES: Readonly<Record<string, ComponentType>> = {
  '/': HomePage,
};
