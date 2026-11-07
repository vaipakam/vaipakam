import type { ComponentType } from 'react';
import { BorrowPage } from '../pages/borrow/BorrowPage';
import { HomePage } from '../pages/home/HomePage';
import { LendPage } from '../pages/lend/LendPage';
import { PositionPage } from '../pages/position/PositionPage';
import { PositionsPage } from '../pages/positions/PositionsPage';

/** The page each BUILT route renders, by page-map path. A route not listed
 *  keeps its honest placeholder; `pageMap.test.ts` holds this map and the
 *  page map's `built` flags to one another. */
export const BUILT_PAGES: Readonly<Record<string, ComponentType>> = {
  '/': HomePage,
  '/borrow': BorrowPage,
  '/lend': LendPage,
  '/positions': PositionsPage,
  '/positions/:id': PositionPage,
};
