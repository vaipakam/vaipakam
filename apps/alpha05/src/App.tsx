import { Route, Routes } from 'react-router-dom';
import { Shell } from './app/Shell';
import { NotBuilt, NotFound } from './routes/NotBuilt';
import { PAGES } from './routes/pageMap';

/**
 * Every route of the page map exists from day one (rulebook §4). A page
 * renders its honest placeholder until its PR replaces the element here;
 * nothing else about the route changes, so bookmarks and the guide's deep
 * links are stable from the first deploy.
 */
export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        {PAGES.map((page) => (
          <Route key={page.path} path={page.path} element={<NotBuilt page={page} />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
