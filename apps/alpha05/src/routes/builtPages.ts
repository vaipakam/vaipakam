import { lazy, type ComponentType } from 'react';
import { BorrowPage } from '../pages/borrow/BorrowPage';
import { ClaimsPage } from '../pages/claims/ClaimsPage';
import { HomePage } from '../pages/home/HomePage';
import { LendPage } from '../pages/lend/LendPage';
import { PositionPage } from '../pages/position/PositionPage';
import { PositionsPage } from '../pages/positions/PositionsPage';
import { VaultPage } from '../pages/vault/VaultPage';

/** The governance page decodes calls against the Diamond's whole ABI, which
 *  no other page needs, so it loads with the route instead of with the app. */
const GovernancePage = lazy(() => import('../pages/governance/GovernancePage').then((m) => ({ default: m.GovernancePage })));

/** The page each BUILT route renders, by page-map path. A route not listed
 *  keeps its honest placeholder; `pageMap.test.ts` holds this map and the
 *  page map's `built` flags to one another. */
export const BUILT_PAGES: Readonly<Record<string, ComponentType>> = {
  '/': HomePage,
  '/borrow': BorrowPage,
  '/lend': LendPage,
  '/positions': PositionsPage,
  '/governance': GovernancePage,
  '/positions/:id': PositionPage,
  '/claims': ClaimsPage,
  '/vault': VaultPage,
};
