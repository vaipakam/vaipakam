/**
 * In-shell not-found page — no blank screens on old links or typos
 * (audit finding F-20260702-005). Every unmatched route lands here
 * with a way back.
 */
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { copy } from '../content/copy';
import { EmptyState } from '../components/EmptyState';

export function NotFound() {
  return (
    <EmptyState
      icon={Compass}
      titleAs="h1"
      title={copy.notFound.title}
      body={copy.notFound.body}
      action={
        <Link to="/" className="btn btn-primary">
          {copy.notFound.backHome}
        </Link>
      }
    />
  );
}
