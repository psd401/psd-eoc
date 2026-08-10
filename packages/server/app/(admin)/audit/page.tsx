import { loadInitialAuditViewState } from './actions';
import { AuditView } from './audit-view';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AuditPage() {
  return <AuditView initialState={await loadInitialAuditViewState()} />;
}
